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
    use super::{contains_idr, is_decoder_seed, H264AccessUnitAssembler, H264Decoder};
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
