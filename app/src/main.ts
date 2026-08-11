/**
 * Composition root. Wiring only: every byte of drone I/O lives in Rust behind
 * `transport.ts`, every pixel of chrome lives in a screen or a panel, and this
 * file's whole job is to say which of them hears about what.
 *
 * Two rules it enforces that nothing else can:
 *
 * 1. **One logging path.** A command typed into the console, fired by a quick
 *    button, or triggered by a key all go through `runCommand`, so the console
 *    and the timeline can never disagree about what was sent. The exception is
 *    `rc`, which is deliberately never logged - at 10 Hz it would bury every
 *    other line, and the left rail already shows the exact string in flight.
 *
 * 2. **The keyboard belongs here.** Panels expose `keyDown`/`keyUp` and never
 *    touch `window`, because the arbitration - a text field owns its keystrokes,
 *    Ctrl belongs to the shell, everything else falls through to the sticks -
 *    only makes sense with all of it in view.
 */
import type { ControlMode } from "./control-mode.ts";
import { createNativeVisionAdapter, markerMetrics } from "./lib/aruco.ts";
import {
  ARUCO_DESIRED_SIZE,
  createFollowController,
  markerFollow,
  personFollow,
  PERSON_DESIRED_SIZE,
  type FollowReason,
} from "./follow.ts";
import { createMarkerSizes } from "./marker-size.ts";
import { installStageOverlay } from "./overlay.ts";
import { installArucoPanel } from "./panels/aruco.ts";
import { runCopilotTask, type TaskMemory } from "./copilot/agent.ts";
import { createToolExecutor } from "./copilot/execute.ts";
import { installCopilot, type CopilotHooks, type CopilotRun } from "./panels/copilot.ts";
import { installConsole } from "./panels/console.ts";
import { installKeyMap } from "./panels/keymap.ts";
import { installModeSelector } from "./panels/mode-selector.ts";
import { installPersonTracker } from "./panels/person.ts";
import { installTelemetry } from "./panels/telemetry.ts";
import { installTimeline } from "./panels/timeline.ts";
import { VideoRenderer } from "./render.ts";
import { installLanding } from "./screens/landing.ts";
import { installStation, type StationModel } from "./screens/station.ts";
import {
  connect,
  disconnect,
  endpoints,
  onDroneState,
  onFrame,
  onLink,
  onRcError,
  onTelemetry,
  preflight,
  sendCommand,
  sendRc,
  onVision,
  setVisionMode,
  type DroneState,
  type Endpoints,
  type Probe,
  type Telemetry,
  copilotTurn,
} from "./transport.ts";
import { hms, must } from "./ui.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Shell repaint period. Fast enough to watch latency move, slow enough that the
 *  HUD never competes with the paint path for a frame budget. */
const SHELL_HZ_MS = 250;

/** A state datagram older than this means the drone stopped talking even though
 *  the session is still open - the panels blank rather than freeze on a stale
 *  reading, because a frozen number looks exactly like a steady one. */
const STATE_STALE_MS = 2_000;

/** Native `connect()` proves UDP frame batches arrived, not that WebKit decoded
 * one. Do not expose flight controls until the current renderer has painted a
 * real frame; two IDR periods leave room for a transient decoder recovery. */
const FIRST_PAINT_TIMEOUT_MS = 5_000;
const FIRST_PAINT_POLL_MS = 50;

/** Why the loop stopped, in the operator's words, for the action timeline. */
const STOP_REASON: Record<FollowReason, string> = {
  locked: "잠금",
  released: "잠금 해제",
  mode: "모드 변경",
  session: "세션 종료",
  emergency: "비상 정지",
};

const landingRoot = must("#landing", HTMLDivElement);
const stationRoot = must("#station", HTMLDivElement);

// --- session state ---------------------------------------------------------

let renderer: VideoRenderer | null = null;
let busy = false;
let link: Endpoints | null = null;
let probes: Probe[] | null = null;
let probing = false;
let lastTelemetry: Telemetry | null = null;
let rxPktsPerSec: number | null = null;
let prevPkts: number | null = null;
let droneState: DroneState | null = null;
let linkOk = false;
/** True only after the active session has painted a decoded frame. */
let controlsReady = false;
let status = "idle";
let mode: ControlMode = "key";

const appWindow = getCurrentWindow();

// --- screens ---------------------------------------------------------------

const landing = installLanding(landingRoot, {
  onProbe: () => void runProbe(),
  onConnect: () => void doConnect(),
});

const station = installStation(stationRoot, {
  onDisconnect: () => void doDisconnect(),
  onEmergency: () => {
    void runCommand("emergency");
    timeline.push("STOP", "비상 정지 · 모터 즉시 차단");
    emergencyStopped();
  },
  onFullscreen: () => void fullscreen(),
});

// --- panels ----------------------------------------------------------------

const timeline = installTimeline(station.mounts.timeline);
const consolePanel = installConsole(station.mounts.console, { send: (cmd) => void runCommand(cmd) });
const telemetry = installTelemetry(station.mounts.telemetry);
const overlay = installStageOverlay(station.mounts.overlay);
const vision = createNativeVisionAdapter();
/**
 * The only autonomous rc producer, and it is assembled here on purpose: the
 * detector half cannot reach `sendRc`, and this file already owns the single
 * command path, the emergency stop and the mode switch that must all be able
 * to stop it.
 */
const follow = createFollowController({ sendRc });
/** Tags are physical objects that outlive a session, so their sizes persist. */
const markerSizes = createMarkerSizes();
installArucoPanel(station.mounts.aruco, { vision, follow, sizes: markerSizes });
// Clearing a size while that marker is locked must stop the loop, not wait for
// the next frame to notice: the setpoint it was holding no longer exists.
markerSizes.subscribe(() => {
  pushFollowTarget();
});
installPersonTracker(station.mounts.person, { vision, follow });
// The overlay's boxes follow the observation, not the 250 ms shell tick: the
// detectors run well above 4 Hz and sampling them there loses most results.
vision.subscribeAruco((state) => {
  overlay.setAruco(state);
  pushFollowTarget();
});
vision.subscribePerson((state) => {
  overlay.setPerson(state);
  pushFollowTarget();
});
follow.subscribe((state, reason) => {
  overlay.setFollow(state);
  if (renderer !== null) status = statusForMode(mode);
  if (reason === null) return;
  if (reason === "locked") {
    timeline.push("EXEC", `자동 추적 시작 · ${mode === "aruco" ? "ArUco 마커" : "사람"} 대상`);
    consolePanel.push("info", "follow engaged by target lock");
    return;
  }
  timeline.push("STOP", `자동 추적 정지 · ${STOP_REASON[reason]}`);
});

/**
 * Only the selected mode may steer. Both adapters publish on every change, so
 * without this gate an inactive person snapshot would keep releasing the
 * marker lock the operator is actually following.
 *
 * `locked` is the switch and it is deliberately not the same thing as
 * `detected`: a lock whose target is momentarily out of frame keeps the loop
 * engaged and centred, and resumes on its own.
 */
function pushFollowTarget(): void {
  // A native link can have UDP ingress while its decoder has not produced a
  // frame. Never let an early mode change turn a queued observation into RC.
  if (!controlsReady) {
    follow.update(false, null, mode === "person" ? PERSON_DESIRED_SIZE : ARUCO_DESIRED_SIZE);
    return;
  }

  if (mode === "aruco") {
    const state = vision.arucoSnapshot();
    const marker = state.target.state === "detected" ? state.target.marker : null;
    const { following, target, desiredSize } = markerFollow({
      active: state.active,
      locked: state.target.id !== null,
      frameSize: state.frameSize,
      metrics: marker === null ? null : markerMetrics(marker),
      sizeCm: state.target.id === null ? null : markerSizes.get(state.target.id),
    });
    follow.update(following, target, desiredSize);
    return;
  }
  if (mode === "person") {
    // Person mode has no lock: being in the mode IS the switch, and whoever is
    // nearest is the target. The operator arms it by choosing the mode and
    // disarms it by leaving - which is why the mode selector, the emergency
    // stop and the copilot's `set_mode` all stop the loop.
    const { following, target } = personFollow(vision.personSnapshot());
    follow.update(following, target, PERSON_DESIRED_SIZE);
    return;
  }
  follow.update(false, null, ARUCO_DESIRED_SIZE);
}

const keymap = installKeyMap(station.mounts.manual, {
  sendRc,
  sendCommand: (cmd) => void runCommand(cmd),
  // The panel reports STOP for the Escape key and deliberately leaves the
  // sticks alone; zeroing them is the shell's call because the red button in
  // the top bar has to do exactly the same thing.
  onAction: (tag, textLine) => {
    timeline.push(tag, textLine);
    if (tag === "STOP") emergencyStopped();
  },
});

const modeSelector = installModeSelector(station.mounts.mode, {
  mode,
  onModeChange: setMode,
});
const copilot = installCopilot(station.mounts.copilot, {
  run: (instruction, hooks) => startCopilotTask(instruction, hooks),
  ready: () => controlsReady && linkOk,
});

setMode(mode);

/**
 * Motors are cut. Park the sticks so the 10 Hz loop stops immediately and,
 * more importantly, so nothing is left holding a deflection: a drone that
 * re-arms would act on the last `rc` it heard, and that value would be
 * whatever the pilot's hand happened to be doing at the moment they panicked.
 */
function emergencyStopped(): void {
  // Autonomy first: it is the one input that keeps producing rc on its own,
  // and centring the keyboard sticks under a live follow loop would be undone
  // by that loop's very next tick. The copilot is the second such producer -
  // it would otherwise send the next step of a plan into a cut airframe.
  follow.stop("emergency");
  copilot.abort();
  keymap.neutral();
  timeline.push("STOP", "스틱 중립 · 제어 루프 정지");
  status = "EMERGENCY · 모터 차단됨";
}

function statusForMode(selectedMode: ControlMode): string {
  const following = follow.state().phase === "following" || follow.state().phase === "searching";
  switch (selectedMode) {
    case "key":
      return "READY · 키보드 수동 조종";
    case "person":
      return following ? "FOLLOWING · 사람 자동 추적 중" : "READY · Native YOLO26n detector · 잠그면 추적 시작";
    case "aruco":
      return following ? "FOLLOWING · ArUco 자동 추적 중" : "READY · Native ArUco detector · 잠그면 추적 시작";
  }
}

/** A non-manual surface must never leave an invisible RC loop running. */
function setMode(nextMode: ControlMode): void {
  // Before anything else: the loop is steering toward a target that belongs to
  // the mode being left, and a mode switch is never a request to keep flying.
  follow.stop("mode");
  mode = nextMode;
  vision.setMode(mode);
  station.setMode(mode);
  modeSelector.setMode(mode);
  if (mode !== "key") keymap.neutral();
  keymap.setEnabled(controlsReady && mode === "key");
  // The detector may report during the native handshake. Its observations are
  // useful to paint, but cannot select an RC loop before a frame proves the
  // operator can see what it would follow.
  if (controlsReady) {
    status = statusForMode(mode);
    queueVisionMode(mode);
  }
}

/** Serializes detector-mode requests so rapid F2/F3 changes cannot leave an
 * earlier request queued behind the operator's current selection. `key` is the
 * explicit native-detector-off mode; it does not create a flight command. */
let visionModeRequest = Promise.resolve();
let visionModeRevision = 0;

function queueVisionMode(nextMode: ControlMode): void {
  const revision = ++visionModeRevision;
  visionModeRequest = visionModeRequest
    .then(() => {
      if (revision !== visionModeRevision || !controlsReady || renderer === null || mode !== nextMode) return;
      return setVisionMode(nextMode);
    })
    .catch((err: unknown) => {
      if (revision !== visionModeRevision || !controlsReady || renderer === null || mode !== nextMode) return;
      consolePanel.push("err", `!  native vision mode: ${errText(err)}`);
    });
}

// --- the one command path --------------------------------------------------

/** Sends one SDK string and logs both halves. Everything that talks to the drone
 *  except `rc` comes through here. */
type CommandResult = {
  readonly status: "succeeded" | "failed" | "unconfirmed";
  readonly detail: string;
};

/**
 * The copilot's hands. Every entry point below is one an operator already has,
 * so the model gains reach, not privilege: it cannot bypass the command path,
 * the mode switch, or the follow controller's own refusals.
 */
const copilotTools = createToolExecutor({
  command: (cmd) => runCommand(cmd),
  neutral: () => keymap.neutral(),
  setMode: (next) => {
    setMode(next);
  },
  currentMode: () => mode,
  vision,
  follow,
  droneState: () => ({
    battery: droneState?.bat ?? null,
    heightCm: droneState?.h ?? null,
    flightSeconds: droneState?.time ?? null,
  }),
  wait: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
});

/**
 * What the copilot remembers between tasks: the last few instructions and how
 * they turned out, nothing else.
 *
 * Bounded because every remembered exchange is re-sent on every turn of the
 * next task, so an unbounded transcript pays for itself twice - once in
 * latency against a provider that already takes seconds, and once in a model
 * that starts re-running plans it can still see. Five is enough for "그 마커
 * 다시 찾아줘" and short enough to stay honest.
 */
const COPILOT_MEMORY = 5;
const copilotMemory: TaskMemory[] = [];

/** Starts one copilot task. The panel owns the UI; this owns the wiring. */
function startCopilotTask(instruction: string, hooks: CopilotHooks): CopilotRun {
  let cancelled = false;
  timeline.push("CMD", `코파일럿 · ${instruction}`);

  const done = runCopilotTask(
    instruction,
    {
    turn: (body) =>
      copilotTurn(body, (notice) => {
        hooks.onNotice(notice);
        // Worth a timeline row: an unexplained minute of hover is the kind of
        // thing an operator reconstructs afterwards and cannot account for.
        if (notice.kind === "waiting") timeline.push("CMD", `모델 쿼터 대기 · ${Math.ceil(notice.seconds)}초`);
        // And which model flew it, but only when it was not the first choice.
        if (notice.kind === "model" && notice.fellBack) timeline.push("CMD", `모델 폴백 · ${notice.model}`);
      }),
    run: (call) => copilotTools.run(call),
    observe: () => copilotTools.observe(),
    onStep: (step) => {
      hooks.onStep(step);
      if (step.state === "ok") timeline.push("EXEC", `${step.label}${step.detail === undefined ? "" : ` · ${step.detail}`}`);
      if (step.state === "failed") timeline.push("CMD", `실패 · ${step.label} · ${step.detail ?? ""}`);
    },
    onActivity: (activity) => {
      hooks.onActivity(activity);
      // Only the re-asks are worth a timeline row. A first ask is just the
      // model thinking; a second means the backend dropped the tool schema,
      // and that is the line that explains a flight's missing twenty seconds.
      if (activity.kind === "thinking" && activity.attempt > 1) {
        timeline.push("CMD", `도구 응답 없음 · 재요청 ${activity.attempt}/${activity.of}`);
      }
    },
      cancelled: () => cancelled,
      sleep: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
    },
    { history: [...copilotMemory] },
  ).then((outcome) => {
    timeline.push("CMD", `코파일럿 종료 · ${outcome.summary}`);
    // Remembered only once it has an outcome: a cancelled or crashed task has
    // nothing true to say about what the drone did.
    copilotMemory.push({ instruction, summary: outcome.summary });
    if (copilotMemory.length > COPILOT_MEMORY) copilotMemory.shift();
    return outcome;
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      keymap.neutral();
    },
  };
}

async function runCommand(cmd: string): Promise<CommandResult> {
  consolePanel.push("tx", `→  ${cmd}`);
  try {
    const reply = await sendCommand(cmd);
    consolePanel.push("rx", `←  ${reply}`);
    return {
      status: reply.trim().toLowerCase() === "ok" ? "succeeded" : "failed",
      detail: `${cmd} → ${reply}`,
    };
  } catch (err) {
    const detail = errText(err);
    consolePanel.push("err", `!  ${detail}`);
    return { status: "failed", detail: `${cmd} · ${detail}` };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- subscriptions ---------------------------------------------------------
// Registered once for the life of the window. The renderer is what comes and
// goes, so a late frame after disconnect lands on a null and is dropped.

onFrame((data, recvEpochUs) => renderer?.push(data, recvEpochUs));

onTelemetry((t) => {
  rxPktsPerSec = prevPkts === null ? null : Math.max(0, t.pkts - prevPkts);
  prevPkts = t.pkts;
  lastTelemetry = t;
});

onDroneState((s) => {
  droneState = s;
  // The drone's own answer to "am I off the ground". Height is the direct
  // reading; motor-on seconds catches the moment before it has climbed.
  const height = s.h ?? 0;
  const motorSeconds = s.time ?? 0;
  follow.setAirborne(height > 0 || motorSeconds > 0);
});

/**
 * `rc` is fire-and-forget, so a rejected invoke is the only evidence that the
 * sticks are not reaching Rust at all. Rate-limited: at 10 Hz an unthrottled
 * report would bury the console under its own diagnosis.
 */
let lastRcErrorAt = 0;
onRcError((message) => {
  const now = Date.now();
  if (now - lastRcErrorAt < 2_000) return;
  lastRcErrorAt = now;
  consolePanel.push("err", `!  rc: ${message}`);
});

onLink((e) => {
  // A recovered native link only says UDP frames arrived. It does not say
  // WebKit decoded them, so it cannot reopen the controls during the paint
  // gate.
  linkOk = controlsReady && e.kind === "recovered";
  if (e.kind === "silent") {
    timeline.push("LINK", `영상이 ${e.seconds}초째 도착하지 않습니다`);
    consolePanel.push("err", `!  video silent ${e.seconds}s`);
  } else {
    timeline.push("LINK", "영상 수신 복구");
    consolePanel.push("info", "video recovered");
  }
});

onVision((event) => {
  vision.accept(event);
});

// --- landing ---------------------------------------------------------------

function paintLanding(): void {
  landing.update({
    endpoints: link,
    probing,
    probes,
    connecting: busy,
    hint: busy
      ? "핸드셰이크 · streamoff → streamon → 영상 흐름 확인"
      : link === null
        ? "엔드포인트를 읽는 중…"
        : "노드와 드론의 전원을 먼저 확인하세요",
  });
}

async function runProbe(): Promise<void> {
  if (probing || busy) return;
  probing = true;
  probes = null;
  paintLanding();
  landing.log(`[probe] 소켓 세 개와 드론 응답을 확인합니다`);
  try {
    probes = await preflight();
    for (const p of probes) landing.log(`[${p.ok ? "ok " : "err"}] ${p.label} · ${p.detail}`);
  } catch (err) {
    landing.log(`[err] preflight: ${errText(err)}`);
    probes = [];
  } finally {
    probing = false;
    paintLanding();
  }
}

/** Why the picture never arrived, in the terms the next fix needs.
 *
 * "no decoder output" alone cost a full round of guessing once already: it
 * cannot tell a WebView with no H.264 decoder at all (WebKitGTK without
 * `gstreamer1.0-libav`) from one that took the stream and broke on it (a
 * hardware GStreamer element that cannot hold this SPS). `isConfigSupported`
 * on the exact configuration in force answers that in one line, and it runs
 * only here - the failure path - so a healthy connect pays nothing. */
async function firstPaintFailure(candidate: VideoRenderer): Promise<string> {
  const stats = candidate.stats();
  const detail = stats.lastError === null ? "no decoder output" : `decoder: ${stats.lastError}`;
  const config = candidate.decoderConfiguration();
  if (config === null) return `${detail}; decoder never configured (no SPS/IDR in the stream yet)`;

  let supported: string;
  try {
    supported = String((await VideoDecoder.isConfigSupported(config)).supported);
  } catch (err) {
    supported = `probe failed: ${errText(err)}`;
  }
  return `${detail}; codec ${config.codec}, isConfigSupported=${supported}`;
}

/** Waits for the last connection boundary: a real decoded frame on this
 * canvas. The native handshake has already proved UDP ingress by this point,
 * but a missing WebKit/GStreamer decoder would otherwise look connected and
 * leave an operator with controls over a black display. */
async function waitForFirstPaint(candidate: VideoRenderer): Promise<void> {
  const deadline = performance.now() + FIRST_PAINT_TIMEOUT_MS;
  for (;;) {
    const stats = candidate.stats();
    if (stats.painted > 0) return;

    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error(
        `video did not paint within ${FIRST_PAINT_TIMEOUT_MS} ms (${await firstPaintFailure(candidate)})`,
      );
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(FIRST_PAINT_POLL_MS, remaining)));
  }
}

async function doConnect(): Promise<void> {
  if (busy || renderer !== null) return;
  busy = true;
  // A task created by the previous session must not reach the newly live
  // native worker while this connection is still waiting on a decoded frame.
  controlsReady = false;
  linkOk = false;
  visionModeRevision++;
  copilot.abort();
  keymap.setEnabled(false);
  consolePanel.setEnabled(false);
  paintLanding();

  let nativeSessionStarted = false;
  const t0 = performance.now();
  landing.log(`[link] connect() · ${link?.tello ?? "?"}`);
  try {
    // Built before the await: Rust starts pushing frames the instant the
    // handshake completes, and a renderer created afterwards drops the head of
    // the stream - the SPS/PPS the decoder cannot start without.
    renderer = new VideoRenderer(station.canvas);
    // The native worker can publish a status before `connect` resolves, so the
    // adapter is armed before IPC starts and cleared again on any failure.
    vision.setSessionLive(true);
    await connect();
    nativeSessionStarted = true;
    // Show the station as soon as frames are flowing, not after the first one
    // paints: decode start-up is seconds on a cold link, and a landing screen
    // that sits still for that long reads as a hang. Controls stay disabled
    // until the frame has actually painted below, and the catch puts the
    // landing screen back if it never does.
    showStation(true);
    landing.log("[link] native video flow confirmed · waiting for canvas paint");
    await waitForFirstPaint(renderer);

    const ms = Math.round(performance.now() - t0);
    landing.log(`[link] session up · video painted (${ms} ms)`);
    controlsReady = true;
    linkOk = true;
    status = statusForMode(mode);
    queueVisionMode(mode);
    timeline.push("LINK", `세션 시작 · ${link?.tello ?? ""} · Tello SDK 2.0`);
    consolePanel.push("info", `session up with painted video in ${ms} ms`);
    keymap.setEnabled(mode === "key");
    consolePanel.setEnabled(true);
  } catch (err) {
    // This runs while the native session is still present, so stopping a live
    // follow loop can deliver its neutral RC before disconnect tears sockets
    // down. Every producer stays closed even if a stale copilot turn wakes.
    controlsReady = false;
    linkOk = false;
    visionModeRevision++;
    copilot.abort();
    follow.stop("session");
    keymap.setEnabled(false);
    consolePanel.setEnabled(false);
    if (nativeSessionStarted) {
      try {
        await disconnect();
      } catch (cleanupErr) {
        landing.log(`[err] video-start cleanup: ${errText(cleanupErr)}`);
      }
    }
    renderer?.close();
    renderer = null;
    vision.setSessionLive(false);
    showStation(false);
    landing.log(`[err] ${errText(err)}`);
    status = "idle";
    busy = false;
    paintLanding();
  }
}

async function doDisconnect(): Promise<void> {
  if (busy || renderer === null) return;
  busy = true;
  controlsReady = false;
  linkOk = false;
  visionModeRevision++;
  copilot.abort();
  // Autonomy, then sticks: the drone keeps flying on the last rc it heard, and
  // the session teardown below is the point at which nothing is left to send
  // one.
  follow.stop("session");
  keymap.neutral();
  keymap.setEnabled(false);
  // The copilot forgets with the session. Its memory is a list of things that
  // happened to a drone that is about to stop existing; carrying it into the
  // next flight would hand the model confident history about an airframe it
  // has never seen.
  copilotMemory.length = 0;
  consolePanel.setEnabled(false);
  try {
    await disconnect();
    timeline.push("LINK", "세션 종료");
    landing.log("[link] 세션 종료");
  } catch (err) {
    consolePanel.push("err", `!  ${errText(err)}`);
  } finally {
    renderer?.close();
    renderer = null;
    droneState = null;
    lastTelemetry = null;
    prevPkts = null;
    rxPktsPerSec = null;
    status = "idle";
    linkOk = false;
    busy = false;
    showStation(false);
    paintLanding();
  }
}

function showStation(on: boolean): void {
  landingRoot.style.display = on ? "none" : "flex";
  stationRoot.style.display = on ? "flex" : "none";
}

// --- fullscreen ------------------------------------------------------------

/**
 * `"toggle"` asks the window rather than flipping a local flag: fullscreen can
 * also be left through the shell, and a mirrored flag would drift out of step
 * with the only copy that matters.
 *
 * Escape is deliberately NOT bound to "leave fullscreen" any more. On this
 * screen Escape is the motor cut, it is printed on the key map that way, and a
 * key that means "get me out of this window" in one mode and "stop the props
 * mid-air" in another is the kind of overload that breaks an airframe. `f`
 * toggles, both ways, and is the only fullscreen control.
 */
async function fullscreen(): Promise<void> {
  try {
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
  } catch (err) {
    consolePanel.push("err", `!  fullscreen: ${errText(err)}`);
  }
}

// --- keyboard --------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.code === "KeyB") {
      e.preventDefault();
      station.toggleLeft();
    } else if (e.code === "KeyJ") {
      e.preventDefault();
      station.toggleBottom();
    }
    return;
  }
  // A text field owns every keystroke aimed at it - including Escape, which
  // must never reach the motor cut from inside the command box.
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.altKey) return;

  if (e.code === "KeyF") {
    e.preventDefault();
    void fullscreen();
    return;
  }
  if (renderer === null) return;
  if (keymap.keyDown(e.code)) e.preventDefault();
});

window.addEventListener("keyup", (e) => keymap.keyUp(e.code));

// Leaving the window with a stick held would latch that stick: the browser
// never delivers the keyup, and the 10 Hz loop keeps repeating the last value.
window.addEventListener("blur", () => keymap.neutral());

// --- shell repaint ---------------------------------------------------------

setInterval(() => {
  if (renderer === null) return;

  const stats = renderer.stats();
  const fresh =
    droneState !== null && Date.now() * 1000 - droneState.recvEpochUs < STATE_STALE_MS * 1000
      ? droneState
      : null;

  const videoLive = linkOk && stats.painted > 0;
  const model: StationModel = {
    mode,
    live: videoLive,
    node: link?.node ?? "--",
    tello: link?.tello ?? "--",
    rttMs: stats.latencyP50Ms,
    bat: fresh?.bat ?? null,
    flightS: fresh?.time ?? null,
    status,
    rxPktsPerSec,
    mbps: lastTelemetry?.mbps ?? null,
    gapMaxMs: lastTelemetry?.gapMaxMs ?? null,
    dropped: stats.droppedOnBacklog,
    linkOk,
  };
  station.update(model);
  telemetry.update(fresh, { fps: stats.displayedFps });
  overlay.update({
    state: fresh,
    live: videoLive,
    linkFps: lastTelemetry?.fps ?? 0,
    linkMbps: lastTelemetry?.mbps ?? 0,
    width: stats.width,
    height: stats.height,
    mode,
  });
}, SHELL_HZ_MS);

// --- boot ------------------------------------------------------------------

keymap.setEnabled(false);
consolePanel.setEnabled(false);
paintLanding();
landing.log(`[boot] AIdrone Station · ${hms()}`);

void (async () => {
  try {
    link = await endpoints();
    consolePanel.setPeer(link.tello);
    landing.log(`[cfg] command  ${link.tello}`);
    landing.log(`[cfg] state    ${link.state}`);
    landing.log(`[cfg] video    ${link.video}`);
    landing.log(`[cfg] node     ${link.node}`);
  } catch (err) {
    landing.log(`[err] endpoints: ${errText(err)}`);
  }
  paintLanding();
})();
