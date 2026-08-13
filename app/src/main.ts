// Browser-first UI work: with no Tauri underneath, install the fake IPC before
// anything imports the transport, and the whole app runs against a mock drone
// with Vite's hot reload.
//
// Dynamic on purpose, and the one place in this app that is: `import.meta.env.DEV`
// is a build-time constant, so this branch - and the mock behind it - is dropped
// from a release bundle entirely. A static import would ship a fake drone inside
// the real app.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  await import("./dev/tauri-mock.ts");
}

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
import { installStation, type LinkView, type StationModel } from "./screens/station.ts";
import {
  connect,
  disconnect,
  endpoints,
  nodeLink,
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
  type NodeLink,
  type Telemetry,
  copilotTurn,
  updateApply,
  updateCheck,
  type AvailableUpdate,
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
  paused: "일시 정지",
  resumed: "추적 재개",
};

const stationRoot = must("#station", HTMLDivElement);

// --- session state ---------------------------------------------------------

let renderer: VideoRenderer | null = null;
let busy = false;
let link: Endpoints | null = null;
let lastTelemetry: Telemetry | null = null;
let rxPktsPerSec: number | null = null;
let prevPkts: number | null = null;
let droneState: DroneState | null = null;
let linkOk = false;
/** True only after the active session has painted a decoded frame. */
let controlsReady = false;
let status = "idle";
let mode: ControlMode = "key";
/** The newer build GitHub is offering, once asked; null while current. */
let pendingUpdate: AvailableUpdate | null = null;
let updateApplying = false;
let updateError: string | null = null;

const appWindow = getCurrentWindow();

// --- screens ---------------------------------------------------------------

const station = installStation(stationRoot, {
  onUpdate: () => void applyUpdate(),
  onEmergency: () => flightCommand("emergency"),
  onFullscreen: () => void fullscreen(),
  onTakeoff: () => flightCommand("takeoff"),
  onLand: () => flightCommand("land"),
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
  // A resume is a start, not a stop. Routing it below would have the timeline
  // read "자동 추적 정지 · 추적 재개", which is the opposite of what happened.
  if (reason === "locked" || reason === "resumed") {
    timeline.push("EXEC", `자동 추적 ${reason === "locked" ? "시작" : "재개"} · ${mode === "aruco" ? "ArUco 마커" : "사람"} 대상`);
    consolePanel.push("info", reason === "locked" ? "follow engaged by target lock" : "follow resumed");
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
  onCommand: flightCommand,
  onAction: (textLine) => timeline.push("CMD", textLine),
  // The keyboard is live in every mode, so it and the follow loop share one
  // `rc` channel. This is the handover: while a stick is held the loop goes
  // quiet, and it takes the wire straight back on release.
  onOverride: (active) => follow.setOverride(active),
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
  //
  // Only on an actual change. `stop` latches now whether or not anything is
  // locked, so firing it on the boot call - which sets the initial mode rather
  // than leaving one - opened the app with autonomy already halted and the
  // operator having to resume something they never stopped.
  if (nextMode !== mode) follow.stop("mode");
  mode = nextMode;
  vision.setMode(mode);
  station.setMode(mode);
  modeSelector.setMode(mode);
  // The keyboard is live in every mode. It used to be manual-mode only, which
  // meant an operator watching an autonomous chase go wrong had to change mode
  // before they could touch the sticks. Now it intervenes on the spot and the
  // loop resumes when they let go - see `onOverride` above. No `neutral()` on
  // the way out of a mode either: that would centre sticks the operator may be
  // holding right now.
  keymap.setEnabled(controlsReady);
  // The detector may report during the native handshake. Its observations are
  // useful to paint, but cannot select an RC loop before a frame proves the
  // operator can see what it would follow.
  if (controlsReady) {
    status = statusForMode(mode);
    queueVisionMode(mode);
  }

  // No marker is pre-selected. The roster starts empty and says so; a marker
  // joins it by being detected or by being drawn, and the operator picks one.
  // The selection then survives every later mode change, so this is a choice
  // made once rather than a default guessed for them.
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

/**
 * Every command with both a key and a button behind it. One function, so the two
 * surfaces cannot drift into sending different things or naming the same action
 * two different ways.
 *
 * `emergency` is not a landing - the motors stop and the airframe drops from
 * wherever it is - so it reports as a stop and stands the follow loop down.
 */
function flightCommand(cmd: "takeoff" | "land" | "emergency"): void {
  void runCommand(cmd);
  if (cmd === "emergency") {
    timeline.push("STOP", "비상 정지 · 모터 즉시 차단");
    emergencyStopped();
    return;
  }
  timeline.push("CMD", cmd === "takeoff" ? "이륙 명령 전송" : "착륙 명령 전송");
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
  // What `link.rs` saw on the wire, and nothing more. It does NOT decide
  // whether there is a picture: a silence report arrived once while frames
  // were painting at 30 fps and blanked the canvas behind the hatch. The
  // supervisor owns that verdict, keyed on painted frames; this only fills the
  // status bar's LINK cell. Guarded on the phase so an event from a session
  // already torn down cannot mark a fresh one silent.
  if (phase === "online") linkOk = e.kind === "recovered";
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

// --- self-update -----------------------------------------------------------

/**
 * Replaces this build with the newer one and restarts.
 *
 * The installer replaces the binary underneath a running process, so nothing
 * may be in flight - least of all a drone. With the landing screen gone, that
 * guarantee is no longer a matter of which screen you are on: the offer is
 * only rendered while the link is down (`updateView()`), and this refuses
 * again here so a stale click during a reconnect cannot get through.
 */
async function applyUpdate(): Promise<void> {
  if (pendingUpdate === null || updateApplying || phase !== "offline") return;
  updateApplying = true;
  updateError = null;
  consolePanel.push("info", `update: ${pendingUpdate.asset} 내려받는 중 (${Math.round(pendingUpdate.size / 1e6)} MB)`);
  try {
    const staged = await updateApply(pendingUpdate);
    // Rust exits the process on success, so reaching here means either the
    // handoff returned without replacing anything, or this is a dry run.
    consolePanel.push(
      "info",
      staged === null ? "update: 설치 프로그램에 넘겼습니다 · 곧 재시작됩니다" : `update: 검증 완료 (설치는 건너뜀) · ${staged}`,
    );
  } catch (err) {
    updateApplying = false;
    updateError = errText(err);
    consolePanel.push("err", `!  update: ${updateError}`);
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

// --- the connection supervisor ---------------------------------------------

/**
 * The link keeps itself up. There is no connect button and no landing screen,
 * because there was never a decision to make: every launch ended with the
 * operator pressing the same button until a picture appeared.
 *
 * **A picture is the definition of connected.** Not a resolved handshake, not
 * UDP arriving - those can all be true while the operator stares at a black
 * canvas, which is the failure this app has hit most. So `online` means frames
 * are painting, and the moment they stop for `PICTURE_STALL_MS` the session is
 * torn down and dialled again. `link.rs`'s own silence event is a symptom
 * report, not the verdict; the verdict is `stats.painted`.
 */
const RETRY_MIN_MS = 1_500;
const RETRY_MAX_MS = 8_000;
/** Two seconds of a 30 fps stream is sixty missing frames - long past any
 *  jitter the decoder smooths over, and short enough that a reconnect starts
 *  while the operator is still looking at the last good frame. */
const PICTURE_STALL_MS = 2_000;
/** Three failures in a row stops being a slow drone and starts being a setup
 *  problem, which is what the socket probes answer. */
const PROBE_AFTER_FAILURES = 3;

/**
 * The one failure retrying cannot fix. `ensure_stream_flowing` gives up with
 * this wording after `command` succeeded and three `streamoff`/`streamon`
 * cycles produced no frames - the drone is answering and still not streaming,
 * which on a Tello needs its power cycled. Matched on the phrase Rust already
 * emits rather than a new error code, so the two cannot drift apart silently:
 * the regression is `lib.rs`'s own string.
 */
const WEDGED = /power-cycle the Tello/;

/** How often the node's adapter is re-checked while offline. It is a route
 *  lookup, not a packet, but there is no reason to ask at the shell's 4 Hz. */
const NODE_POLL_MS = 1_000;

/**
 * The failure, in the terms of the thing an operator has to go and touch. The
 * node's two down states get two different sentences: that distinction is the
 * whole reason `node_link` is three-valued.
 *
 * `link-down` names a specific wedge, and the sentence has been rewritten three
 * times because the remedy kept turning out to be wrong. The full ladder is in
 * the README; measured against a live wedge, ALL of these failed:
 * `Restart-NetAdapter`, a 3 s and a 12 s USB detach, a device reflash, a
 * changed MAC, a different physical port, `Disable`/`Enable-PnpDevice`, and
 * `pnputil /remove-device` on the NCM function itself.
 *
 * What works, verified: removing the composite **parent** node, which is the
 * only action that makes PnP build a new adapter instance rather than rebinding
 * the poisoned one. The wedge lives in that instance - a rebuilt adapter came up
 * `Up / Connected / 12 Mbps` on the spot, with no reboot. `nic-rebuild.ps1`
 * climbs the whole ladder and ends there, so the sentence can name one thing.
 */
function diagnose(why: string): string {
  if (nodeLinkState === "absent") return "노드가 연결되어 있지 않습니다 · USB 케이블을 확인하세요";
  if (nodeLinkState === "link-down") {
    return "노드 링크가 끊겼습니다 · desktop\\nic-rebuild.ps1 을 실행하세요 (재부팅 불필요)";
  }
  if (WEDGED.test(why)) return "드론이 응답하지만 영상을 보내지 않습니다 · 드론 전원을 껐다 켜세요";
  return why;
}

let phase: LinkView["phase"] = "offline";
let detail = "";
let failures = 0;
let retryAt = 0;
/** Painted-frame count and when it last moved - the stall detector's whole
 *  state, and the reason this needs no timer of its own. */
let lastPainted = 0;
let lastPaintedAt = 0;
/** The node's adapter, as Rust last reported it. Polled while there is no
 *  picture; while online it is provably `ready`, because the picture is coming
 *  through it. */
let nodeLinkState: NodeLink = "absent";
let nodeCheckedAt = 0;
/** True only when the drone has actually answered this session. Never `false`
 *  while the node is not ready - see `LinkView`. */
let droneUp = false;

function setPhase(next: LinkView["phase"], why: string): void {
  phase = next;
  detail = why;
}

/** The two peers as the shell shows them. `online` is proof of both: frames
 *  are painting, and they came through the node from the drone. */
function linkView(): LinkView {
  if (phase === "online") return { phase, node: "ready", drone: true, detail };
  const ready = nodeLinkState === "ready";
  return { phase, node: nodeLinkState, drone: ready ? droneUp : null, detail };
}

/** What the top bar renders. Split out because the offer is gated on the link,
 *  not on a screen: an installer must never run with a drone in the air. */
function updateView(): StationModel["update"] {
  if (pendingUpdate === null || phase !== "offline") return null;
  return { version: pendingUpdate.version, applying: updateApplying, error: updateError };
}

/** Tears the session down and leaves the supervisor offline. Safe to call with
 *  nothing running, which is what makes it usable from both the failure path
 *  and the stall path. */
async function teardown(why: string): Promise<void> {
  controlsReady = false;
  linkOk = false;
  visionModeRevision++;
  copilot.abort();
  // Autonomy, then sticks: the drone keeps flying on the last rc it heard, and
  // this is the point past which nothing is left to send another.
  follow.stop("session");
  keymap.neutral();
  keymap.setEnabled(false);
  consolePanel.setEnabled(false);
  if (renderer !== null) {
    try {
      await disconnect();
    } catch (err) {
      consolePanel.push("err", `!  disconnect: ${errText(err)}`);
    }
    renderer.close();
    renderer = null;
  }
  vision.setSessionLive(false);
  droneState = null;
  lastTelemetry = null;
  prevPkts = null;
  rxPktsPerSec = null;
  status = "idle";
  setPhase("offline", why);
}

async function attempt(): Promise<void> {
  busy = true;
  setPhase("connecting", "핸드셰이크 · streamoff → streamon → 영상 흐름 확인");
  const t0 = performance.now();
  let started = false;
  try {
    // Built before the await: Rust starts pushing frames the instant the
    // handshake completes, and a renderer created afterwards drops the head of
    // the stream - the SPS/PPS the decoder cannot start without.
    renderer = new VideoRenderer(station.canvas);
    // The native worker can publish a status before `connect` resolves, so the
    // adapter is armed before IPC starts and cleared again on any failure.
    vision.setSessionLive(true);
    await connect();
    started = true;
    await waitForFirstPaint(renderer);

    const ms = Math.round(performance.now() - t0);
    failures = 0;
    controlsReady = true;
    linkOk = true;
    nodeLinkState = "ready";
    droneUp = true;
    lastPainted = renderer.stats().painted;
    lastPaintedAt = performance.now();
    status = statusForMode(mode);
    queueVisionMode(mode);
    setPhase("online", "");
    timeline.push("LINK", `세션 시작 · Tello SDK 2.0`);
    consolePanel.push("info", `session up with painted video in ${ms} ms`);
    keymap.setEnabled(true);
    consolePanel.setEnabled(true);
  } catch (err) {
    failures++;
    const why = errText(err);
    if (!started) renderer?.close();
    if (started) {
      await teardown(why);
    } else {
      renderer = null;
      vision.setSessionLive(false);
    }
    // Which of the two failed, asked rather than guessed: the node is an
    // adapter this host either holds a usable address on or does not, and only
    // if it does can "the drone did not answer" mean anything.
    nodeLinkState = await nodeLink().catch<NodeLink>(() => "absent");
    droneUp = false;
    setPhase("offline", diagnose(why));
    consolePanel.push("err", `!  connect: ${why}`);
    // A drone the handshake has given up on does not come back by being asked
    // faster - it needs hands on it - so that one failure goes straight to the
    // ceiling instead of climbing there over four more attempts.
    const wait = WEDGED.test(why) ? RETRY_MAX_MS : Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    retryAt = performance.now() + wait;
    // Awaited here, inside the `busy` hold, so the supervisor cannot start the
    // next attempt while preflight has the three sockets open.
    if (failures === PROBE_AFTER_FAILURES && nodeLinkState === "ready") await probeSockets();
  } finally {
    busy = false;
  }
}

/** Only ever called with `busy` held and no session: `preflight` binds the
 *  same three sockets a live link owns and would otherwise report AddrInUse
 *  against ourselves. */
async function probeSockets(): Promise<void> {
  if (renderer !== null) return;
  try {
    for (const p of await preflight()) {
      consolePanel.push(p.ok ? "info" : "err", `${p.ok ? "" : "!  "}probe ${p.label} · ${p.detail}`);
    }
  } catch (err) {
    consolePanel.push("err", `!  preflight: ${errText(err)}`);
  }
}

/**
 * One supervisor step, driven by the shell tick so there is no second clock to
 * keep in step with the repaint that renders its decisions.
 */
function superviseLink(): void {
  // The node chip moves whether or not an attempt is in flight. While online
  // the picture proves the node, and during a failed attempt - which can take
  // seconds against a dead drone - a stale reading here is the difference
  // between "check the cable" and "power-cycle the drone".
  if (phase !== "online") pollNode();
  if (busy || updateApplying) return;
  if (phase === "online") {
    if (renderer === null) {
      setPhase("offline", "렌더러 없음");
      return;
    }
    const painted = renderer.stats().painted;
    const now = performance.now();
    if (painted !== lastPainted) {
      lastPainted = painted;
      lastPaintedAt = now;
      return;
    }
    if (now - lastPaintedAt < PICTURE_STALL_MS) return;
    const stalled = Math.round((now - lastPaintedAt) / 100) / 10;
    timeline.push("LINK", `영상 정지 ${stalled}초 · 재연결`);
    consolePanel.push("err", `!  picture stalled ${stalled}s - reconnecting`);
    void teardown(`영상이 ${stalled}초간 멈춰 재연결합니다`).then(() => {
      failures = 0;
      retryAt = performance.now();
    });
    return;
  }
  if (phase !== "offline") return;
  if (performance.now() >= retryAt) void attempt();
}

/** Rate-limited, and never while a session is up: the picture is the proof
 *  then, and the adapter list would just be work nobody reads. */
function pollNode(): void {
  const now = performance.now();
  if (now - nodeCheckedAt < NODE_POLL_MS) return;
  nodeCheckedAt = now;
  void nodeLink()
    .then((next) => {
      // A node that has just become usable makes the current backoff pointless:
      // it was counting down against a host with no link at all. `link-down`
      // does NOT collapse it - the adapter is there and still cannot carry a
      // packet, so retrying sooner would only fail sooner.
      if (next === "ready" && nodeLinkState !== "ready") retryAt = Math.min(retryAt, performance.now());
      nodeLinkState = next;
    })
    .catch(() => {
      nodeLinkState = "absent";
    });
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
  superviseLink();
  // Without a session there is still a shell to paint: the link chip and the
  // hatch are the only things on screen that mean anything while offline, and
  // they are exactly what the supervisor just changed.
  const stats = renderer?.stats() ?? null;
  const fresh =
    droneState !== null && Date.now() * 1000 - droneState.recvEpochUs < STATE_STALE_MS * 1000
      ? droneState
      : null;

  // A picture on screen is exactly `phase === "online"`, and the supervisor
  // maintains that from painted frames. Deriving it from `linkOk` instead put
  // the hatch over a live 30 fps canvas the first time the wire went quiet.
  const videoLive = phase === "online";
  const model: StationModel = {
    ipcMs: stats?.transportP50Ms ?? null,
    decodeMs: stats?.decodeMs ?? null,
    fps: stats?.displayedFps ?? null,
    mode,
    live: videoLive,
    link: linkView(),
    rttMs: stats?.latencyP50Ms ?? null,
    bat: fresh?.bat ?? null,
    flightS: fresh?.time ?? null,
    status,
    rxPktsPerSec,
    mbps: lastTelemetry?.mbps ?? null,
    gapMaxMs: lastTelemetry?.gapMaxMs ?? null,
    dropped: stats?.droppedOnBacklog ?? null,
    linkOk,
    update: updateView(),
  };
  station.update(model);
  telemetry.update(fresh);
  overlay.update({
    state: fresh,
    live: videoLive,
    width: stats?.width ?? 0,
    height: stats?.height ?? 0,
    mode,
  });
}, SHELL_HZ_MS);

// --- boot ------------------------------------------------------------------

keymap.setEnabled(false);
consolePanel.setEnabled(false);
consolePanel.push("info", `AIdrone Station · ${hms()}`);

// The supervisor dials as soon as the tick starts; this only names the peer
// the console prints beside its traffic, so a failure here costs a log line
// and nothing else.
void (async () => {
  try {
    link = await endpoints();
    consolePanel.setPeer(link.tello);
  } catch (err) {
    consolePanel.push("err", `!  endpoints: ${errText(err)}`);
  }
})();

// A launcher that cannot reach GitHub must still fly a drone, so this failure
// is a log line and nothing more.
void (async () => {
  try {
    pendingUpdate = await updateCheck();
    if (pendingUpdate !== null) consolePanel.push("info", `update: 새 버전 ${pendingUpdate.version} · ${pendingUpdate.asset}`);
  } catch (err) {
    consolePanel.push("info", `update: 확인 실패 · ${errText(err)}`);
  }
})();
