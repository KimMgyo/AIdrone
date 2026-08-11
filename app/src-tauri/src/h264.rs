//! Native Annex-B H.264 decoding for the vision worker.
//!
//! A decoder instance is intentionally single-owner: it can move to a worker
//! thread, but callers must serialize `decode_into` calls through its `&mut`
//! receiver.  It has no networking or Tello control dependency.

use std::sync::{Arc, LazyLock};

use ffmpeg::software::scaling::{context::Context as ScalingContext, flag::Flags as ScalingFlags};
use ffmpeg::util::{format::Pixel, frame::video::Video};
use ffmpeg_next as ffmpeg;

static FFMPEG_INIT: LazyLock<Result<(), String>> = LazyLock::new(|| {
    ffmpeg::init().map_err(|error| format!("failed to initialize FFmpeg: {error}"))
});

/// Decodes raw Annex-B H.264 access units and, when requested, exposes each
/// decoded frame as a tightly packed RGBA slice.
///
/// `rgba_scratch` is deliberately separate from FFmpeg's output frame. FFmpeg
/// aligns image rows for SIMD, while vision consumers require exactly
/// `width * height * 4` bytes with no row padding.
pub struct H264Decoder {
    decoder: ffmpeg::decoder::Video,
    decoded: Video,
    scaler: Option<ScalingContext>,
    rgba_frame: Video,
    rgba_scratch: Vec<u8>,
    waiting_for_keyframe: bool,
}

// FFmpeg decoder and swscale contexts may be moved between threads, but must
// only be used by one thread at a time. `decode_into` requires `&mut self`, so
// this type cannot be used concurrently without external synchronization.
unsafe impl Send for H264Decoder {}

impl H264Decoder {
    /// Creates a decoder with no stream-specific configuration. SPS/PPS carried
    /// in the Annex-B stream configure it when the first IDR access unit arrives.
    pub fn new() -> Result<Self, String> {
        initialize_ffmpeg()?;

        Ok(Self {
            decoder: Self::open_decoder()?,
            decoded: Video::empty(),
            scaler: None,
            rgba_frame: Video::empty(),
            rgba_scratch: Vec::new(),
            waiting_for_keyframe: true,
        })
    }

    /// Submits one complete Annex-B access unit to libavcodec.
    ///
    /// The input is always sent to the decoder, even while the stream is waiting
    /// for its first IDR frame and even when RGBA conversion is disabled.  In the
    /// latter case no scaler, contiguous copy, or callback is used.
    pub fn decode_into<F: FnMut(u32, u32, &[u8])>(
        &mut self,
        annex_b_access_unit: &[u8],
        convert_to_rgba: bool,
        mut on_frame: F,
    ) -> Result<(), String> {
        if annex_b_access_unit.is_empty() {
            return Err("cannot decode an empty H.264 access unit".to_owned());
        }

        let contains_idr = contains_idr(annex_b_access_unit);
        let packet = ffmpeg::Packet::borrow(annex_b_access_unit);

        // `send_packet` can legitimately report EAGAIN if a prior caller did
        // not drain all delayed frames. Drain and retry once before treating it
        // as a decoder failure.
        match self.decoder.send_packet(&packet) {
            Ok(()) => {}
            Err(error) if is_again(error) => {
                self.drain_decoded_frames(convert_to_rgba, &mut on_frame)?;
                if let Err(retry_error) = self.decoder.send_packet(&packet) {
                    return Err(self
                        .recoverable_decoder_error("resubmitting H.264 access unit", retry_error));
                }
            }
            Err(error) => {
                return Err(self.recoverable_decoder_error("submitting H.264 access unit", error));
            }
        }

        self.drain_decoded_frames(convert_to_rgba, &mut on_frame)?;

        if contains_idr {
            self.waiting_for_keyframe = false;
            return Ok(());
        }

        if self.waiting_for_keyframe {
            // A UDP client can attach halfway through a GOP. The H.264 decoder
            // has still consumed this packet; report why there is no dependable
            // frame and keep the instance ready to accept the next IDR.
            return Err(
                "H.264 decoder is waiting for an IDR keyframe after joining the stream mid-GOP"
                    .to_owned(),
            );
        }

        Ok(())
    }

    fn open_decoder() -> Result<ffmpeg::decoder::Video, String> {
        let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::H264)
            .ok_or_else(|| "FFmpeg does not provide an H.264 decoder".to_owned())?;
        let opened = ffmpeg::codec::context::Context::new_with_codec(codec)
            .decoder()
            .open_as(codec)
            .map_err(|error| format!("failed to open FFmpeg H.264 decoder: {error}"))?;

        opened
            .video()
            .map_err(|error| format!("FFmpeg H.264 decoder is not a video decoder: {error}"))
    }

    fn drain_decoded_frames<F: FnMut(u32, u32, &[u8])>(
        &mut self,
        convert_to_rgba: bool,
        on_frame: &mut F,
    ) -> Result<(), String> {
        loop {
            match self.decoder.receive_frame(&mut self.decoded) {
                Ok(()) => {
                    if convert_to_rgba {
                        self.emit_rgba(on_frame)?;
                    }
                }
                Err(error) if is_again(error) => return Ok(()),
                Err(ffmpeg::Error::Eof) => {
                    return Err(self.recoverable_decoder_error(
                        "receiving H.264 frame after unexpected end of stream",
                        ffmpeg::Error::Eof,
                    ));
                }
                Err(error) => {
                    return Err(self.recoverable_decoder_error("receiving H.264 frame", error));
                }
            }
        }
    }

    fn emit_rgba<F: FnMut(u32, u32, &[u8])>(&mut self, on_frame: &mut F) -> Result<(), String> {
        let width = self.decoded.width();
        let height = self.decoded.height();
        let source_format = self.decoded.format();
        let row_bytes = rgba_row_bytes(width)?;
        let output_len = row_bytes
            .checked_mul(height as usize)
            .ok_or_else(|| format!("RGBA frame size overflows for {width}x{height}"))?;

        if height == 0 || source_format == Pixel::None {
            return Err(format!(
                "FFmpeg produced a decoded frame with invalid format or dimensions ({source_format:?}, {width}x{height})"
            ));
        }

        self.ensure_scaler(source_format, width, height)?;
        let Some(scaler) = self.scaler.as_mut() else {
            return Err("RGBA scaler was not initialized".to_owned());
        };
        scaler
            .run(&self.decoded, &mut self.rgba_frame)
            .map_err(|error| format!("failed to convert decoded H.264 frame to RGBA: {error}"))?;

        // `Video::data` and `Video::stride` panic when FFmpeg failed to allocate
        // an output plane. Read the fields directly so that an allocation or
        // malformed-frame failure stays recoverable for the vision worker.
        let output = unsafe { &*self.rgba_frame.as_ptr() };
        if output.data[0].is_null() || output.linesize[0] <= 0 {
            return Err("FFmpeg did not allocate an RGBA output plane".to_owned());
        }

        let stride = output.linesize[0] as usize;
        if stride < row_bytes {
            return Err(format!(
                "FFmpeg RGBA output stride {stride} is smaller than row width {row_bytes}"
            ));
        }
        let output_storage_len = stride
            .checked_mul(height as usize)
            .ok_or_else(|| format!("FFmpeg RGBA output stride overflows for {width}x{height}"))?;
        let rgba_rows =
            unsafe { std::slice::from_raw_parts(output.data[0] as *const u8, output_storage_len) };

        self.ensure_rgba_scratch(output_len)?;
        {
            let scratch = &mut self.rgba_scratch;
            for (destination, source_row) in scratch
                .chunks_exact_mut(row_bytes)
                .zip(rgba_rows.chunks_exact(stride))
            {
                destination.copy_from_slice(&source_row[..row_bytes]);
            }
        }

        on_frame(width, height, &self.rgba_scratch);
        Ok(())
    }

    fn ensure_scaler(
        &mut self,
        source_format: Pixel,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let needs_rebuild = match self.scaler.as_ref() {
            Some(scaler) => {
                let input = scaler.input();
                input.format != source_format || input.width != width || input.height != height
            }
            None => true,
        };

        if needs_rebuild {
            let scaler = ScalingContext::get(
                source_format,
                width,
                height,
                Pixel::RGBA,
                width,
                height,
                ScalingFlags::BILINEAR,
            )
            .map_err(|error| {
                format!(
                    "failed to create RGBA scaler for decoded H.264 frame {width}x{height} ({source_format:?}): {error}"
                )
            })?;

            self.scaler = Some(scaler);
            // `ScalingContext::run` allocates an empty target exactly once. Drop
            // an incompatible old target when a resolution or pixel format
            // change requires a new scaler.
            self.rgba_frame = Video::empty();
        }

        Ok(())
    }

    fn ensure_rgba_scratch(&mut self, len: usize) -> Result<(), String> {
        if self.rgba_scratch.len() < len {
            self.rgba_scratch
                .try_reserve_exact(len - self.rgba_scratch.len())
                .map_err(|error| {
                    format!("failed to reserve {len} bytes for RGBA frame: {error}")
                })?;
        }
        self.rgba_scratch.resize(len, 0);
        Ok(())
    }

    fn recoverable_decoder_error(&mut self, stage: &str, error: ffmpeg::Error) -> String {
        let original = format!("FFmpeg failed while {stage}: {error}");

        // A broken or pre-keyframe packet must not leave the worker with a
        // decoder stuck in an indeterminate state. Reopening is cheap compared
        // with a video frame and lets the next IDR establish a clean state.
        self.waiting_for_keyframe = true;
        match Self::open_decoder() {
            Ok(decoder) => {
                self.decoder = decoder;
                self.decoded = Video::empty();
                format!("{original}; decoder reset, retry from the next IDR keyframe")
            }
            Err(reset_error) => format!("{original}; decoder reset failed: {reset_error}"),
        }
    }
}

fn initialize_ffmpeg() -> Result<(), String> {
    FFMPEG_INIT.clone()
}

fn is_again(error: ffmpeg::Error) -> bool {
    matches!(
        error,
        ffmpeg::Error::Other { errno } if errno == ffmpeg::error::EAGAIN
    )
}

fn rgba_row_bytes(width: u32) -> Result<usize, String> {
    if width == 0 {
        return Err("FFmpeg produced a decoded frame with zero width".to_owned());
    }

    (width as usize)
        .checked_mul(4)
        .ok_or_else(|| format!("RGBA row size overflows for width {width}"))
}

/// H.264 NAL-unit types that determine access-unit and decoder-bootstrap
/// boundaries. Tello emits one VCL NAL per picture.
const NAL_TYPE_SLICE_NON_IDR: u8 = 1;
const NAL_TYPE_SLICE_IDR: u8 = 5;
const NAL_TYPE_SPS: u8 = 7;
const NAL_TYPE_PPS: u8 = 8;

/// Returns the length of the Annex-B start code at `offset`.
fn start_code_len_at(bytes: &[u8], offset: usize) -> Option<usize> {
    if bytes.get(offset..offset + 4) == Some([0, 0, 0, 1].as_slice()) {
        Some(4)
    } else if bytes.get(offset..offset + 3) == Some([0, 0, 1].as_slice()) {
        Some(3)
    } else {
        None
    }
}

/// Finds the next Annex-B start code at or after `offset`.
fn find_start_code(bytes: &[u8], offset: usize) -> Option<(usize, usize)> {
    for index in offset..bytes.len().saturating_sub(2) {
        if let Some(prefix_len) = start_code_len_at(bytes, index) {
            return Some((index, prefix_len));
        }
    }
    None
}

/// Stateful byte-stream -> complete H.264 access-unit reassembler.
///
/// The Tello's UDP datagrams have no relationship to NAL boundaries. Retain a
/// partial trailing NAL until the next Annex-B start code proves its end, then
/// carry SPS/PPS/SEI/AUD prefix NALs with the next VCL picture. This mirrors the
/// browser's `H264Stream` contract and makes native decoding independent of
/// packet segmentation.
pub(crate) struct H264AccessUnitAssembler {
    pending: Vec<u8>,
    prefix_nals: Vec<(u8, Vec<u8>)>,
    decoder_seed: Option<Arc<Vec<u8>>>,
}

impl H264AccessUnitAssembler {
    pub(crate) fn new() -> Self {
        Self {
            pending: Vec::new(),
            prefix_nals: Vec::new(),
            decoder_seed: None,
        }
    }

    /// Ingests arbitrary Annex-B bytes and returns every complete access unit
    /// completed by this chunk when `emit` is true. Decoder bootstrap state is
    /// cached even while perception is disabled, without allocating complete
    /// non-seed access units.
    pub(crate) fn push(&mut self, chunk: &[u8], emit: bool) -> Vec<Arc<Vec<u8>>> {
        self.pending.extend_from_slice(chunk);
        let mut access_units = Vec::new();

        loop {
            let Some((first_start, _)) = find_start_code(&self.pending, 0) else {
                self.retain_possible_start_code_prefix();
                break;
            };
            if first_start > 0 {
                self.pending.drain(..first_start);
            }

            let first_prefix_len =
                start_code_len_at(&self.pending, 0).expect("start code was just located");
            let Some((next_start, _)) = find_start_code(&self.pending, first_prefix_len) else {
                break;
            };

            let Some(&header) = self.pending.get(first_prefix_len) else {
                self.pending.drain(..next_start);
                continue;
            };
            let nal_type = header & 0x1f;

            if !matches!(nal_type, NAL_TYPE_SLICE_NON_IDR | NAL_TYPE_SLICE_IDR) {
                let nal = self.pending[..next_start].to_vec();
                self.pending.drain(..next_start);
                self.prefix_nals.push((nal_type, nal));
                continue;
            }

            let is_decoder_seed = nal_type == NAL_TYPE_SLICE_IDR
                && self
                    .prefix_nals
                    .iter()
                    .any(|(kind, _)| *kind == NAL_TYPE_SPS)
                && self
                    .prefix_nals
                    .iter()
                    .any(|(kind, _)| *kind == NAL_TYPE_PPS);

            if emit || is_decoder_seed {
                let prefix_len = self
                    .prefix_nals
                    .iter()
                    .map(|(_, prefix)| prefix.len())
                    .sum::<usize>();
                let mut access_unit = Vec::with_capacity(prefix_len + next_start);
                for (_, prefix) in &self.prefix_nals {
                    access_unit.extend_from_slice(prefix);
                }
                access_unit.extend_from_slice(&self.pending[..next_start]);
                let access_unit = Arc::new(access_unit);

                if is_decoder_seed {
                    self.decoder_seed = Some(Arc::clone(&access_unit));
                }
                if emit {
                    access_units.push(access_unit);
                }
            }
            self.pending.drain(..next_start);
            self.prefix_nals.clear();
        }

        access_units
    }

    /// Returns the most recent complete SPS/PPS/IDR access unit, if one has
    /// arrived since UDP attachment.
    pub(crate) fn decoder_seed(&self) -> Option<Arc<Vec<u8>>> {
        self.decoder_seed.as_ref().map(Arc::clone)
    }

    /// With no full start code, only a suffix of at most three zero-prefixed
    /// bytes can combine with a future chunk to form one. Drop arbitrary
    /// mid-NAL garbage so a late UDP attachment cannot grow this buffer forever.
    fn retain_possible_start_code_prefix(&mut self) {
        let keep_from = self.pending.len().saturating_sub(3);
        self.pending.drain(..keep_from);
        while self.pending.first().is_some_and(|byte| *byte != 0) {
            self.pending.remove(0);
        }
    }
}

/// The three NAL kinds that establish an independently decodable H.264
/// access unit. Annex-B's emulation-prevention rule makes scanning start codes
/// sufficient and allocation-free.
#[derive(Default)]
struct NalKinds {
    idr: bool,
    sps: bool,
    pps: bool,
}

fn nal_kinds(annex_b: &[u8]) -> NalKinds {
    let mut kinds = NalKinds::default();
    let mut offset = 0;

    while let Some((start, start_code_len)) = find_start_code(annex_b, offset) {
        if let Some(&nal_header) = annex_b.get(start + start_code_len) {
            match nal_header & 0x1f {
                NAL_TYPE_SLICE_IDR => kinds.idr = true,
                NAL_TYPE_SPS => kinds.sps = true,
                NAL_TYPE_PPS => kinds.pps = true,
                _ => {}
            }
            if kinds.idr && kinds.sps && kinds.pps {
                break;
            }
        }
        offset = start + start_code_len;
    }

    kinds
}

/// Returns whether this Annex-B access unit carries an IDR NAL.
fn contains_idr(annex_b: &[u8]) -> bool {
    nal_kinds(annex_b).idr
}

// -----------------------------------------------------------------------------
// Low-delay SPS rewriting.
//
// The Tello's SPS carries no VUI. A decoder handed one has to assume the
// LEVEL's whole DPB may be reordered - at 960x720 level 4.0 that is
// min(32768 / 2700, 16) = 12 frames - and so it buffers twelve pictures before
// releasing the first. Measured end to end: 502 ms receive-to-paint on the real
// drone, and 209 ms against the simulator's `--strip-vui` mode, against ~10 ms
// once a VUI says the stream never reorders. Nothing in the WebCodecs config
// reaches this: `optimizeForLatency` is a hint Chromium's hardware path and
// WebKitGTK both ignore.
//
// The stream itself is the only place the answer belongs, so every SPS that
// declares no VUI gets one on the way out: `max_num_reorder_frames = 0`, which
// is the truth for a Tello (baseline-shaped, no B-frames, one slice per
// picture) and is what every decoder needs to emit each picture as it lands.
// -----------------------------------------------------------------------------

/// Profiles whose SPS carries the extra chroma/scaling-list block.
const HIGH_PROFILES: [u32; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

struct BitReader<'a> {
    rbsp: &'a [u8],
    at: usize,
}

impl<'a> BitReader<'a> {
    fn new(rbsp: &'a [u8]) -> Self {
        Self { rbsp, at: 0 }
    }

    fn position(&self) -> usize {
        self.at
    }

    fn u1(&mut self) -> Option<u32> {
        let byte = *self.rbsp.get(self.at / 8)?;
        let bit = (byte >> (7 - (self.at % 8))) & 1;
        self.at += 1;
        Some(u32::from(bit))
    }

    fn u(&mut self, count: u32) -> Option<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | self.u1()?;
        }
        Some(value)
    }

    /// Unsigned exp-Golomb. Bounded at 32 leading zeros so a corrupt NAL ends
    /// the walk instead of running off the buffer.
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.u1()? == 0 {
            zeros += 1;
            if zeros > 32 {
                return None;
            }
        }
        if zeros == 0 {
            return Some(0);
        }
        Some((1 << zeros) - 1 + self.u(zeros)?)
    }

    fn se(&mut self) -> Option<i32> {
        let k = self.ue()?;
        Some(if k % 2 == 0 {
            -((k / 2) as i32)
        } else {
            ((k + 1) / 2) as i32
        })
    }
}

#[derive(Default)]
struct BitWriter {
    rbsp: Vec<u8>,
    at: usize,
}

impl BitWriter {
    fn bit(&mut self, bit: u32) {
        if self.at % 8 == 0 {
            self.rbsp.push(0);
        }
        if bit != 0 {
            let index = self.at / 8;
            self.rbsp[index] |= 1 << (7 - (self.at % 8));
        }
        self.at += 1;
    }

    fn copy_bits(&mut self, source: &[u8], count: usize) {
        for index in 0..count {
            let byte = source[index / 8];
            self.bit(u32::from((byte >> (7 - (index % 8))) & 1));
        }
    }

    fn ue(&mut self, value: u32) {
        let coded = value + 1;
        let width = 32 - coded.leading_zeros();
        for _ in 0..width - 1 {
            self.bit(0);
        }
        for shift in (0..width).rev() {
            self.bit((coded >> shift) & 1);
        }
    }

    /// rbsp_trailing_bits: a stop bit, then zero padding to the byte boundary.
    fn finish(mut self) -> Vec<u8> {
        self.bit(1);
        while self.at % 8 != 0 {
            self.bit(0);
        }
        self.rbsp
    }
}

/// Drops emulation-prevention bytes: `00 00 03` -> `00 00`.
fn rbsp_from_nal(nal: &[u8]) -> Vec<u8> {
    let mut rbsp = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        rbsp.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    rbsp
}

/// Puts them back, so the result is a legal NAL payload again.
fn nal_from_rbsp(rbsp: &[u8]) -> Vec<u8> {
    let mut nal = Vec::with_capacity(rbsp.len() + 4);
    let mut zeros = 0;
    for &byte in rbsp {
        if zeros >= 2 && byte <= 3 {
            nal.push(3);
            zeros = 0;
        }
        nal.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    nal
}

/// Bit offset of `vui_parameters_present_flag` in an SPS RBSP, plus the
/// `max_num_ref_frames` the DPB floor needs. Field order is ITU-T H.264
/// 7.3.2.1.1; the walk stops at the flag because nothing after it is copied.
fn sps_vui_flag_offset(rbsp: &[u8]) -> Option<(usize, u32)> {
    let mut bits = BitReader::new(rbsp);
    bits.u(8)?; // NAL header
    let profile = bits.u(8)?;
    bits.u(8)?; // constraint_set flags + reserved
    bits.u(8)?; // level_idc
    bits.ue()?; // seq_parameter_set_id

    if HIGH_PROFILES.contains(&profile) {
        if bits.ue()? == 3 {
            bits.u1()?; // separate_colour_plane_flag
        }
        bits.ue()?; // bit_depth_luma_minus8
        bits.ue()?; // bit_depth_chroma_minus8
        bits.u1()?; // qpprime_y_zero_transform_bypass_flag
        if bits.u1()? == 1 {
            // Scaling lists would have to be walked element by element. No
            // Tello emits them, and guessing is worse than leaving the SPS
            // exactly as it arrived.
            return None;
        }
    }

    bits.ue()?; // log2_max_frame_num_minus4
    match bits.ue()? {
        0 => {
            bits.ue()?; // log2_max_pic_order_cnt_lsb_minus4
        }
        1 => {
            bits.u1()?; // delta_pic_order_always_zero_flag
            bits.se()?; // offset_for_non_ref_pic
            bits.se()?; // offset_for_top_to_bottom_field
            let cycle = bits.ue()?;
            for _ in 0..cycle {
                bits.se()?;
            }
        }
        _ => {}
    }

    let max_num_ref_frames = bits.ue()?;
    bits.u1()?; // gaps_in_frame_num_value_allowed_flag
    bits.ue()?; // pic_width_in_mbs_minus1
    bits.ue()?; // pic_height_in_map_units_minus1
    if bits.u1()? == 0 {
        bits.u1()?; // mb_adaptive_frame_field_flag
    }
    bits.u1()?; // direct_8x8_inference_flag
    if bits.u1()? == 1 {
        for _ in 0..4 {
            bits.ue()?; // frame_crop_*_offset
        }
    }

    Some((bits.position(), max_num_ref_frames))
}

/// Returns this SPS with a `max_num_reorder_frames = 0` VUI, or None when it
/// already declares a VUI (its author's own answer wins) or cannot be walked.
fn sps_with_low_delay_vui(nal: &[u8]) -> Option<Vec<u8>> {
    let rbsp = rbsp_from_nal(nal);
    let (vui_flag_at, max_num_ref_frames) = sps_vui_flag_offset(&rbsp)?;
    let mut bits = BitReader::new(&rbsp);
    bits.u(vui_flag_at as u32)?;
    if bits.u1()? == 1 {
        return None;
    }
    // Completeness check, and the reason a real drone is handled at all: the
    // Tello puts its SPS in a datagram of its own, so there is no following
    // start code to prove where the NAL ends. What proves it instead is the
    // SPS's own ending - `rbsp_trailing_bits`: the stop bit, then zeros to the
    // byte boundary, optionally followed by whole `trailing_zero_8bits`. A NAL
    // cut mid-flight cannot produce that, and is left alone.
    if bits.u1()? != 1 {
        return None;
    }
    while let Some(bit) = bits.u1() {
        if bit != 0 {
            return None;
        }
    }
    let mut out = BitWriter::default();
    out.copy_bits(&rbsp, vui_flag_at);
    out.bit(1); // vui_parameters_present_flag
    for _ in 0..8 {
        // aspect_ratio_info, overscan, video_signal_type, chroma_loc, timing,
        // nal_hrd, vcl_hrd, pic_struct - all absent.
        out.bit(0);
    }
    out.bit(1); // bitstream_restriction_flag
    out.bit(1); // motion_vectors_over_pic_boundaries_flag
    out.ue(0); // max_bytes_per_pic_denom - "no limit signalled"
    out.ue(0); // max_bits_per_mb_denom
    out.ue(16); // log2_max_mv_length_horizontal
    out.ue(16); // log2_max_mv_length_vertical
    out.ue(0); // max_num_reorder_frames - the entire point
    // The buffer still has to hold the reference frames the stream uses; only
    // the reordering delay is being removed.
    out.ue(max_num_ref_frames);

    Some(nal_from_rbsp(&out.finish()))
}

/// Rewrites every complete SPS in an Annex-B buffer to declare no reordering.
/// Returns None when nothing changed, so the common frame keeps its buffer.
pub(crate) fn with_low_delay_sps(annex_b: &[u8]) -> Option<Vec<u8>> {
    let mut out: Option<Vec<u8>> = None;
    let mut copied_to = 0;
    let mut offset = 0;

    while let Some((start, start_code_len)) = find_start_code(annex_b, offset) {
        let nal_at = start + start_code_len;
        offset = nal_at;
        let Some(&header) = annex_b.get(nal_at) else {
            break;
        };
        if header & 0x1f != NAL_TYPE_SPS {
            continue;
        }
        // A NAL the next start code closes is complete by construction; one
        // that ends the buffer is complete only if it ends in
        // rbsp_trailing_bits, which `sps_with_low_delay_vui` checks. The Tello
        // sends its SPS alone in a 13-byte datagram, so refusing that case
        // meant the rewrite never ran on the real drone.
        let next = find_start_code(annex_b, nal_at)
            .map(|(next, _)| next)
            .unwrap_or(annex_b.len());
        let Some(patched) = sps_with_low_delay_vui(&annex_b[nal_at..next]) else {
            continue;
        };

        let buffer = out.get_or_insert_with(|| Vec::with_capacity(annex_b.len() + 16));
        buffer.extend_from_slice(&annex_b[copied_to..nal_at]);
        buffer.extend_from_slice(&patched);
        copied_to = next;
    }

    if let Some(buffer) = out.as_mut() {
        buffer.extend_from_slice(&annex_b[copied_to..]);
    }
    out
}

#[cfg(test)]
/// Returns whether an access unit contains everything a new decoder needs:
/// SPS, PPS, and an IDR picture. This is a safe bootstrap for a detector
/// selected after video started flowing.
pub(crate) fn is_decoder_seed(annex_b: &[u8]) -> bool {
    let kinds = nal_kinds(annex_b);
    kinds.idr && kinds.sps && kinds.pps
}

#[cfg(test)]
mod tests {
    use super::{
        contains_idr, is_decoder_seed, sps_vui_flag_offset, with_low_delay_sps, BitReader,
        H264AccessUnitAssembler, H264Decoder,
    };
    use std::fs;
    use std::path::Path;

    /// The checked-in capture uses one VCL NAL per access unit. Group its SPS,
    /// PPS, and SEI prefix with the first IDR, then split each following VCL NAL
    /// so this test exercises the same API shape as the UDP reassembler.
    fn sample_access_units(bytes: &[u8]) -> Vec<&[u8]> {
        let starts = annex_b_start_codes(bytes);
        let Some(&(first_start, _)) = starts.first() else {
            return Vec::new();
        };
        let mut units = Vec::new();
        let mut unit_start = first_start;
        let mut saw_vcl = false;

        for &(start, prefix_len) in &starts {
            let nal_type = bytes.get(start + prefix_len).map(|header| header & 0x1f);
            if !matches!(nal_type, Some(1 | 5)) {
                continue;
            }

            if saw_vcl {
                units.push(&bytes[unit_start..start]);
                unit_start = start;
            } else {
                // Keep the leading SPS/PPS/SEI with this first IDR instead of
                // treating those parameter sets as a standalone access unit.
                saw_vcl = true;
            }
        }

        if saw_vcl {
            units.push(&bytes[unit_start..]);
        }

        units
    }

    fn annex_b_start_codes(bytes: &[u8]) -> Vec<(usize, usize)> {
        let mut starts = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            let prefix_len =
                if offset + 4 <= bytes.len() && bytes[offset..offset + 4] == [0, 0, 0, 1] {
                    4
                } else if offset + 3 <= bytes.len() && bytes[offset..offset + 3] == [0, 0, 1] {
                    3
                } else {
                    offset += 1;
                    continue;
                };
            starts.push((offset, prefix_len));
            offset += prefix_len;
        }
        starts
    }

    #[test]
    fn sample_access_units_decode_and_rgba_is_tightly_packed() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let units = sample_access_units(&bytes);
        assert!(units.len() > 2, "sample must contain multiple access units");
        assert!(
            contains_idr(units[0]),
            "sample must begin with an IDR access unit"
        );

        let mut decoder = H264Decoder::new().expect("FFmpeg H.264 decoder must initialize");
        let mut callbacks = 0usize;
        for access_unit in units.iter().take(4) {
            decoder
                .decode_into(access_unit, true, |width, height, rgba| {
                    callbacks += 1;
                    assert!(width > 0 && height > 0);
                    assert_eq!(rgba.len(), width as usize * height as usize * 4);
                })
                .expect("sample access unit must decode");
        }
        assert!(callbacks > 0, "sample must yield an RGBA frame");
    }

    /// A real SPS in the Tello's shape: the checked-in sample's own SPS with
    /// its VUI removed, which is exactly what `fake-tello.ts --strip-vui`
    /// produces and what the drone puts on the wire.
    const TELLO_SHAPED_SPS: [u8; 9] = [
        0x67, 0x42, 0xc0, 0x1f, 0xd9, 0x00, 0xf0, 0x16, 0xe4,
    ];

    /// Captured off a real Tello (2026-08-12, 192.168.4.2 over USB-NCM): Main
    /// profile, level 4.0, 960x720, `max_num_ref_frames = 1`, no VUI - and it
    /// arrives ALONE in a 13-byte datagram, followed by one trailing zero
    /// byte. Both properties are the test.
    const REAL_TELLO_SPS: [u8; 10] = [
        0x67, 0x4d, 0x40, 0x28, 0x95, 0xa0, 0x3c, 0x05, 0xb9, 0x00,
    ];

    #[test]
    fn the_drones_own_sps_is_rewritten_even_alone_in_its_datagram() {
        // Exactly what video.rs hands over: one short datagram, one NAL, no
        // following start code to prove where it ends.
        let mut datagram = vec![0, 0, 0, 1];
        datagram.extend_from_slice(&REAL_TELLO_SPS);

        let patched = with_low_delay_sps(&datagram).expect("the drone's SPS must be rewritten");
        let (reorder, dpb) = reorder_declaration(&patched[4..]);
        assert_eq!(reorder, 0, "the drone would otherwise buffer a 12-frame DPB");
        assert_eq!(dpb, 1, "this stream keeps exactly one reference frame");
    }

    #[test]
    fn a_half_arrived_sps_is_left_alone() {
        // The same NAL cut mid-flight: no rbsp_trailing_bits, so nothing here
        // can prove it is complete, and rewriting it would corrupt the stream.
        let mut truncated = vec![0, 0, 0, 1];
        truncated.extend_from_slice(&REAL_TELLO_SPS[..6]);
        assert!(with_low_delay_sps(&truncated).is_none());
    }

    /// Reads back the VUI this module writes and returns
    /// (max_num_reorder_frames, max_dec_frame_buffering).
    fn reorder_declaration(sps_nal: &[u8]) -> (u32, u32) {
        let rbsp = super::rbsp_from_nal(sps_nal);
        let (vui_at, _) = sps_vui_flag_offset(&rbsp).expect("patched SPS must still parse");
        let mut bits = BitReader::new(&rbsp);
        bits.u(vui_at as u32).unwrap();
        assert_eq!(bits.u1().unwrap(), 1, "VUI must be present");
        for _ in 0..8 {
            assert_eq!(bits.u1().unwrap(), 0, "no optional VUI block is written");
        }
        assert_eq!(bits.u1().unwrap(), 1, "bitstream_restriction must be set");
        bits.u1().unwrap(); // motion_vectors_over_pic_boundaries_flag
        bits.ue().unwrap(); // max_bytes_per_pic_denom
        bits.ue().unwrap(); // max_bits_per_mb_denom
        bits.ue().unwrap(); // log2_max_mv_length_horizontal
        bits.ue().unwrap(); // log2_max_mv_length_vertical
        (bits.ue().unwrap(), bits.ue().unwrap())
    }

    #[test]
    fn a_vui_less_sps_is_rewritten_to_declare_no_reordering() {
        let mut annex_b = vec![0, 0, 0, 1];
        annex_b.extend_from_slice(&TELLO_SHAPED_SPS);
        annex_b.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xcb, 0x8c, 0xb2]);

        let patched = with_low_delay_sps(&annex_b).expect("a VUI-less SPS must be rewritten");
        let sps_end = patched
            .windows(4)
            .position(|window| window == [0, 0, 0, 1])
            .and_then(|_| patched[4..].windows(4).position(|w| w == [0, 0, 0, 1]))
            .expect("the PPS start code must survive")
            + 4;
        let (reorder, dpb) = reorder_declaration(&patched[4..sps_end]);
        assert_eq!(reorder, 0, "the point of the rewrite");
        assert_eq!(dpb, 3, "the DPB still holds the stream's reference frames");
        assert_eq!(
            &patched[sps_end..],
            &[0, 0, 0, 1, 0x68, 0xcb, 0x8c, 0xb2],
            "every other NAL is copied byte for byte"
        );
    }

    #[test]
    fn an_sps_that_declares_its_own_vui_is_left_alone() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let units = sample_access_units(&bytes);
        // x264 writes max_num_reorder_frames itself, so there is nothing to say.
        assert!(
            with_low_delay_sps(units[0]).is_none(),
            "a stream that already declares its reordering must pass through untouched"
        );
    }

    #[test]
    fn a_rewritten_sps_still_decodes() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let units = sample_access_units(&bytes);

        // Put the drone's SPS shape in front of a real IDR, rewrite it, and
        // require FFmpeg to accept the result - a bit-level mistake here would
        // be a stream no decoder can start.
        let idr_at = annex_b_start_codes(units[0])
            .into_iter()
            .find(|&(start, prefix_len)| {
                units[0].get(start + prefix_len).map(|header| header & 0x1f) == Some(5)
            })
            .map(|(start, _)| start)
            .expect("the first access unit carries an IDR");
        let mut rebuilt = vec![0, 0, 0, 1];
        rebuilt.extend_from_slice(&TELLO_SHAPED_SPS);
        rebuilt.extend_from_slice(&[0, 0, 0, 1, 0x68, 0xcb, 0x8c, 0xb2]);
        rebuilt.extend_from_slice(&units[0][idr_at..]);

        let patched = with_low_delay_sps(&rebuilt).expect("the SPS must be rewritten");
        let mut decoder = H264Decoder::new().expect("FFmpeg H.264 decoder must initialize");
        let mut frames = 0usize;
        decoder
            .decode_into(&patched, true, |width, height, _| {
                frames += 1;
                assert_eq!((width, height), (960, 720));
            })
            .expect("a rewritten SPS must still configure the decoder");
        assert_eq!(frames, 1, "the IDR must come straight out - no reorder wait");
    }

    #[test]
    fn cached_idr_bootstraps_detector_enabled_after_stream_start() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let units = sample_access_units(&bytes);
        assert!(
            is_decoder_seed(units[0]),
            "the first access unit must carry the cached SPS/PPS/IDR bootstrap"
        );

        let mut decoder = H264Decoder::new().expect("FFmpeg H.264 decoder must initialize");
        decoder
            .decode_into(units[0], false, |_, _, _| {})
            .expect("cached decoder seed must configure a late-starting detector");

        let mut callbacks = 0usize;
        for access_unit in units.iter().skip(1).take(3) {
            decoder
                .decode_into(access_unit, true, |_, _, _| callbacks += 1)
                .expect("frames after a cached decoder seed must decode");
        }
        assert!(
            callbacks > 0,
            "a detector enabled after stream start must receive decoded pixels"
        );
    }

    #[test]
    fn assembler_reframes_fragmented_annex_b_and_caches_decoder_seed() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let mut assembler = H264AccessUnitAssembler::new();
        let mut units = Vec::new();

        // Deliberately split start codes and NAL payloads across arbitrary
        // chunks, as the Tello UDP stream does.
        for chunk in bytes.chunks(257) {
            units.extend(assembler.push(chunk, true));
        }

        assert!(units.len() > 2, "sample must reframe into several pictures");
        let seed = assembler
            .decoder_seed()
            .expect("first SPS/PPS/IDR picture must be retained");
        assert!(is_decoder_seed(&seed));
        assert!(is_decoder_seed(&units[0]));

        let mut decoder = H264Decoder::new().expect("FFmpeg H.264 decoder must initialize");
        decoder
            .decode_into(&seed, false, |_, _, _| {})
            .expect("cached decoder seed must configure a late-starting decoder");

        let mut callbacks = 0usize;
        for access_unit in units.iter().skip(1).take(3) {
            decoder
                .decode_into(access_unit, true, |_, _, _| callbacks += 1)
                .expect("reframed units after a cached seed must decode");
        }
        assert!(
            callbacks > 0,
            "a detector starting after stream attachment must receive pixels"
        );
    }

    #[test]
    fn disabled_conversion_still_decodes_without_invoking_callback() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let units = sample_access_units(&bytes);
        let mut decoder = H264Decoder::new().expect("FFmpeg H.264 decoder must initialize");
        let mut callbacks = 0usize;

        for access_unit in units.iter().take(4) {
            decoder
                .decode_into(access_unit, false, |_, _, _| callbacks += 1)
                .expect("sample access unit must decode");
        }

        assert_eq!(callbacks, 0);
    }

    #[test]
    fn mid_gop_access_unit_is_recoverable_before_a_later_idr() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sample.h264");
        let bytes = fs::read(&sample).expect("checked-in sample.h264 must be readable");
        let units = sample_access_units(&bytes);
        let mut decoder = H264Decoder::new().expect("FFmpeg H.264 decoder must initialize");

        let error = decoder
            .decode_into(units[1], false, |_, _, _| {})
            .expect_err("joining on an inter frame must report a recoverable keyframe wait");
        assert!(error.contains("IDR keyframe"));

        decoder
            .decode_into(units[0], false, |_, _, _| {})
            .expect("the decoder must recover when the next IDR arrives");
    }
}
