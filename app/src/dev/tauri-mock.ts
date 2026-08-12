/**
 * A fake drone, for laying out the UI in a browser.
 *
 * This is the ONE file allowed to know what Tauri's IPC looks like from below.
 * It installs `window.__TAURI_INTERNALS__`, so `transport.ts` - and therefore
 * every screen, panel and renderer above it - runs completely unchanged, with
 * Vite's hot reload underneath. Mocking at the app's own seam instead would
 * mean maintaining a second copy of the transport, and the copy is exactly
 * where a mock stops matching what it stands in for.
 *
 * It is a design surface, not a simulator: the numbers move so panels can be
 * judged in motion, and the video is a real H.264 file decoded by the real
 * renderer, but nothing here models a drone. `desktop/fake-tello.ts` is the
 * control that answers protocol questions.
 *
 *   bun run dev   ->   http://localhost:1420
 *
 * Query flags, because a layout is judged in its states, not its happy path.
 * There is no autoconnect flag: the app supervises its own link, so every
 * reload already lands on a live station.
 *   ?update=1       offer a fake newer release; the top bar shows it while the
 *                   link is down, so pair it with ?empty=1 to see the chip
 *   ?empty=1        no video at all - the connect fails on the first-paint
 *                   gate, which is the only way to see that error's wording
 *   ?silent=8       report the datapath silent this many seconds in - the
 *                   frames keep coming, so the supervisor must NOT reconnect
 *   ?stall=6        stop the frames this many seconds in, session still up -
 *                   the supervisor should notice and dial again
 *   ?nonode=1       the node's adapter is absent - NODE 없음, DRONE `--`
 *   ?wedged=1       the drone answers but never streams; the one failure that
 *                   needs hands on the aircraft
 *   ?bat=14         hold the battery here (colour thresholds are 30 / 15)
 */
// Imports nothing any more: the flat marker event is plain JSON. The marker is
// still needed because `declare global` below only works in a module, and this
// file is loaded for its side effects alone.
export {};

type Handler = (args: Record<string, unknown>) => unknown;

/** What `@tauri-apps/api` reaches for. Declared here because the package types
 *  it as an internal the app is not supposed to see - which is true everywhere
 *  except in this file. */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      metadata: { currentWindow: { label: string }; currentWebview: { windowLabel: string; label: string } };
      transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
      unregisterCallback(id: number): void;
      convertFileSrc(path: string, protocol?: string): string;
      invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
    };
  }
}

type ChannelLike = { onmessage?: (message: unknown) => void };

/**
 * Read at call time, not snapshotted at import. A flag that only applies on
 * load cannot express a TRANSITION, and the transitions are the states worth
 * judging: the node arriving after the app started is a bug report, not a
 * static screen. `history.replaceState({}, "", "/")` from the console flips
 * any of these live and the supervisor reacts to it.
 */
const params = (): URLSearchParams => new URLSearchParams(location.search);
const flag = (name: string): boolean => params().get(name) === "1";
const number = (name: string, fallback: number): number => {
  // `Number(null)` is 0, so an absent flag would read as a real zero - which is
  // how the battery first came up empty here.
  const raw = params().get(name);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const FRAME_HZ = 30;
const STATE_HZ = 10;
const TELEMETRY_HZ = 1;
const VISION_HZ = 10;
const WIDTH = 960;
const HEIGHT = 720;

/** Vite serves this from the repository's own capture; see vite.config.ts. */
const STREAM_URL = "/dev/sample.h264";

const callbacks = new Map<number, (payload: unknown) => void>();
let nextCallbackId = 1;

/** Channel messages carry their own order index; the real transport relies on
 *  it, so the mock keeps one counter per channel rather than sharing one. */
const channelIndex = new WeakMap<object, number>();

function send(channel: unknown, message: unknown): void {
  const target = channel as ChannelLike;
  if (typeof target?.onmessage !== "function") return;
  const index = channelIndex.get(target as object) ?? 0;
  channelIndex.set(target as object, index + 1);
  target.onmessage(message);
}

// --- the stream -------------------------------------------------------------

/** Access units of the checked-in capture, split on Annex-B start codes. One
 *  picture per unit, which is the shape video.rs delivers. */
async function loadAccessUnits(): Promise<Uint8Array[]> {
  const bytes = new Uint8Array(await (await fetch(STREAM_URL)).arrayBuffer());
  const starts: number[] = [];
  for (let i = 0; i + 3 < bytes.length; ) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push(i > 0 && bytes[i - 1] === 0 ? i - 1 : i);
      i += 3;
    } else i++;
  }

  const units: Uint8Array[] = [];
  let unitStart = starts[0] ?? 0;
  let sawSlice = false;
  for (const start of starts) {
    const header = bytes[start + (bytes[start + 2] === 1 ? 3 : 4)] ?? 0;
    const type = header & 0x1f;
    const slice = type === 1 || type === 5;
    if (slice && sawSlice) {
      units.push(bytes.subarray(unitStart, start));
      unitStart = start;
      sawSlice = false;
    }
    sawSlice ||= slice;
  }
  units.push(bytes.subarray(unitStart));
  return units;
}

/** The wire format lib.rs uses: an 8-byte little-endian epoch stamp, then the
 *  Annex-B bytes. Built here so the renderer's latency readout is real. */
function stamped(unit: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + unit.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.round(performance.timeOrigin * 1000 + performance.now() * 1000)), true);
  out.set(unit, 8);
  return out;
}

// --- the session ------------------------------------------------------------

type Session = {
  frames: unknown;
  telemetry: unknown;
  link: unknown;
  drone: unknown;
  vision: unknown;
  timers: number[];
};

let session: Session | null = null;
let mode = "key";
let battery = number("bat", 86);
let flightSeconds = 0;

function stopSession(): void {
  if (session === null) return;
  for (const timer of session.timers) window.clearInterval(timer);
  session = null;
}

function startVideo(current: Session, units: Uint8Array[]): void {
  let cursor = 0;
  let frames = 0;
  let bytes = 0;
  // The picture stopping mid-session is a first-class state now - it is what
  // the supervisor calls offline - so the mock has to be able to produce it.
  // Frames stop; the socket, the state stream and the session all stay up,
  // which is exactly the case a link-level silence check cannot see.
  const stallAt = number("stall", 0);
  const startedAt = performance.now();

  current.timers.push(
    window.setInterval(() => {
      if (stallAt > 0 && performance.now() - startedAt > stallAt * 1000) return;
      const unit = units[cursor++ % units.length]!;
      frames++;
      bytes += unit.length;
      send(current.frames, stamped(unit));
    }, 1000 / FRAME_HZ),
    window.setInterval(() => {
      send(current.telemetry, {
        frames,
        pkts: frames * 4,
        bytes,
        frameMax: 41_000,
        gapMaxMs: 38,
        lastFrameEpochUs: Date.now() * 1000,
      });
    }, 1000 / TELEMETRY_HZ),
  );
}

function startState(current: Session): void {
  current.timers.push(
    window.setInterval(() => {
      flightSeconds += 1 / STATE_HZ;
      const t = flightSeconds;
      send(current.drone, {
        recvEpochUs: Date.now() * 1000,
        bat: Math.round(battery),
        h: Math.round(120 + 18 * Math.sin(t / 3)),
        tof: Math.round(130 + 18 * Math.sin(t / 3)),
        baro: 404.7 + Math.sin(t / 5),
        time: Math.floor(t),
        pitch: Math.round(6 * Math.sin(t / 2)),
        roll: Math.round(5 * Math.cos(t / 2.5)),
        yaw: Math.round(40 * Math.sin(t / 8)),
        vgx: Math.round(12 * Math.sin(t / 1.5)),
        vgy: Math.round(9 * Math.cos(t / 1.7)),
        vgz: Math.round(4 * Math.sin(t / 2.3)),
        templ: 41,
        temph: 43,
        agx: Math.round(20 * Math.sin(t)),
        agy: Math.round(20 * Math.cos(t)),
        agz: -1000,
      });
    }, 1000 / STATE_HZ),
  );

  const silentAfter = number("silent", 0);
  if (silentAfter > 0) {
    current.timers.push(
      window.setTimeout(() => send(current.link, { kind: "silent", seconds: 10 }), silentAfter * 1000) as unknown as number,
    );
  }
}

/** A marker that drifts, so the overlay and the follow panel have something
 *  that moves. Corner order matches the detector's: clockwise from top-left. */
function arucoEvent(t: number): unknown {
  const cx = WIDTH / 2 + 180 * Math.sin(t / 2.2);
  const cy = HEIGHT / 2 + 90 * Math.cos(t / 3.1);
  const half = 70 + 12 * Math.sin(t / 1.7);
  const marker = {
    id: 7,
    hammingDistance: 0,
    corners: [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
    ],
  };
  return {
    kind: "aruco",
    recvEpochUs: Date.now() * 1000,
    width: WIDTH,
    height: HEIGHT,
    family: "ARUCO_MIP_36h12",
    state: "ready",
    analysisMs: 1.4,
    markers: [{ ...marker, decisionMargin: 62.5 }],
  };
}

function personEvent(t: number): unknown {
  const x = WIDTH / 2 - 90 + 150 * Math.sin(t / 4);
  return {
    kind: "person",
    recvEpochUs: Date.now() * 1000,
    width: WIDTH,
    height: HEIGHT,
    analysisMs: 11.2,
    detections: [
      { trackId: 1, confidence: 0.91, x, y: 190, width: 180, height: 380 },
      { trackId: 2, confidence: 0.54, x: 60, y: 250, width: 120, height: 300 },
    ],
  };
}

function startVision(current: Session): void {
  let t = 0;
  current.timers.push(
    window.setInterval(() => {
      t += 1 / VISION_HZ;
      if (mode === "aruco") send(current.vision, arucoEvent(t));
      else if (mode === "person") send(current.vision, personEvent(t));
    }, 1000 / VISION_HZ),
  );
}

// --- the command surface ----------------------------------------------------

const handlers: Record<string, Handler> = {
  endpoints: () => ({
    tello: "192.168.4.2:8889",
    state: "0.0.0.0:8890",
    video: "0.0.0.0:11111",
    node: "192.168.4.1",
  }),

  // Real MIP payload bits would need the 250-entry table in here; the library
  // only has to be clickable and visibly distinct to judge a layout, so the
  // mock generates deterministic 36-bit patterns instead. Anything that
  // depends on a code being the RIGHT one belongs against the real binary.
  marker_codes: () =>
    Array.from({ length: 250 }, (_, id) => {
      let bits = 0;
      for (let cell = 0; cell < 36; cell++) {
        const on = (((id + 1) * (cell + 7)) ^ (id << 2)) % 3 !== 0;
        bits = bits * 2 + (on ? 1 : 0);
      }
      return bits;
    }),

  preflight: () => [
    { id: "command", label: "명령 소켓", detail: "udp/8889 · ok (mock)", ok: true },
    { id: "state", label: "상태 스트림", detail: "udp/8890 · 10 Hz (mock)", ok: true },
    { id: "video", label: "영상 포트", detail: "udp/11111 사용 가능 (mock)", ok: true },
  ],

  // The node is an adapter, so the mock answers the same question Rust does:
  // does this host hold the link at all. `?nonode=1` takes it away, which is
  // the state where the drone cell must read `--` rather than claim silence.
  node_present: () => !flag("nonode"),

  connect: (args) => {
    // The one failure retrying cannot fix, in the wording `lib.rs` emits.
    if (flag("wedged")) throw new Error("no video after three streamon attempts - power-cycle the Tello");
    if (flag("nonode")) throw new Error('tello: no reply to "command"');
    stopSession();
    const current: Session = {
      frames: args.frames,
      telemetry: args.telemetry,
      link: args.link,
      drone: args.drone,
      vision: args.vision,
      timers: [],
    };
    session = current;
    flightSeconds = 0;
    if (!flag("empty")) {
      void loadAccessUnits().then((units) => {
        if (session === current) startVideo(current, units);
      });
      startState(current);
      startVision(current);
    }
    return null;
  },

  disconnect: () => {
    stopSession();
    return null;
  },

  send_command: (args) => {
    const cmd = String(args.cmd ?? "");
    if (cmd === "battery?") return String(Math.round(battery));
    if (cmd === "time?") return String(Math.floor(flightSeconds));
    return "ok";
  },

  send_rc: () => null,

  set_vision_mode: (args) => {
    mode = String(args.mode ?? "key");
    if (session !== null) {
      send(session.vision, { kind: "status", mode, state: mode === "key" ? "inactive" : "ready" });
    }
    return null;
  },

  // Enough of a turn for the panel's own states: it thinks, names a model,
  // then answers. No tools - a mock that pretended to fly would be the one
  // thing in this file that could mislead.
  copilot_turn: (args) => {
    const notice = args.notice;
    window.setTimeout(() => send(notice, { kind: "model", model: "oc/big-pickle", fellBack: false }), 120);
    window.setTimeout(() => send(notice, { kind: "thinking", chunk: "요청을 읽는 중" }), 260);
    window.setTimeout(() => send(notice, { kind: "thinking", chunk: "… 상태 확인" }), 700);
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: "목업 백엔드입니다. 실제 비행 명령은 실행되지 않습니다.",
          },
        },
      ],
    };
  },

  dictate_ready: () => "목업 마이크",
  dictate_start: () => null,
  dictate_stop: () => "이륙해서 마커를 따라가",

  update_check: () =>
    flag("update")
      ? {
          version: "9.9.9",
          tag: "build-mock",
          asset: "AIdrone_9.9.9_x64-setup.exe",
          url: "https://github.com/KimMgyo/AIdrone/releases/download/build-mock/AIdrone_9.9.9_x64-setup.exe",
          digest: "0".repeat(64),
          size: 123_000_000,
        }
      : null,

  update_apply: () => {
    throw new Error("목업 백엔드는 설치를 수행하지 않습니다");
  },
};

window.__TAURI_INTERNALS__ = {
  // `getCurrentWindow()` reads this at import time, before any command runs.
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  },
  transformCallback(callback: (payload: unknown) => void): number {
    const id = nextCallbackId++;
    callbacks.set(id, callback);
    return id;
  },
  unregisterCallback(id: number): void {
    callbacks.delete(id);
  },
  convertFileSrc: (path: string) => path,
  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Window/webview plugin traffic - fullscreen, listeners - has no drone in
    // it; answer plausibly so the chrome stays usable instead of throwing.
    if (cmd.startsWith("plugin:")) return cmd.endsWith("is_fullscreen") ? false : null;
    const handler = handlers[cmd];
    if (handler === undefined) throw new Error(`목업 백엔드에 없는 명령: ${cmd}`);
    // A real IPC hop is never synchronous, and code that accidentally depends
    // on synchronous resolution must fail here rather than in the app.
    const hop = Promise.withResolvers<void>();
    window.setTimeout(hop.resolve, 8);
    await hop.promise;
    return handler(args);
  },
};

console.info(
  "[dev] Tauri IPC mocked - drone, video and copilot are fake.",
  "Flags: ?update=1 ?empty=1 ?silent=8 ?stall=6 ?nonode=1 ?wedged=1 ?bat=14",
);
