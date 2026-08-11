/**
 * Turns a decoded tool call into an action, using **only** paths a button
 * already uses: the one command path, the mode switch, the vision adapter's
 * target selection, and the follow controller. The copilot therefore cannot
 * reach the drone in any way the operator cannot, and every command it sends
 * still lands in the console and the timeline like any other.
 */
import type { ControlMode } from "../control-mode.ts";
import type { NativeVisionAdapter } from "../lib/aruco.ts";
import { markerMetrics } from "../lib/aruco.ts";
import type { FollowController } from "../follow.ts";
import type { DroneScene } from "./agent.ts";
import type { ToolCall } from "./tools.ts";

export type CommandOutcome = Readonly<{ status: "succeeded" | "failed" | "unconfirmed"; detail: string }>;

export interface ExecutorDeps {
  /** The single SDK path. */
  command: (cmd: string) => Promise<CommandOutcome>;
  /** Centres the sticks, exactly as the STOP button does. */
  neutral: () => void;
  setMode: (mode: ControlMode) => void;
  currentMode: () => ControlMode;
  vision: NativeVisionAdapter;
  follow: FollowController;
  droneState: () => Readonly<{ battery: number | null; heightCm: number | null; flightSeconds: number | null }>;
  wait: (ms: number) => Promise<void>;
}

/** The SDK verb for each `fly` action that maps to one. */
const FLY_VERB: Record<string, string> = {
  takeoff: "takeoff",
  land: "land",
  emergency: "emergency",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  forward: "forward",
  back: "back",
};

export function createToolExecutor(deps: ExecutorDeps): {
  run: (call: ToolCall) => Promise<Record<string, unknown>>;
  observe: () => Promise<DroneScene>;
} {
  async function command(cmd: string): Promise<Record<string, unknown>> {
    const outcome = await deps.command(cmd);
    // The model is told the truth, including "sent but unverifiable", because
    // a fabricated success is how it builds the next step on sand.
    return { ok: outcome.status === "succeeded", status: outcome.status, reply: outcome.detail };
  }

  async function observe(): Promise<DroneScene> {
    const mode = deps.currentMode();
    const state = deps.droneState();
    const followState = deps.follow.state();

    if (mode === "aruco") {
      const aruco = deps.vision.arucoSnapshot();
      return {
        battery: state.battery,
        heightCm: state.heightCm,
        flightSeconds: state.flightSeconds,
        mode,
        airborne: followState.airborne,
        targets: aruco.markers.map((marker) => {
          const metrics = markerMetrics(marker);
          return { id: marker.id, kind: "marker" as const, widthPx: Math.round(metrics.edge), centerX: Math.round(metrics.centerX) };
        }),
        lockedId: aruco.target.id,
        followPhase: followState.phase,
        frame: aruco.frameSize,
      };
    }

    if (mode === "person") {
      const person = deps.vision.personSnapshot();
      return {
        battery: state.battery,
        heightCm: state.heightCm,
        flightSeconds: state.flightSeconds,
        mode,
        airborne: followState.airborne,
        targets: person.detections.map((detection) => ({
          id: detection.trackId,
          kind: "person" as const,
          widthPx: Math.round(detection.width),
          centerX: Math.round(detection.x + detection.width / 2),
          confidence: Math.round(detection.confidence * 100) / 100,
        })),
        lockedId: person.target.id,
        followPhase: followState.phase,
        frame: person.frameSize,
      };
    }

    // Key mode runs no detector at all, so an empty target list here is a fact
    // about the mode rather than about the scene - and saying so is what stops
    // the model concluding the room is empty.
    return {
      battery: state.battery,
      heightCm: state.heightCm,
      flightSeconds: state.flightSeconds,
      mode,
      airborne: followState.airborne,
      targets: [],
      lockedId: null,
      followPhase: followState.phase,
      frame: null,
    };
  }

  async function run(call: ToolCall): Promise<Record<string, unknown>> {
    switch (call.tool) {
      case "fly": {
        if (call.action === "hover") {
          deps.neutral();
          return { ok: true, status: "unconfirmed", reply: "sticks centred (rc has no reply)" };
        }
        const verb = FLY_VERB[call.action];
        if (verb === undefined) return { error: `no SDK verb for "${call.action}"` };
        return await command(call.cm === null ? verb : `${verb} ${call.cm}`);
      }
      case "rotate":
        return await command(`${call.direction} ${call.degrees}`);
      case "flip":
        return await command(`flip ${call.direction}`);
      case "speed":
        return await command(`speed ${call.cms}`);
      case "set_mode":
        deps.setMode(call.mode);
        return { ok: true, mode: call.mode };
      case "lock": {
        const mode = deps.currentMode();
        if (mode === "person") {
          // Person mode has no selection to make: it follows whoever is in
          // frame the moment the mode is on. Saying so beats silently
          // succeeding on a request the app cannot honour.
          const person = deps.vision.personSnapshot();
          return person.target.id === null
            ? { error: "person mode follows whoever is in frame, and nobody is; no lock is needed or possible" }
            : { ok: true, following: true, note: "person mode follows automatically; the id was not needed" };
        }
        if (mode !== "aruco") return { error: "key mode runs no detector; call set_mode with aruco or person first" };
        deps.vision.setArucoTarget(call.id);
        // Selection is refused when the id is not in the current frame, so the
        // only honest confirmation is to read the lock back.
        return deps.vision.arucoSnapshot().target.id === call.id
          ? { ok: true, locked: call.id, following: true }
          : { error: `marker ${call.id} is not in the current frame; call observe for the ids that are` };
      }
      case "unlock": {
        if (deps.currentMode() === "person") {
          return { error: "person mode cannot be unlocked; call set_mode with key to stop following" };
        }
        deps.vision.setArucoTarget(null);
        return { ok: true, locked: null };
      }
      case "wait":
        await deps.wait(call.seconds * 1000);
        return { ok: true, waited: call.seconds };
      case "observe":
      case "done":
        // Both are handled by the loop itself; reaching here would be a bug.
        return { error: `${call.tool} is not executed by the tool runner` };
    }
  }

  return { run, observe };
}
