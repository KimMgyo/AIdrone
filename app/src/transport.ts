/**
 * The one and only seam between this WebView and Tauri. Nothing else under
 * src/ may import @tauri-apps/api: Rust owns every socket and native detector,
 * while the frontend consumes only validated IPC observations and paints them.
 *
 * Rust command surface this file targets:
 *   connect(frames, telemetry, link, drone, vision)
 *   disconnect()
 *   set_vision_mode(mode)             -- native detector selection only
 *   send_command(cmd) -> String       -- raw Tello SDK reply
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ControlMode } from "./control-mode.ts";

/** One snapshot of video.rs's VideoStats, plus the two rates the HUD wants.
 * `fps`/`mbps` are link-side (datagrams off the wire), NOT painted frames --
 * render.ts reports the painted number separately, and the gap between the
 * two is exactly how you tell a network problem from a decode problem. */
export type Telemetry = {
  frames: number;
  pkts: number;
  bytes: number;
  fps: number;
  mbps: number;
  frameMax: number;
  gapMaxMs: number;
  lastFrameEpochUs: number;
};

/** link.rs's dead-datapath verdict. `silent` fires only after frames were
 * once arriving and then stopped for 10 s -- a stream that never started is
 * not a failure, so this never fires on a cold app. */
export type LinkEvent = { kind: "silent"; seconds: number } | { kind: "recovered" };

/**
 * Native vision channel contract. These are observations only: none of these
 * values are controls, targets in flight, or a request to issue an SDK command.
 */
export type VisionStatusState = "inactive" | "waitingFrame" | "ready" | "error";

export type VisionStatusEvent = Readonly<{
  kind: "status";
  mode: ControlMode;
  state: VisionStatusState;
  detail?: string;
}>;

export type VisionPoint = Readonly<{ x: number; y: number }>;

export type VisionArucoMarker = Readonly<{
  id: number;
  hammingDistance: number;
  /** AprilTag 3's per-detection decode confidence; `aruco-rs` omits it. */
  decisionMargin?: number;
  corners: readonly [VisionPoint, VisionPoint, VisionPoint, VisionPoint];
}>;

export const VISION_ARUCO_ENGINES = ["apriltag3", "aruco-rs"] as const;
export type VisionArucoEngine = (typeof VISION_ARUCO_ENGINES)[number];
export const VISION_ARUCO_ENGINE_STATES = ["ready", "error"] as const;
export type VisionArucoEngineState = (typeof VISION_ARUCO_ENGINE_STATES)[number];

export type VisionArucoEngineResult<E extends VisionArucoEngine = VisionArucoEngine> = Readonly<{
  engine: E;
  family: "ARUCO_MIP_36h12";
  state: VisionArucoEngineState;
  analysisMs: number;
  /** An error has no current markers; ready never carries a stale detail. */
  detail?: string;
  markers: readonly VisionArucoMarker[];
}>;

export type VisionArucoEngines = readonly [
  VisionArucoEngineResult<"apriltag3">,
  VisionArucoEngineResult<"aruco-rs">,
];

export type VisionArucoEvent = Readonly<{
  kind: "aruco";
  recvEpochUs: number;
  width: number;
  height: number;
  /** Ordered, same-frame outcomes. Index 0 is the primary presentation engine. */
  engines: VisionArucoEngines;
}>;

export type VisionPersonDetection = Readonly<{
  /** Native tracker identity. Stable for the life of one track and never
   * reused within a session, so a selection may key off it across frames. */
  trackId: number;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type VisionPersonEvent = Readonly<{
  kind: "person";
  recvEpochUs: number;
  width: number;
  height: number;
  analysisMs: number;
  detections: readonly VisionPersonDetection[];
}>;

export type VisionEvent = VisionStatusEvent | VisionArucoEvent | VisionPersonEvent;

/**
 * One Tello state datagram off UDP 8890, at the drone's own ~10 Hz.
 *
 * Every field is optional on purpose. Firmware revisions add and drop keys, and
 * `state.rs` passes through whatever the drone actually sent rather than
 * asserting a shape - so a panel must render `--` for anything absent instead of
 * assuming a zero. A zero on a flight display is a reading; an absent field is
 * not, and the two must never look alike.
 *
 * Units are the SDK's own: `h`/`tof`/`baro` cm, `bat` %, `time` s (motor-on),
 * `pitch`/`roll`/`yaw` degrees, `agx`/`agy`/`agz` 0.001 g. `vgx`/`vgy`/`vgz`
 * carry NO documented unit in the SDK, so nothing in this app labels them.
 */
export type DroneState = {
  pitch?: number;
  roll?: number;
  yaw?: number;
  vgx?: number;
  vgy?: number;
  vgz?: number;
  templ?: number;
  temph?: number;
  tof?: number;
  h?: number;
  bat?: number;
  baro?: number;
  time?: number;
  agx?: number;
  agy?: number;
  agz?: number;
  /** Host wall clock when the datagram landed, so a panel can grey out state
   *  that stopped arriving while the app still says "connected". */
  recvEpochUs: number;
};

/** The four sockets the link is made of, resolved through the same env
 *  overrides Rust uses - so a simulator run shows the simulator's addresses. */
export type Endpoints = { node: string; tello: string; state: string; video: string };

/** One preflight result. `ok` is the only thing the UI colours on; `detail`
 *  carries the drone's verbatim answer or the bind error. */
export type Probe = { id: string; label: string; detail: string; ok: boolean };

type Sink<A extends unknown[]> = (...args: A) => void;

/** Minimal fan-out registry. Emits over a copy of the set so a callback that
 * unsubscribes itself mid-emit cannot skip the next subscriber, and swallows
 * subscriber throws so one broken HUD cell cannot kill the frame path. */
function subscribers<A extends unknown[]>() {
  const sinks = new Set<Sink<A>>();
  return {
    add(cb: Sink<A>): () => void {
      sinks.add(cb);
      return () => {
        sinks.delete(cb);
      };
    },
    emit(...args: A): void {
      for (const cb of [...sinks]) {
        try {
          cb(...args);
        } catch (err) {
          console.error("transport: subscriber threw", err);
        }
      }
    },
  };
}

const frameSubs = subscribers<[Uint8Array, number]>();
const telemetrySubs = subscribers<[Telemetry]>();
const droneSubs = subscribers<[DroneState]>();
const linkSubs = subscribers<[LinkEvent]>();
const visionSubs = subscribers<[VisionEvent]>();
const rcErrorSubs = subscribers<[string]>();

/** `connect` is the only operation that makes mode changes meaningful. Keeping
 * this guard in the transport seam prevents a stale UI callback from ever
 * invoking the native detector after a session has gone away. */
let sessionLive = false;

// ---------------------------------------------------------------------------
// Frame wire format. Confirmed against tauri 2.11.5: a Channel carrying
// `InvokeResponseBody::Raw` reaches JS as an ArrayBuffer, because any payload
// >= 1024 B is cached and fetched over the ipc custom protocol, whose reader
// resolves a non-JSON content-type with `.arrayBuffer()`. Ours are ~5.6 KB,
// always above that threshold.
//
// A Channel message carries exactly ONE payload, so lib.rs prefixes each
// frame with its receive time instead of sending a second message that could
// arrive out of step with the pixels it describes. Sending an object instead
// would drag the bytes back through serde as a JSON array of integers -
// ~30 KB of text per 5.6 KB frame, 25 times a second.
//
//   [0..8)  u64 little-endian wall-clock microseconds (video.rs stamp)
//   [8..]   Annex-B H.264
// ---------------------------------------------------------------------------

/** Width of the epoch stamp lib.rs prefixes to every frame. */
const STAMP_LEN = 8;

/** Whatever the frames Channel may deliver. */
type FrameWire = ArrayBuffer | ArrayBufferView | number[];

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  // A Vec<u8> sent as a Serialize payload rather than Raw would land here as
  // a JSON number array. Accepted so a Rust-side slip degrades to slow
  // instead of blank, but it is the failure mode the Raw path exists to avoid.
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}

function decodeFrame(msg: FrameWire): { data: Uint8Array; recvEpochUs: number } | null {
  const buf = toBytes(msg);
  if (!buf || buf.byteLength <= STAMP_LEN) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, STAMP_LEN);
  // Exact as a Number out to 2^53 us, i.e. year 2255. Reading it as a BigInt
  // first keeps the conversion honest rather than assuming the top bits are
  // always zero.
  const recvEpochUs = Number(view.getBigUint64(0, true));
  // subarray, not slice: the decoder only reads these bytes, so the copy the
  // IPC layer already made is the last one this frame needs.
  return { data: buf.subarray(STAMP_LEN), recvEpochUs };
}

/** First finite number found under any of `keys`. Rust structs reach us as
 * serde snake_case by default but the parent may add rename_all, so every
 * field is looked up under both spellings rather than pinned to one. */
function pickNumber(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Previous counter snapshot, for deriving rates. Cleared on connect so a
 * reconnect cannot show a bogus spike from the old session's counters. */
let prevCounters: { frames: number; bytes: number; at: number } | null = null;

function decodeTelemetry(msg: unknown): Telemetry | null {
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  const frames = pickNumber(rec, "frames") ?? 0;
  const pkts = pickNumber(rec, "pkts") ?? 0;
  const bytes = pickNumber(rec, "bytes") ?? 0;

  // VideoStats carries monotonic counters only; fps and Mb/s are rates, so
  // derive them from the delta between snapshots unless Rust sent them.
  // A counter that went backwards means Rust restarted its receiver -- treat
  // that as a fresh baseline rather than emitting a negative rate.
  const prev = prevCounters;
  const now = performance.now();
  const dt = prev ? (now - prev.at) / 1000 : 0;
  const usable = prev !== null && dt > 0 && frames >= prev.frames && bytes >= prev.bytes;
  const fps = pickNumber(rec, "fps") ?? (usable && prev ? (frames - prev.frames) / dt : 0);
  const mbps = pickNumber(rec, "mbps") ?? (usable && prev ? ((bytes - prev.bytes) * 8) / dt / 1e6 : 0);
  prevCounters = { frames, bytes, at: now };

  return {
    frames,
    pkts,
    bytes,
    fps,
    mbps,
    frameMax: pickNumber(rec, "frameMax", "frame_max") ?? 0,
    gapMaxMs: pickNumber(rec, "gapMaxMs", "gap_max_ms") ?? 0,
    lastFrameEpochUs: pickNumber(rec, "lastFrameEpochUs", "last_frame_epoch_us") ?? 0,
  };
}

/** Every SDK state field this app reads. `state.rs` forwards unknown keys too,
 *  so this list is a projection, not a schema - a field the drone stops sending
 *  simply goes absent and the panels render `--`. */
const STATE_KEYS = [
  "pitch", "roll", "yaw",
  "vgx", "vgy", "vgz",
  "templ", "temph", "tof", "h",
  "bat", "baro", "time",
  "agx", "agy", "agz",
] as const;

function decodeDroneState(msg: unknown): DroneState | null {
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;

  // No stamp means the datagram never went through state.rs - refuse it rather
  // than dating it "now", which would make a replayed or stale message look
  // fresh on a display whose whole job is to say how old the reading is.
  const recvEpochUs = pickNumber(rec, "recvEpochUs", "recv_epoch_us");
  if (recvEpochUs === null) return null;

  const out: DroneState = { recvEpochUs };
  for (const k of STATE_KEYS) {
    const v = pickNumber(rec, k);
    if (v !== null) out[k] = v;
  }
  return out;
}

/** Accepts both serde enum representations: the default external tagging
 * (`"Recovered"` / `{"Silent":{"seconds":10}}`) and an internally tagged
 * `{kind,seconds}` if the parent adds #[serde(tag = "kind")]. A Rust-side
 * attribute change must not be able to blank the HUD's loudest warning. */
function decodeLink(msg: unknown): LinkEvent | null {
  if (typeof msg === "string") {
    return msg.toLowerCase() === "recovered" ? { kind: "recovered" } : null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;

  const tag = typeof rec.kind === "string" ? rec.kind.toLowerCase() : null;
  if (tag === "recovered") return { kind: "recovered" };
  if (tag === "silent") return { kind: "silent", seconds: pickNumber(rec, "seconds") ?? 0 };

  if ("Recovered" in rec || "recovered" in rec) return { kind: "recovered" };
  const silent = rec.Silent ?? rec.silent;
  if (typeof silent === "object" && silent !== null) {
    return { kind: "silent", seconds: pickNumber(silent as Record<string, unknown>, "seconds") ?? 0 };
  }
  return null;
}

const VISION_MODES: readonly ControlMode[] = ["key", "person", "aruco"];
const VISION_STATUS_STATES: readonly VisionStatusState[] = ["inactive", "waitingFrame", "ready", "error"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function visionMode(value: unknown): value is ControlMode {
  return typeof value === "string" && VISION_MODES.includes(value as ControlMode);
}

function visionStatusState(value: unknown): value is VisionStatusState {
  return typeof value === "string" && VISION_STATUS_STATES.includes(value as VisionStatusState);
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonnegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeVisionPoint(value: unknown): VisionPoint | null {
  const rec = record(value);
  if (rec === null) return null;
  const x = finite(rec.x);
  const y = finite(rec.y);
  return x === null || y === null ? null : { x, y };
}

function decodeVisionMarker(value: unknown): VisionArucoMarker | null {
  const rec = record(value);
  if (rec === null) return null;
  const id = nonnegativeSafeInteger(rec.id);
  const hammingDistance = nonnegativeSafeInteger(rec.hammingDistance);
  if (id === null || hammingDistance === null || !Array.isArray(rec.corners) || rec.corners.length !== 4) return null;

  const corners = rec.corners.map(decodeVisionPoint);
  const [first, second, third, fourth] = corners;
  if (first === null || second === null || third === null || fourth === null) return null;
  if (rec.decisionMargin === undefined) {
    return { id, hammingDistance, corners: [first, second, third, fourth] };
  }
  const decisionMargin = finite(rec.decisionMargin);
  return decisionMargin === null
    ? null
    : { id, hammingDistance, decisionMargin, corners: [first, second, third, fourth] };
}

function visionArucoEngine(value: unknown): value is VisionArucoEngine {
  return typeof value === "string" && VISION_ARUCO_ENGINES.includes(value as VisionArucoEngine);
}

function visionArucoEngineState(value: unknown): value is VisionArucoEngineState {
  return typeof value === "string" && VISION_ARUCO_ENGINE_STATES.includes(value as VisionArucoEngineState);
}

function decodeVisionArucoEngineResult<E extends VisionArucoEngine>(
  value: unknown,
  expectedEngine: E,
): VisionArucoEngineResult<E> | null {
  const rec = record(value);
  if (
    rec === null ||
    rec.engine !== expectedEngine ||
    !visionArucoEngine(rec.engine) ||
    rec.family !== "ARUCO_MIP_36h12" ||
    !visionArucoEngineState(rec.state)
  ) {
    return null;
  }
  const analysisMs = nonnegativeFinite(rec.analysisMs);
  if (analysisMs === null || !Array.isArray(rec.markers)) return null;

  const markers: VisionArucoMarker[] = [];
  const markerIds = new Set<number>();
  for (const value of rec.markers) {
    const marker = decodeVisionMarker(value);
    if (marker === null || markerIds.has(marker.id)) return null;
    markerIds.add(marker.id);
    markers.push(marker);
  }

  if (rec.state === "error") {
    if (typeof rec.detail !== "string" || rec.detail.trim().length === 0 || markers.length !== 0) return null;
    return {
      engine: expectedEngine,
      family: "ARUCO_MIP_36h12",
      state: "error",
      analysisMs,
      detail: rec.detail,
      markers,
    };
  }
  if (rec.detail !== undefined) return null;
  return {
    engine: expectedEngine,
    family: "ARUCO_MIP_36h12",
    state: "ready",
    analysisMs,
    markers,
  };
}

function decodeVisionArucoEngines(value: unknown): VisionArucoEngines | null {
  if (!Array.isArray(value) || value.length !== VISION_ARUCO_ENGINES.length) return null;
  const primary = decodeVisionArucoEngineResult(value[0], "apriltag3");
  const comparison = decodeVisionArucoEngineResult(value[1], "aruco-rs");
  return primary === null || comparison === null ? null : [primary, comparison];
}

function decodeVisionPersonDetection(value: unknown): VisionPersonDetection | null {
  const rec = record(value);
  if (rec === null) return null;
  const trackId = nonnegativeSafeInteger(rec.trackId);
  const confidence = finite(rec.confidence);
  const x = finite(rec.x);
  const y = finite(rec.y);
  const width = nonnegativeFinite(rec.width);
  const height = nonnegativeFinite(rec.height);
  if (
    trackId === null ||
    confidence === null ||
    confidence < 0 ||
    confidence > 1 ||
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width === 0 ||
    height === 0
  ) {
    return null;
  }
  return { trackId, confidence, x, y, width, height };
}

/**
 * Decode the single, internally-tagged native vision protocol. Unlike the
 * compatibility decoders above, this intentionally accepts no alternate
 * spellings or guessed defaults: an incomplete vision result must disappear,
 * never become a plausible-looking marker or person box.
 */
export function decodeVisionEvent(msg: unknown): VisionEvent | null {
  const rec = record(msg);
  if (rec === null || typeof rec.kind !== "string") return null;

  if (rec.kind === "status") {
    if (!visionMode(rec.mode) || !visionStatusState(rec.state)) return null;
    if (rec.detail !== undefined && typeof rec.detail !== "string") return null;
    return rec.detail === undefined
      ? { kind: "status", mode: rec.mode, state: rec.state }
      : { kind: "status", mode: rec.mode, state: rec.state, detail: rec.detail };
  }

  const recvEpochUs = nonnegativeSafeInteger(rec.recvEpochUs);
  const width = positiveSafeInteger(rec.width);
  const height = positiveSafeInteger(rec.height);
  if (recvEpochUs === null || width === null || height === null) return null;

  if (rec.kind === "aruco") {
    const engines = decodeVisionArucoEngines(rec.engines);
    return engines === null ? null : { kind: "aruco", recvEpochUs, width, height, engines };
  }

  const analysisMs = nonnegativeFinite(rec.analysisMs);
  if (analysisMs === null) return null;

  if (rec.kind === "person") {
    if (!Array.isArray(rec.detections)) return null;
    const detections: VisionPersonDetection[] = [];
    // Two boxes claiming one track identity make the frontend lock ambiguous,
    // so the whole event is refused rather than silently picking a winner.
    const trackIds = new Set<number>();
    for (const value of rec.detections) {
      const detection = decodeVisionPersonDetection(value);
      if (detection === null || trackIds.has(detection.trackId)) return null;
      trackIds.add(detection.trackId);
      detections.push(detection);
    }
    return { kind: "person", recvEpochUs, width, height, analysisMs, detections };
  }

  return null;
}

export async function connect(): Promise<void> {
  prevCounters = null;
  sessionLive = false;

  const frames = new Channel<FrameWire>();
  frames.onmessage = (msg) => {
    const f = decodeFrame(msg);
    if (f) frameSubs.emit(f.data, f.recvEpochUs);
  };

  const telemetry = new Channel<unknown>();
  telemetry.onmessage = (msg) => {
    const t = decodeTelemetry(msg);
    if (t) telemetrySubs.emit(t);
  };

  const link = new Channel<unknown>();
  link.onmessage = (msg) => {
    const e = decodeLink(msg);
    if (e) linkSubs.emit(e);
  };

  const drone = new Channel<unknown>();
  drone.onmessage = (msg) => {
    const s = decodeDroneState(msg);
    if (s) droneSubs.emit(s);
  };

  const vision = new Channel<unknown>();
  vision.onmessage = (msg) => {
    const event = decodeVisionEvent(msg);
    if (event !== null) visionSubs.emit(event);
  };

  await invoke("connect", { frames, telemetry, link, drone, vision });
  sessionLive = true;
}

export async function disconnect(): Promise<void> {
  prevCounters = null;
  sessionLive = false;
  await invoke("disconnect");
}

/**
 * Selects the native detector for this live session. `key` means inactive; it
 * is sent to retire automatic vision, not to create another flight-control
 * path. Invalid modes and calls outside a session never reach Rust.
 */
export async function setVisionMode(mode: ControlMode): Promise<void> {
  if (!visionMode(mode)) throw new TypeError(`invalid vision mode: ${String(mode)}`);
  if (!sessionLive) throw new Error("cannot set native vision mode without a live session");
  await invoke("set_vision_mode", { mode });
}

/** Sends one raw Tello SDK command and returns its reply verbatim
 * ("ok", "error", "87" for battery?, ...). Rust owns the retry/timeout. */
export async function sendCommand(cmd: string): Promise<string> {
  return await invoke<string>("send_command", { cmd });
}

/** What Rust reports while a turn is still being written. */
export type TurnNotice =
  /** A deliberate pause on a provider quota, in seconds. */
  | { readonly kind: "waiting"; readonly seconds: number }
  /** A fragment of the model's own reasoning, while it is still thinking. */
  | { readonly kind: "thinking"; readonly chunk: string }
  /** A tool call the model has just named, before its arguments finish. */
  | { readonly kind: "calling"; readonly name: string }
  /** A fragment of `done`'s summary, in order. */
  | { readonly kind: "summary"; readonly chunk: string }
  /** Which model answered, and whether the chain had to fall past its first. */
  | { readonly kind: "model"; readonly model: string; readonly fellBack: boolean };

/**
 * One model turn. Rust holds the API key and forwards the body unchanged, so
 * the tool schema stays here in TypeScript and adding a tool never touches
 * Rust. The response is `unknown` on purpose: `copilot/agent.ts` narrows it.
 *
 * `onNotice` is the live half. A turn is silent while the model thinks and
 * then writes quickly, so without it the panel learns everything at once, at
 * the end - and a drone is airborne for the whole wait.
 */
export async function copilotTurn(body: unknown, onNotice?: (notice: TurnNotice) => void): Promise<unknown> {
  const notice = new Channel<unknown>();
  notice.onmessage = (msg) => {
    if (onNotice === undefined || typeof msg !== "object" || msg === null) return;
    if ("waitingSeconds" in msg && typeof msg.waitingSeconds === "number" && Number.isFinite(msg.waitingSeconds)) {
      onNotice({ kind: "waiting", seconds: msg.waitingSeconds });
    }
    if ("thinking" in msg && typeof msg.thinking === "string") {
      onNotice({ kind: "thinking", chunk: msg.thinking });
    }
    if ("calling" in msg && typeof msg.calling === "string") {
      onNotice({ kind: "calling", name: msg.calling });
    }
    if ("summaryChunk" in msg && typeof msg.summaryChunk === "string") {
      onNotice({ kind: "summary", chunk: msg.summaryChunk });
    }
    if ("model" in msg && typeof msg.model === "string") {
      onNotice({ kind: "model", model: msg.model, fellBack: "fellBack" in msg && msg.fellBack === true });
    }
  };
  return await invoke<unknown>("copilot_turn", { body, notice });
}

/**
 * Speech to text, native on both platforms. It is deliberately not wired to
 * anything that flies: the transcript goes into the input box and the operator
 * presses send, because a misheard "팔 미터" has to be readable first.
 */

/** Resolves with the microphone's name, or rejects with what is missing. */
export async function dictateReady(): Promise<string> {
  return await invoke<string>("dictate_ready");
}

export async function dictateStart(): Promise<void> {
  await invoke("dictate_start");
}

/** The transcript, or "" when nothing worth reporting was heard. */
export async function dictateStop(): Promise<string> {
  return await invoke<string>("dictate_stop");
}

/**
 * Fire-and-forget by design - the stick loop cannot wait on a round trip - but
 * NOT silent. A swallowed rejection here is indistinguishable from a drone
 * that ignores the command, which is exactly the ambiguity that costs an
 * afternoon on the bench.
 */
export function sendRc(cmd: string): void {
  void invoke("send_rc", { cmd }).catch((err: unknown) => {
    rcErrorSubs.emit(err instanceof Error ? err.message : String(err));
  });
}

export function onRcError(cb: (message: string) => void): () => void {
  return rcErrorSubs.add(cb);
}

/** The four sockets, as Rust resolves them. Safe to call with no session. */
export async function endpoints(): Promise<Endpoints> {
  return await invoke<Endpoints>("endpoints");
}

/** Probes each socket and the drone itself. Takes ~2 s and cannot run while a
 *  session holds the ports. */
export async function preflight(): Promise<Probe[]> {
  return await invoke<Probe[]>("preflight");
}

export function onFrame(cb: (data: Uint8Array, recvEpochUs: number) => void): () => void {
  return frameSubs.add(cb);
}

export function onTelemetry(cb: (t: Telemetry) => void): () => void {
  return telemetrySubs.add(cb);
}

export function onDroneState(cb: (s: DroneState) => void): () => void {
  return droneSubs.add(cb);
}

export function onLink(cb: (e: LinkEvent) => void): () => void {
  return linkSubs.add(cb);
}

export function onVision(cb: (event: VisionEvent) => void): () => void {
  return visionSubs.add(cb);
}
