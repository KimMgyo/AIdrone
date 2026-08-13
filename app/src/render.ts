/**
 * Decode + paint. Owns one <canvas> and one H264Stream, and nothing else --
 * no sockets, no Tauri, no knowledge of where the bytes came from.
 *
 * The number this file exists to produce is end-to-end latency: Rust stamps
 * each frame with the wall clock at the moment its last UDP datagram landed,
 * so (now - recvEpochUs) at paint time is the true receive-to-paint pipeline
 * cost. Replacing the browser client was worth doing only if that number is
 * small, so it is measured here and shown, not assumed.
 */
import { H264Stream } from "./lib/h264decode.ts";

export interface RenderStats {
  /** Frames actually drawn in the last second. Diverges from the link's fps
   * when the decoder or the compositor -- not the network -- is the problem. */
  displayedFps: number;
  painted: number;
  droppedOnBacklog: number;
  /** VideoDecoder.decodeQueueSize, or null if it could not be read. */
  decodeQueue: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** The transport half of that same budget: Rust's arrival stamp to the
   * moment push() is called, i.e. the Tauri IPC hop alone. Subtract it from
   * latencyP*Ms to get decode + vsync wait. Split because the two halves need
   * opposite fixes and a single total cannot say which one is at fault. */
  transportP50Ms: number | null;
  /** `decode()` -> `output()` for the most recent frame: the decoder's own
   *  latency, with our transport and our paint excluded. */
  decodeMs: number | null;
  transportP95Ms: number | null;
  width: number;
  height: number;
  decodeErrors: number;
  lastError: string | null;
}

/**
 * A consumer can veto its own canvas readback before `getImageData()` runs.
 * That matters for vision: copying a painted frame off the GPU is expensive,
 * so a throttled/inactive tracker must cost only this small predicate call.
 */
export interface VideoPostPaintCallback {
  shouldReadPixels(): boolean;
  onPixels(pixels: ImageData): void;
}

export interface VideoRendererOptions {
  /** Invoked after paint only when it asks for this frame's pixels. */
  postPaintCallback?: VideoPostPaintCallback | null;
}

/** Percentiles are over the last 100 painted frames: at 25 fps that is a
 * 4 s window -- long enough to be stable, short enough to react. */
const LATENCY_WINDOW = 100;

/** Depth past which a decoder burst is treated as backlog rather than as
 * bundling.
 *
 * Painting now happens on arrival, so a queue can only form inside one
 * `decode()` callback. H.264 decode can emit two outputs together; both get
 * drawn. The limit only bounds a pathological burst, and `dropped` climbing
 * means the burst exceeded it. */
const PAINT_QUEUE_MAX = 2;

export class VideoRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly stream: H264Stream;
  private postPaintCallback: VideoPostPaintCallback | null = null;

  /** Decoded and not yet drawn - normally empty, since `onDecoded` drains it
   * synchronously. Each frame carries its own receive stamp on
   * `frame.timestamp`; see push(). */
  private readonly queue: VideoFrame[] = [];
  private closed = false;

  private readonly latenciesMs: number[] = [];
  private readonly transportMs: number[] = [];
  private readonly paintTimes: number[] = [];

  private painted = 0;
  private droppedOnBacklog = 0;
  private decodeErrors = 0;
  private lastError: string | null = null;

  constructor(canvas: HTMLCanvasElement, options: VideoRendererOptions = {}) {
    this.canvas = canvas;
    // desynchronized skips a compositor hop for a canvas that is only ever
    // overwritten; alpha:false lets the compositor skip blending it too.
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.postPaintCallback = options.postPaintCallback ?? null;
    this.stream = new H264Stream({
      onFrame: (frame) => this.onDecoded(frame),
      onError: (e) => this.noteError(e),
    });
  }

  /** Feeds one complete frame's Annex-B bytes, with the wall-clock epoch (us)
   * Rust stamped when its last UDP datagram arrived. Rust delimits these on
   * the drone's own short datagram, so each call ends on a NAL boundary - see
   * `H264Stream.push`'s `endOfBatch`, which is worth a frame of latency. */
  push(data: Uint8Array, recvEpochUs: number): void {
    if (this.closed) return;
    VideoRenderer.record(this.transportMs, VideoRenderer.ageMs(recvEpochUs));
    // The stamp rides through the decoder on the chunk timestamp and comes
    // back on `frame.timestamp`. Pairing them outside the decoder - a FIFO of
    // stamps popped per output - silently skews the moment output count and
    // push count diverge, and then reports the skew as latency.
    this.stream.push(data, recvEpochUs, true);
  }

  stats(): RenderStats {
    this.prunePaintTimes(performance.now());
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const transport = [...this.transportMs].sort((a, b) => a - b);
    return {
      displayedFps: this.paintTimes.length,
      painted: this.painted,
      droppedOnBacklog: this.droppedOnBacklog,
      decodeQueue: this.decodeQueueSize(),
      latencyP50Ms: sorted.length > 0 ? percentile(sorted, 50) : null,
      latencyP95Ms: sorted.length > 0 ? percentile(sorted, 95) : null,
      transportP50Ms: transport.length > 0 ? percentile(transport, 50) : null,
      transportP95Ms: transport.length > 0 ? percentile(transport, 95) : null,
      width: this.canvas.width,
      decodeMs: this.stream.decodeLatencyMs(),
      height: this.canvas.height,
      decodeErrors: this.decodeErrors,
      lastError: this.lastError,
    };
  }

  /** The decoder configuration this session is running, or null if no SPS has
   *  arrived yet. Only the failure path reads it: `isConfigSupported` on this
   *  object is what separates a WebView with no H.264 decoder from one whose
   *  decoder took the stream and broke on it. */
  decoderConfiguration(): VideoDecoderConfig | null {
    return this.stream.configuration();
  }

  /**
   * Replaces the optional post-paint consumer. Passing null restores the
   * original paint-only path: no canvas readback and no ImageData allocation.
   */
  setPostPaintCallback(callback: VideoPostPaintCallback | null): void {
    if (!this.closed) this.postPaintCallback = callback;
  }

  /** Tears down the decoder and releases the held frame. Idempotent. Any
   * frame the decoder still emits afterwards is closed by onDecoded's guard. */
  close(): void {
    this.closed = true;
    this.postPaintCallback = null;
    // Nothing is scheduled any more: paints happen inside onDecoded, so a
    // closed renderer simply stops being called.
    for (const frame of this.queue) frame.close();
    this.queue.length = 0;
    this.stream.close();
    if (this.ctx) {
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private onDecoded(frame: VideoFrame): void {
    if (this.closed) {
      frame.close();
      return;
    }
    this.queue.push(frame);
    while (this.queue.length > PAINT_QUEUE_MAX) {
      // Genuinely behind, not merely bundled: the oldest is stale and this is
      // a live pilot's view, so latency beats completeness.
      const stale = this.queue.shift();
      if (stale) stale.close();
      this.droppedOnBacklog++;
    }
    // Paint here, not on the next animation frame. A pilot's picture is worth
    // exactly what it costs in age, and `requestAnimationFrame` charges a
    // whole refresh interval for the privilege of being tidy: measured on a
    // 60 Hz Wayland laptop, receive-to-paint sat at 30 ms against ~5 ms of
    // real work, because a frame that lands just after a frame callback waits
    // out the entire next one. Drawing on arrival costs at most one extra
    // drawImage when two decoder outputs land inside one refresh - the
    // compositor shows the last one either way.
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && !this.closed) this.paint();
  }

  private readonly paint = (): void => {
    const frame = this.queue.shift();
    if (!frame) return;
    let postPaint: VideoPostPaintCallback | null = null;
    let pixels: ImageData | null = null;
    try {
      const ctx = this.ctx;
      if (ctx) {
        // Backing store follows the stream's own dimensions, never CSS pixels
        // -- CSS does the letterboxing, so resampling happens once, in the
        // compositor, instead of on every drawImage.
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
          this.canvas.width = frame.displayWidth;
          this.canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        this.painted++;
        const now = performance.now();
        this.paintTimes.push(now);
        this.prunePaintTimes(now);
        VideoRenderer.record(this.latenciesMs, VideoRenderer.ageMs(frame.timestamp));
        // The predicate runs after the frame is visibly painted but before a
        // costly GPU-to-CPU readback. `ImageData` exists only for the frames a
        // consumer explicitly requested; all other frames keep the old path.
        const requested = this.postPaintCallback;
        if (requested?.shouldReadPixels()) {
          postPaint = requested;
          pixels = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        }
      }
    } catch (err) {
      this.noteError(err);
    } finally {
      // The single most important line in this file: a VideoFrame holds a
      // native GPU buffer that is not freed until closed, and the decoder
      // stalls within seconds once its pool is exhausted. Every path out of
      // this class closes exactly once -- here, in onDecoded's overflow
      // branch, in onDecoded's closed guard, and in close().
      frame.close();
    }
    // getImageData made the callback's input independent of the VideoFrame, so
    // release the native decoder buffer above before synchronous vision work.
    if (postPaint !== null && pixels !== null) {
      try {
        postPaint.onPixels(pixels);
      } catch (err) {
        this.noteError(err);
      }
    }
  };

  /** Milliseconds elapsed since a Rust arrival stamp, or null if the stamp is
   * unusable. Both halves of the budget are the same subtraction against the
   * same clock, taken at two points in the path. */
  private static ageMs(recvEpochUs: number): number | null {
    if (!Number.isFinite(recvEpochUs) || recvEpochUs <= 0) return null;
    return ((performance.timeOrigin + performance.now()) * 1000 - recvEpochUs) / 1000;
  }

  private static record(window: number[], sample: number | null): void {
    if (sample === null) return;
    window.push(sample);
    if (window.length > LATENCY_WINDOW) window.shift();
  }

  private prunePaintTimes(now: number): void {
    while (this.paintTimes.length > 0 && now - this.paintTimes[0] > 1000) this.paintTimes.shift();
  }

  /** H264Stream keeps its VideoDecoder private and that file is off-limits,
   * but decodeQueueSize is the only backpressure signal WebCodecs exposes --
   * read it structurally and report null if the field ever moves. */
  private decodeQueueSize(): number | null {
    const inner = this.stream as unknown as { decoder?: VideoDecoder | null };
    const decoder = inner.decoder;
    return decoder ? decoder.decodeQueueSize : null;
  }

  private noteError(err: unknown): void {
    this.decodeErrors++;
    this.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}
