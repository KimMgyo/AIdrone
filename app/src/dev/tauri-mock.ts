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
 *   ?nonode=1       the USB bulk node is absent - NODE 없음, DRONE `--`
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
const demoMode = (): "person" | "marker" | null => {
  const d = params().get("demo");
  return d === "person" || d === "marker" ? d : null;
};
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
  const demo = demoMode();
  if (demo !== null) {
    const demoImg = new Image();
    demoImg.src = demo === "person" ? "/demo/person.png" : "/demo/marker.png";
    (window as unknown as { __DEMO_IMAGE__?: HTMLImageElement }).__DEMO_IMAGE__ = demoImg;
  }

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
  const demo = demoMode();
  current.timers.push(
    window.setInterval(() => {
      flightSeconds += 1 / STATE_HZ;
      const t = flightSeconds;
      if (demo === "person") {
        send(current.drone, {
          recvEpochUs: Date.now() * 1000,
          bat: 84,
          h: 118,
          tof: 124,
          baro: 122.5,
          time: 114 + Math.floor(t),
          pitch: 2,
          roll: -1,
          yaw: -14,
          vgx: 0,
          vgy: 1,
          vgz: 0,
          templ: 41,
          temph: 43,
          agx: 2,
          agy: 1,
          agz: -1000,
        });
      } else if (demo === "marker") {
        send(current.drone, {
          recvEpochUs: Date.now() * 1000,
          bat: 79,
          h: 92,
          tof: 96,
          baro: 94.2,
          time: 86 + Math.floor(t),
          pitch: 1,
          roll: 0,
          yaw: -8,
          vgx: 0,
          vgy: 0,
          vgz: 0,
          templ: 42,
          temph: 44,
          agx: 1,
          agy: 0,
          agz: -1000,
        });
      } else {
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
      }
    }, 1000 / STATE_HZ),
  );

  const silentAfter = number("silent", 0);
  if (silentAfter > 0) {
    current.timers.push(
      window.setTimeout(() => send(current.link, { kind: "silent", seconds: 10 }), silentAfter * 1000) as unknown as number,
    );
  }
}

function arucoEvent(t: number): unknown {
  const demo = demoMode();
  if (demo === "marker") {
    return {
      kind: "aruco",
      recvEpochUs: Date.now() * 1000,
      width: WIDTH,
      height: HEIGHT,
      family: "ARUCO_MIP_36h12",
      state: "ready",
      analysisMs: 1.4,
      markers: [
        {
          id: 7,
          hammingDistance: 0,
          decisionMargin: 74.5,
          corners: [
            { x: 405, y: 384 },
            { x: 564, y: 384 },
            { x: 564, y: 543 },
            { x: 405, y: 543 },
          ],
        },
      ],
    };
  }

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
  const demo = demoMode();
  if (demo === "person") {
    return {
      kind: "person",
      recvEpochUs: Date.now() * 1000,
      width: WIDTH,
      height: HEIGHT,
      analysisMs: 8.6,
      detections: [
        { trackId: 3, confidence: 0.92, x: 435, y: 468, width: 85, height: 165 },
        { trackId: 1, confidence: 0.89, x: 360, y: 472, width: 82, height: 176 },
        { trackId: 5, confidence: 0.86, x: 638, y: 420, width: 66, height: 150 },
        { trackId: 2, confidence: 0.81, x: 554, y: 282, width: 48, height: 96 },
        { trackId: 8, confidence: 0.78, x: 582, y: 295, width: 45, height: 85 },
        { trackId: 12, confidence: 0.74, x: 120, y: 520, width: 75, height: 85 },
      ],
    };
  }

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
  const demo = demoMode();
  if (demo === "person") mode = "person";
  else if (demo === "marker") mode = "aruco";

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
    tello: "USB bulk OUT -> UDP/8889",
    state: "USB bulk IN <- UDP/8890",
    video: "USB bulk IN <- UDP/11111",
    node: "USB VID:303A PID:8AD2 IF:0",
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
    { id: "command", label: "USB 벌크 명령", detail: "USB bulk OUT -> UDP/8889 · ok (mock)", ok: true },
    { id: "state", label: "USB 벌크 상태", detail: "USB bulk IN <- UDP/8890 · 10 Hz (mock)", ok: true },
    { id: "video", label: "USB 벌크 영상", detail: "USB bulk IN <- UDP/11111 · 사용 가능 (mock)", ok: true },
  ],

  // `?nonode=1` models a disconnected or inaccessible USB bulk device. The
  // drone cell remains `--` rather than claiming transport silence.
  node_link: () => (flag("nonode") ? "absent" : "ready"),

  // The browser has no binary to ask, and a real-looking number here would be
  // a lie the moment the crate's version moves. `dev` says which it is.
  app_version: () => "dev",

  connect: (args) => {
    // The one failure retrying cannot fix, in the wording `lib.rs` emits.
    if (flag("wedged")) throw new Error("no video after three streamon attempts - power-cycle the Tello");
    if (flag("nonode")) throw new Error("USB bulk node is not accessible");
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
    window.setTimeout(() => send(notice, { kind: "model", model: "agy/gemini-3.6-flash-low", fellBack: false }), 120);
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
  "Flags: ?demo=person ?demo=marker ?update=1 ?empty=1 ?silent=8 ?stall=6 ?nonode=1 ?wedged=1 ?bat=14",
);

function initDemoUI(): void {
  const demo = demoMode();
  if (demo === null) return;

  window.setTimeout(() => {
    // 1. Switch mode
    const modeBtn = document.querySelector<HTMLButtonElement>(`[data-k="mode-${demo === "person" ? "person" : "aruco"}"]`);
    modeBtn?.click();

    // 2. Timeline
    const timelineList = document.querySelector<HTMLElement>('[data-k="list"]');
    const timelineCount = document.querySelector<HTMLElement>('[data-k="count"]');
    if (timelineList !== null) {
      timelineList.innerHTML = "";
      const events = demo === "person" ? [
        { time: "15:40:12", tag: "LINK", tagCls: "bg-accent text-accent2", desc: "세션 시작 · Tello SDK 2.0 (USB Bulk)" },
        { time: "15:40:15", tag: "CMD", tagCls: "bg-accent text-accent2", desc: "takeoff" },
        { time: "15:40:18", tag: "EXEC", tagCls: "bg-ok text-ok2", desc: "이륙 완료 · 고도 1.18m 호버링" },
        { time: "15:40:22", tag: "MODE", tagCls: "bg-ok text-ok2", desc: "사람 추적 모드 전환 (YOLOv8n)" },
        { time: "15:40:26", tag: "TARGET", tagCls: "bg-ok text-ok2", desc: "Track 3 락온 · 자동 비행 추적 활성화" },
        { time: "15:40:45", tag: "COPILOT", tagCls: "bg-accent text-accent2", desc: "음성 지시 수행 완료 · 목표 추적 유지 중" },
      ] : [
        { time: "15:38:04", tag: "LINK", tagCls: "bg-accent text-accent2", desc: "세션 시작 · Tello SDK 2.0 (USB Bulk)" },
        { time: "15:38:08", tag: "CMD", tagCls: "bg-accent text-accent2", desc: "takeoff" },
        { time: "15:38:12", tag: "EXEC", tagCls: "bg-ok text-ok2", desc: "이륙 완료 · 고도 0.92m 호버링" },
        { time: "15:38:16", tag: "MODE", tagCls: "bg-warn text-warn", desc: "마커 추적 모드 전환 (ARUCO_MIP_36h12)" },
        { time: "15:38:20", tag: "TARGET", tagCls: "bg-ok text-ok2", desc: "ArUco ID 7 락온 (24cm) · 거리 1.2m 유지" },
        { time: "15:38:35", tag: "COPILOT", tagCls: "bg-accent text-accent2", desc: "사용자 지시 완료 · 마커 호버링 유지" },
      ];
      if (timelineCount !== null) timelineCount.textContent = `${events.length} actions`;
      for (const ev of events) {
        const item = document.createElement("div");
        item.className = "relative flex items-start gap-[11px] pb-[10px]";
        item.innerHTML = `
          <div class="absolute left-[5px] top-[14px] bottom-0 w-px bg-[#1F252D]"></div>
          <div class="mt-[4px] h-[11px] w-[11px] flex-none rounded-full border-2 border-[#12161B] ${ev.tagCls.split(" ")[0]}"></div>
          <div class="flex min-w-0 flex-1 flex-col gap-[2px]">
            <div class="flex items-center gap-[6px]">
              <span class="font-mono text-[10px] text-dim3">${ev.time}</span>
              <span class="rounded-[2px] px-[4px] py-[0.5px] font-mono text-[9px] font-semibold ${ev.tagCls}">${ev.tag}</span>
            </div>
            <div class="font-mono text-[11px] leading-[1.5] text-ink2">${ev.desc}</div>
          </div>
        `;
        timelineList.append(item);
      }
    }

    // 3. Copilot Chat
    const chat = document.querySelector<HTMLElement>('[data-k="copilot-chat"]');
    if (chat !== null) {
      chat.innerHTML = "";
      const userText = demo === "person"
        ? "이륙해서 1m 고도 유지하고, 전방에 보이는 사람을 찾아서 자동 추적해줘."
        : "전방에 배치된 ArUco 마커를 감지하고 120cm 거리를 유지하며 호버링해줘.";
      const thinkingTitle = demo === "person"
        ? "상태 확인 및 타겟 락온 계획 수립"
        : "ArUco 마커 감지 및 호버링 거리 제어";
      const thinkingBody = demo === "person"
        ? "1. 배터리 84%, 고도 1.18m (안정 비행 중)\n2. 전방 경로 상 다수 보행자 감지 (총 6명 확인)\n3. 중앙 보행자 Track 3 (신뢰도 92%, 거리 2.1m) 타겟 선정\n4. lock(id: 3) 호출 및 사람 추적 모드 유지"
        : "1. 배터리 79%, 고도 0.92m (안정 비행 중)\n2. 전방 삼각대 장착 ArUco 마커 ID 7 감지 (크기 24cm, 74.5dB)\n3. 현재 거리 1.25m → 목표 거리 120cm 도달\n4. lock(id: 7) 및 TRACK_DIST_GAIN 유지";
      const assistantText = demo === "person"
        ? "이륙 후 전방 2.1m 거리의 보행자(Track 3)를 감지하여 락온을 완료했습니다. 자동 추적 모드를 활성화하여 거리를 유지하며 비행 중입니다. 배터리 잔량은 84%입니다."
        : "전방 삼각대에 부착된 ArUco 마커(ID 7, 24cm)를 인식하여 락온했습니다. 목표 거리 120cm를 유지하며 안정적으로 호버링 비행 중입니다.";
      const chips = demo === "person"
        ? ["observe", "fly takeoff", "set_mode person", "lock 3", "observe", "done"]
        : ["observe", "fly takeoff", "set_mode aruco", "lock 7", "wait 5", "observe", "done"];

      const userRow = document.createElement("div");
      userRow.className = "flex w-full justify-end";
      userRow.innerHTML = `
        <div class="max-w-[82%] rounded-[3px] border border-[rgba(91,200,245,.32)] bg-[rgba(91,200,245,.14)] px-[12px] py-[9px] text-[12.5px] leading-[1.6] text-[#DCEFFA]">
          ${userText}
        </div>`;
      chat.append(userRow);

      const respRow = document.createElement("div");
      respRow.className = "flex w-full flex-col items-start gap-[4px]";
      respRow.innerHTML = `
        <div class="my-[3px] w-full rounded-[2px] border border-line2 bg-key/40">
          <div class="flex w-full items-baseline gap-[6px] px-[7px] py-[4px] text-left">
            <span class="flex-none text-[9px] text-accent">▾</span>
            <span class="flex-none text-[9.5px] tracking-[.12em] text-accent">THINKING</span>
            <span class="min-w-0 flex-1 truncate text-[10px] text-dim3">${thinkingTitle}</span>
          </div>
          <div class="whitespace-pre-wrap break-words px-[9px] pb-[6px] font-mono text-[10px] leading-[1.55] text-dim2">${thinkingBody}</div>
        </div>
        <div class="max-w-[90%] rounded-[3px] border border-[#212832] bg-tile px-[12px] py-[9px] text-left">
          <span class="block whitespace-pre-wrap text-[12.5px] leading-[1.6] text-ink2">${assistantText}</span>
          <span class="mt-[6px] flex flex-wrap items-center gap-[4px]">
            ${chips.map((c) => `<span class="rounded-[2px] border border-line3 bg-key px-[5px] py-[1px] font-mono text-[9px] text-dim2">${c}</span>`).join("")}
          </span>
        </div>`;
      chat.append(respRow);
    }

    // 4. UDP Console
    const consoleBox = document.querySelector<HTMLElement>('[data-k="log"]');
    if (consoleBox !== null) {
      consoleBox.innerHTML = "";
      const lines = demo === "person" ? [
        { time: "15:40:12", kind: "info", text: "AIdrone Station · 15:40:12" },
        { time: "15:40:12", kind: "tx", text: "command" },
        { time: "15:40:12", kind: "rx", text: "ok" },
        { time: "15:40:13", kind: "tx", text: "streamon" },
        { time: "15:40:13", kind: "rx", text: "ok" },
        { time: "15:40:14", kind: "info", text: "session up with painted video in 1420 ms" },
        { time: "15:40:15", kind: "tx", text: "takeoff" },
        { time: "15:40:18", kind: "rx", text: "ok" },
        { time: "15:40:26", kind: "info", text: "[follow] target locked: track 3 (dist 2.1m)" },
        { time: "15:40:40", kind: "tx", text: "rc 2 8 0 4" },
      ] : [
        { time: "15:38:04", kind: "info", text: "AIdrone Station · 15:38:04" },
        { time: "15:38:04", kind: "tx", text: "command" },
        { time: "15:38:04", kind: "rx", text: "ok" },
        { time: "15:38:05", kind: "tx", text: "streamon" },
        { time: "15:38:05", kind: "rx", text: "ok" },
        { time: "15:38:06", kind: "info", text: "session up with painted video in 1310 ms" },
        { time: "15:38:08", kind: "tx", text: "takeoff" },
        { time: "15:38:12", kind: "rx", text: "ok" },
        { time: "15:38:20", kind: "info", text: "[follow] marker 7 locked: size 24cm, target dist 120cm" },
        { time: "15:38:30", kind: "tx", text: "rc 0 4 0 2" },
      ];
      for (const l of lines) {
        const r = document.createElement("div");
        r.className = "flex items-baseline gap-[8px] py-[1px] font-mono text-[11px]";
        r.innerHTML = `<span class="flex-none text-dim3">${l.time}</span><span class="${l.kind === "tx" ? "text-accent" : l.kind === "rx" ? "text-ok" : "text-dim"}">${l.kind === "tx" ? "→ bulk OUT : " : l.kind === "rx" ? "← bulk IN  : " : ""}${l.text}</span>`;
        consoleBox.append(r);
      }
    }
  }, 400);
}

if (typeof window !== "undefined") {
  initDemoUI();
}
