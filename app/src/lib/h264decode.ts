/**
 * Client-side WebCodecs H.264 decode pipeline for the local-track data
 * plane (see local-track-protocol.md). The ESP32 relays every UDP packet it
 * receives from the Tello's raw H.264 video port verbatim, one WS binary
 * frame per UDP packet -- these arrive chopped at arbitrary byte boundaries
 * relative to the underlying Annex-B NAL units (a single NAL can span
 * several WS frames; several NALs can land in one). Reassembling that into
 * decodable access units happens entirely here, client-side, exactly as
 * local-track-protocol.md specifies ("no reframing, no NAL parsing... on the
 * ESP32 side").
 *
 * Two independently testable layers, mirroring tracking.ts's
 * splitJpegFrames pure-function-with-pending-buffer shape:
 *  - splitAnnexBNals(): pure byte-stream -> NAL-unit splitter. No I/O, no
 *    WebCodecs -- unit-testable with hand-built Uint8Arrays.
 *  - H264Stream: stateful class wrapping splitAnnexBNals() with
 *    access-unit grouping, VideoDecoderConfig derivation from the stream's
 *    own SPS, and the actual VideoDecoder. Requires a real WebCodecs
 *    implementation (a browser), so this class itself is exercised via
 *    useLocalTrack in a real browser, not unit tests -- only the pure
 *    splitter above needs synthetic-byte-array coverage.
 */

// The WebCodecs "H.264 (AVC)" codec registration adds an `avc` config field
// (description/format for Annex-B vs. length-prefixed AVCC input) that this
// TypeScript version's bundled DOM lib doesn't yet include, even though
// real implementations (Chrome/Edge) have shipped it for years. Augmenting
// the global ambient interface here (rather than casting the config object
// at the call site) keeps the actual `decoder.configure(...)` call fully
// type-checked everywhere else.
declare global {
  interface VideoDecoderConfig {
    avc?: { format?: "annexb" | "avc" };
  }
}

/** One reassembled Annex-B NAL unit: start code stripped, NAL header byte
 * included as data[0]. `type` is the 5-bit nal_unit_type (data[0] & 0x1f). */
export interface AnnexBNal {
  type: number;
  data: Uint8Array;
}

function nalUnitType(headerByte: number): number {
  return headerByte & 0x1f;
}

/** True if `buf[at..]` starts with a 3-byte (00 00 01) or 4-byte (00 00 00
 * 01) Annex-B start code; returns the code's length (3 or 4), or 0 if none. */
function startCodeLengthAt(buf: Uint8Array, at: number): number {
  if (at + 3 > buf.length) return 0;
  if (buf[at] !== 0x00 || buf[at + 1] !== 0x00) return 0;
  if (buf[at + 2] === 0x01) return 3;
  if (buf[at + 2] === 0x00 && at + 4 <= buf.length && buf[at + 3] === 0x01) return 4;
  return 0;
}

/** Scans forward from `from` for the next Annex-B start code; returns its
 * byte offset, or -1 if none is found in `buf[from..]`. */
function indexOfStartCode(buf: Uint8Array, from: number): number {
  for (let i = from; i < buf.length - 2; i++) {
    if (startCodeLengthAt(buf, i) > 0) return i;
  }
  return -1;
}

/**
 * Incrementally splits a byte stream of concatenated Annex-B NAL units
 * (each `00 00 01` or `00 00 00 01` start code, no fixed length prefix)
 * into complete NAL units. Pure -- no I/O -- unit-testable with hand-built
 * buffers, mirroring splitJpegFrames in src/tracking.ts exactly: `pending`
 * is leftover bytes from a previous call (a partial trailing NAL, or a
 * partial start code that might complete once more bytes arrive); `chunk`
 * is the newly arrived bytes. Returns every complete NAL found (in arrival
 * order, start code stripped) plus the new `rest` to pass into the next
 * call.
 *
 * A NAL is only known to be COMPLETE once the START of the *next* NAL is
 * seen (Annex-B has no length prefix, so there is no other way to know a
 * NAL has ended) -- the last NAL in the buffer is therefore always held
 * back in `rest`, even if it looks complete, unless the caller has
 * indicated end-of-stream is unreachable here (this stream never ends, so
 * that case doesn't apply). Bytes before the first start code are dropped
 * silently (stream garbage / mid-NAL relay startup), matching
 * splitJpegFrames's treatment of bytes before the first SOI.
 */
export function splitAnnexBNals(pending: Uint8Array, chunk: Uint8Array): { nals: AnnexBNal[]; rest: Uint8Array } {
  let buf: Uint8Array;
  if (pending.length === 0) buf = chunk;
  else {
    buf = new Uint8Array(pending.length + chunk.length);
    buf.set(pending, 0);
    buf.set(chunk, pending.length);
  }

  const nals: AnnexBNal[] = [];
  let start = indexOfStartCode(buf, 0);
  if (start === -1) {
    // No complete start code anywhere yet. Keep only a tail that could still
    // be the beginning of one once more bytes arrive (at most 3 trailing
    // bytes matter: `00`, `00 00`, or `00 00 00`/`00 00 01`-in-progress).
    const keepFrom = Math.max(0, buf.length - 3);
    let rest = buf.subarray(keepFrom);
    // Trim any leading bytes in that tail that can no longer be a start
    // code prefix (a start code prefix is all zeros until its final 00/01).
    while (rest.length > 0 && rest[0] !== 0x00) rest = rest.subarray(1);
    return { nals, rest };
  }

  while (true) {
    const codeLen = startCodeLengthAt(buf, start);
    const nalBegin = start + codeLen;
    const next = indexOfStartCode(buf, nalBegin);
    if (next === -1) {
      // This NAL's end hasn't arrived yet -- hold everything from this
      // start code onward for the next call.
      return { nals, rest: buf.subarray(start) };
    }
    const nalBytes = buf.slice(nalBegin, next); // copy -- must outlive this buffer
    if (nalBytes.length > 0) nals.push({ type: nalUnitType(nalBytes[0]!), data: nalBytes });
    start = next;
  }
}

/** 4-byte Annex-B start code, used when re-framing NALs for the decoder. */
const START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

/** H.264 nal_unit_type values this module cares about (Rec. ITU-T H.264 §7.4.1). */
const NAL_TYPE_SLICE_NON_IDR = 1;
const NAL_TYPE_SLICE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

/**
 * Strips Annex-B emulation-prevention bytes (the `03` inserted after any
 * `00 00` run to keep start codes unambiguous, Rec. ITU-T H.264 §7.4.1.1)
 * from a NAL's payload, recovering the raw RBSP bytes. Only the first few
 * bytes matter for this module's use (reading profile_idc/level_idc out of
 * an SPS), but implemented generally rather than assuming those bytes
 * happen to avoid the escape sequence.
 */
function stripEmulationPrevention(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeroRun = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeroRun >= 2 && b === 0x03) {
      zeroRun = 0; // drop the emulation-prevention byte itself
      continue;
    }
    out[o++] = b;
    zeroRun = b === 0x00 ? zeroRun + 1 : 0;
  }
  return out.subarray(0, o);
}

/**
 * Derives a WebCodecs `avc1.PPCCLL` codec string from a raw SPS NAL
 * (start code stripped, header byte included as sps[0]). profile_idc,
 * constraint-flags, and level_idc are RBSP bytes 1-3 (immediately after the
 * 1-byte NAL header) -- de-escaped first since they're arbitrary values
 * that could theoretically collide with an emulation-prevention sequence.
 */
export function spsToCodecString(sps: Uint8Array): string {
  const rbsp = stripEmulationPrevention(sps);
  if (rbsp.length < 4) throw new Error(`SPS too short to read profile/level (${rbsp.length} bytes)`);
  const profileIdc = rbsp[1]!;
  const constraintFlags = rbsp[2]!;
  const levelIdc = rbsp[3]!;
  const hex = (b: number) => b.toString(16).padStart(2, "0");
  return `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`;
}

export interface H264StreamCallbacks {
  /** Called with every decoded frame, in decode order. The callback owns
   * the frame and MUST call frame.close() once done with it (drawing it to
   * a canvas, etc.) -- VideoFrame holds a native resource that isn't
   * released until closed. */
  onFrame: (frame: VideoFrame) => void;
  onError?: (e: Error) => void;
}

/**
 * Manages one live H.264 Annex-B decode session: reassembles NAL units from
 * arbitrarily-chunked input via splitAnnexBNals(), groups them into access
 * units (buffering non-slice NALs -- SPS/PPS/SEI/AUD -- until the next VCL
 * slice NAL, which always ends one access unit for the single-slice-per-
 * picture streams a Tello produces), configures a VideoDecoder from the
 * stream's own first SPS, and feeds it EncodedVideoChunks. Never throws out
 * of push()/close() -- catches and reports via onError, mirroring
 * TrackingSession's never-throw contract in src/tracking.ts.
 */
export class H264Stream {
  private readonly cb: H264StreamCallbacks;
  // Explicitly widened (bare `Uint8Array`, not inferred from the `new
  // Uint8Array(0)` initializer, which TS narrows to `Uint8Array<ArrayBuffer>`)
  // so it accepts splitAnnexBNals's returned `rest` below without a cast --
  // that return can be backed by a `.slice()`/`.subarray()` result, typed
  // `Uint8Array<ArrayBufferLike>`.
  private pending: Uint8Array = new Uint8Array(0);
  private prefixNals: AnnexBNal[] = [];
  private sps: Uint8Array | null = null;
  private decoder: VideoDecoder | null = null;
  /** The exact config the live decoder was built from, kept so a failure can
   *  be reported against what was actually asked for - `isConfigSupported`
   *  on this object separates "this WebView has no H.264 decoder" from "it
   *  has one and the stream broke it". Null until the first SPS arrives. */
  private lastConfig: VideoDecoderConfig | null = null;
  private nextTimestampUs = 0;
  /** Caller-supplied timestamp for the access unit(s) completed by the push
   * currently executing. Set so the decoded VideoFrame carries the caller's
   * own stamp back out on `frame.timestamp`, which is the only pairing that
   * survives a decoder that does not emit exactly one frame per push. */
  private chunkTimestampUs: number | undefined;
  /** Matches the Tello's ~30fps H.264 stream closely enough for decode
   * ordering -- WebCodecs timestamps only need to be monotonically
   * increasing for a live low-latency pipeline like this one, not
   * wall-clock-accurate (nothing here does A/V sync or seeking). */
  private static readonly FRAME_INTERVAL_US = 33_333;

  constructor(cb: H264StreamCallbacks) {
    this.cb = cb;
  }

  /** The configuration in force, for diagnostics only. */
  configuration(): VideoDecoderConfig | null {
    return this.lastConfig;
  }

  /** Feeds one newly arrived chunk of raw bytes (e.g. one WS binary frame's
   * payload). Safe to call at any chunking granularity.
   *
   * `timestampUs` labels the access units this chunk completes; it comes back
   * on `frame.timestamp`. Any monotonically increasing microsecond value
   * works - a receive-time epoch stamp turns that field into an exact
   * end-to-end latency reference. Omit it and the stream numbers frames
   * itself at a nominal interval. */
  push(chunk: Uint8Array, timestampUs?: number): void {
    try {
      this.chunkTimestampUs = timestampUs;
      const { nals, rest } = splitAnnexBNals(this.pending, chunk);
      this.pending = rest;
      for (const nal of nals) this.handleNal(nal);
    } catch (err) {
      this.reportError(err);
    } finally {
      this.chunkTimestampUs = undefined;
    }
  }

  private handleNal(nal: AnnexBNal): void {
    if (nal.type === NAL_TYPE_SPS) {
      this.sps = nal.data;
      this.prefixNals.push(nal);
      return;
    }
    if (nal.type === NAL_TYPE_PPS) {
      this.prefixNals.push(nal);
      return;
    }
    if (nal.type !== NAL_TYPE_SLICE_IDR && nal.type !== NAL_TYPE_SLICE_NON_IDR) {
      // SEI, AUD, etc. -- carried along with whatever access unit follows.
      this.prefixNals.push(nal);
      return;
    }

    // `nal` is a VCL slice -- it completes one access unit together with
    // any buffered SPS/PPS/SEI/AUD NALs seen since the last one.
    const isKeyframe = nal.type === NAL_TYPE_SLICE_IDR;
    const auNals = [...this.prefixNals, nal];
    this.prefixNals = [];

    if (this.decoder !== null && this.decoder.state === "closed") {
      // A `VideoDecoder` that has errored is closed for good. Without this the
      // guard below silently dropped every access unit from here on and the
      // picture froze for the rest of the session - one corrupt packet off the
      // real link was enough. Retire the corpse and rebuild at the next IDR.
      this.retireDecoder();
    }
    if (!this.decoder) {
      if (!this.sps || !isKeyframe) return; // can't configure or decode yet -- wait for the next keyframe
      this.configureDecoder(this.sps);
    }
    if (!this.decoder || this.decoder.state !== "configured") return;

    const data = concatWithStartCodes(auNals);
    const timestamp = this.chunkTimestampUs ?? this.nextTimestampUs;
    // WebCodecs only requires monotonicity, so a second access unit inside one
    // push (never seen from a Tello, which sends one picture per frame) just
    // takes the next microsecond rather than colliding.
    if (this.chunkTimestampUs !== undefined) this.chunkTimestampUs = timestamp + 1;
    this.nextTimestampUs = timestamp + H264Stream.FRAME_INTERVAL_US;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({ type: isKeyframe ? "key" : "delta", timestamp, data }),
      );
    } catch (err) {
      this.reportError(err);
      // `decode()` throwing means this decoder is unusable too.
      this.retireDecoder();
    }
  }

  private configureDecoder(sps: Uint8Array): void {
    try {
      const decoder = new VideoDecoder({
        output: (frame) => this.cb.onFrame(frame),
        error: (e) => this.reportError(e),
      });
      const config: VideoDecoderConfig = {
        codec: spsToCodecString(sps),
        // Live low-latency tracking, not a media player -- prioritize
        // getting frames out over throughput/quality tradeoffs a general
        // decoder config might otherwise make.
        optimizeForLatency: true,
        // Load-bearing, and the opposite of what it looks like. Chromium's
        // D3D11 hardware decoder IGNORES optimizeForLatency and applies the
        // spec's worst-case reorder rule instead: with no VUI
        // `max_num_reorder_frames`, it must assume every frame may be
        // reordered and so fills the whole DPB before emitting anything.
        //
        // The Tello declares level 4.0 (`avc1.4d4028`) for a 960x720 =
        // 2700-macroblock picture, so DPB = min(MaxDpbMbs / mbs, 16) =
        // min(32768 / 2700, 16) = 12 frames. Measured against a real drone:
        // exactly 12 frames resident in the decoder, decode() -> output()
        // 470 ms p50, and the releases arrive in bursts that overflow the
        // paint queue (37% of frames dropped, 15 shown fps against a 27 fps
        // link). Software decode honors the hint: 1 frame resident, 1.2 ms
        // p50, 0 dropped, 25 shown fps -- receive-to-paint 502 ms -> 3.5 ms.
        //
        // The cost is ~1.2 ms of CPU per frame at this one fixed resolution,
        // which is the cheap side of the trade by more than two orders of
        // magnitude. Revisit only if the source ever emits a sane VUI.
        hardwareAcceleration: "prefer-software",
        avc: { format: "annexb" },
      };
      this.lastConfig = config;
      decoder.configure(config);
      this.decoder = decoder;
    } catch (err) {
      this.reportError(err);
      this.decoder = null;
    }
  }

  /** Tears down the decoder and drops all buffered state. Idempotent. */
  close(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.pending = new Uint8Array(0);
    this.prefixNals = [];
    this.sps = null;
    this.nextTimestampUs = 0;
    if (decoder && decoder.state !== "closed") {
      try {
        decoder.close();
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  /**
   * Drops a decoder that can no longer accept work, keeping the SPS so the
   * next IDR can configure a fresh one. Recovery is deliberately gated on a
   * keyframe: feeding deltas to a decoder that never saw their reference is
   * how a freeze becomes a screen of green blocks.
   */
  private retireDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.prefixNals = [];
    if (decoder !== null && decoder.state !== "closed") {
      try {
        decoder.close();
      } catch {
        // Already unusable; the point was only to release its resources.
      }
    }
  }

  private reportError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    try {
      this.cb.onError?.(e);
    } catch {
      // onError itself must never propagate -- swallow, mirrors TrackingSession.
    }
  }
}

/** Concatenates NAL units back into one Annex-B buffer, re-adding the
 * 4-byte start code stripped off by splitAnnexBNals (required for
 * `avc: { format: "annexb" }` decode, which expects real start codes). */
function concatWithStartCodes(nals: AnnexBNal[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += START_CODE.length + n.data.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) {
    out.set(START_CODE, o);
    o += START_CODE.length;
    out.set(n.data, o);
    o += n.data.length;
  }
  return out;
}
