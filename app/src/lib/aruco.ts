import type { ControlMode } from "../control-mode.ts";
import type {
  VisionArucoEngineResult,
  VisionArucoEvent,
  VisionArucoMarker,
  VisionEvent,
  VisionPersonDetection,
  VisionPersonEvent,
  VisionStatusEvent,
  VisionStatusState,
} from "../transport.ts";

/** The only ArUco dictionary implemented by the native worker today. */
export const NATIVE_ARUCO_DICTIONARY = "ARUCO_MIP_36h12";

export type ArucoMarker = VisionArucoMarker;
export type PersonDetection = VisionPersonDetection;

/** Index 0 is the primary engine: the only one selection and overlay follow. */
function primaryArucoResult(event: VisionArucoEvent | null): VisionArucoEngineResult<"apriltag3"> | null {
  return event?.engines[0] ?? null;
}

/**
 * Centre and apparent edge length of a marker, from its corners alone. Shared
 * so the panel's readout and the follow loop's distance term can never be
 * computed two slightly different ways.
 */
export function markerMetrics(marker: ArucoMarker): {
  readonly centerX: number;
  readonly centerY: number;
  readonly area: number;
  readonly edge: number;
} {
  let areaTwice = 0;
  let centerX = 0;
  let centerY = 0;
  for (let index = 0; index < marker.corners.length; index++) {
    const point = marker.corners[index];
    const next = marker.corners[(index + 1) % marker.corners.length];
    areaTwice += point.x * next.y - next.x * point.y;
    centerX += point.x;
    centerY += point.y;
  }
  const area = Math.abs(areaTwice) / 2;
  return {
    centerX: centerX / marker.corners.length,
    centerY: centerY / marker.corners.length,
    area,
    edge: Math.sqrt(area),
  };
}

/**
 * A selected marker is strictly presentation state. A marker becomes
 * `detected` only while that exact id exists in the current native result.
 */
export type ArucoTargetState = "inactive" | "waitingFrame" | "unselected" | "searching" | "detected" | "error";

export type ArucoTarget = Readonly<{
  id: number | null;
  marker: ArucoMarker | null;
  state: ArucoTargetState;
}>;

export type ArucoVisionState = Readonly<{
  active: boolean;
  dictionaryName: typeof NATIVE_ARUCO_DICTIONARY;
  /** The verbatim native status for the active detector mode, if it sent one. */
  status: VisionStatusEvent | null;
  /** Current-frame markers from the primary engine (AprilTag 3). */
  markers: readonly ArucoMarker[];
  recvEpochUs: number | null;
  frameSize: Readonly<{ width: number; height: number }> | null;
  analysisMs: number | null;
  /** The complete, ordered same-frame A/B result; never a rolling history. */
  comparison: VisionArucoEvent | null;
  target: ArucoTarget;
}>;

/**
 * A selected person is strictly presentation state, but unlike a raw index it
 * survives a frame: the native worker's `trackId` is one identity for the life
 * of a track, so a lock is only lost when the track itself ends.
 */
export type PersonTargetState = "inactive" | "waitingFrame" | "unselected" | "searching" | "detected" | "error";

export type PersonTarget = Readonly<{
  /** Native track id, stable across frames; never an index into `detections`. */
  id: number | null;
  detection: PersonDetection | null;
  state: PersonTargetState;
}>;

export type PersonVisionState = Readonly<{
  active: boolean;
  /** The verbatim native status for the active detector, if it sent one. */
  status: VisionStatusEvent | null;
  /** Detections are only those in the most recent native `person` event. */
  detections: readonly PersonDetection[];
  recvEpochUs: number | null;
  frameSize: Readonly<{ width: number; height: number }> | null;
  analysisMs: number | null;
  target: PersonTarget;
}>;

export type ArucoStateListener = (state: ArucoVisionState) => void;
export type PersonStateListener = (state: PersonVisionState) => void;

/**
 * Frontend adapter for native observations. It never decodes video, invokes
 * transport, or turns a selected item into a motion command. The composition
 * root supplies only validated `VisionEvent` values from the Tauri channel.
 */
export interface NativeVisionAdapter {
  setMode(mode: ControlMode): void;
  setSessionLive(live: boolean): void;
  accept(event: VisionEvent): void;
  /** Markers only. Person mode follows whoever is nearest, with no selection. */
  setArucoTarget(id: number | null): void;
  arucoSnapshot(): ArucoVisionState;
  personSnapshot(): PersonVisionState;
  subscribeAruco(listener: ArucoStateListener): () => void;
  subscribePerson(listener: PersonStateListener): () => void;
}

/**
 * Whoever is nearest, by box area.
 *
 * Person mode has no operator selection: re-identifying a particular person
 * across frames is not something this detector can be trusted to do, so the
 * app stopped pretending. What it can do is follow whoever is in front of it,
 * and the biggest box is both the most stable choice frame to frame and what
 * a pilot means when they point the drone at someone.
 */
function nearest(detections: readonly PersonDetection[]): PersonDetection | null {
  let best: PersonDetection | null = null;
  for (const detection of detections) {
    if (best === null || detection.width * detection.height > best.width * best.height) best = detection;
  }
  return best;
}

class NativeVisionStateAdapter implements NativeVisionAdapter {
  private mode: ControlMode = "key";
  private sessionLive = false;
  private arucoStatus: VisionStatusEvent | null = null;
  private personStatus: VisionStatusEvent | null = null;
  private arucoEvent: VisionArucoEvent | null = null;
  private personEvent: VisionPersonEvent | null = null;
  private arucoTargetId: number | null = null;
  private readonly arucoListeners = new Set<ArucoStateListener>();
  private readonly personListeners = new Set<PersonStateListener>();

  setMode(mode: ControlMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.clearObservations();
    this.notifyAll();
  }

  setSessionLive(live: boolean): void {
    if (live === this.sessionLive) return;
    this.sessionLive = live;
    this.clearObservations();
    this.notifyAll();
  }

  accept(event: VisionEvent): void {
    if (!this.sessionLive) return;

    if (event.kind === "status") {
      if (event.mode !== this.mode) return;
      if (event.mode === "aruco") {
        this.arucoStatus = event;
        if (event.state !== "ready") this.arucoEvent = null;
        this.notifyAruco();
      } else if (event.mode === "person") {
        this.personStatus = event;
        if (event.state !== "ready") this.personEvent = null;
        this.notifyPerson();
      }
      return;
    }

    if (event.kind === "aruco") {
      if (!this.active("aruco") || this.blocksResults(this.arucoStatus)) return;
      this.arucoEvent = event;
      this.notifyAruco();
      return;
    }

    if (!this.active("person") || this.blocksResults(this.personStatus)) return;
    this.personEvent = event;
    // The selection deliberately survives this event. A track missing from the
    // current frame is reported as `searching`, not as a cleared lock.
    this.notifyPerson();
  }

  setArucoTarget(id: number | null): void {
    const primary = primaryArucoResult(this.arucoEvent);
    const markers = primary?.state === "ready" ? primary.markers : [];
    if (id !== null && !markers.some((marker) => marker.id === id)) return;
    if (id === this.arucoTargetId) return;
    this.arucoTargetId = id;
    this.notifyAruco();
  }

  arucoSnapshot(): ArucoVisionState {
    const event = this.arucoEvent;
    const active = this.active("aruco");
    const primary = primaryArucoResult(event);
    const markers = active && primary?.state === "ready" ? primary.markers : [];
    const marker = this.arucoTargetId === null ? null : (markers.find((candidate) => candidate.id === this.arucoTargetId) ?? null);
    return {
      active,
      dictionaryName: NATIVE_ARUCO_DICTIONARY,
      status: active ? this.arucoStatus : null,
      markers,
      recvEpochUs: active ? (event?.recvEpochUs ?? null) : null,
      frameSize: active && event !== null ? { width: event.width, height: event.height } : null,
      analysisMs: active && primary?.state === "ready" ? primary.analysisMs : null,
      comparison: active ? event : null,
      target: {
        id: this.arucoTargetId,
        marker,
        state: this.arucoTargetState(active, primary, marker),
      },
    };
  }

  personSnapshot(): PersonVisionState {
    const event = this.personEvent;
    const active = this.active("person");
    const detections = active ? (event?.detections ?? []) : [];
    const detection = nearest(detections);
    return {
      active,
      status: active ? this.personStatus : null,
      detections,
      recvEpochUs: active ? (event?.recvEpochUs ?? null) : null,
      frameSize: active && event !== null ? { width: event.width, height: event.height } : null,
      analysisMs: active ? (event?.analysisMs ?? null) : null,
      target: {
        id: detection?.trackId ?? null,
        detection,
        state: this.personTargetState(active, event, detection),
      },
    };
  }

  subscribeAruco(listener: ArucoStateListener): () => void {
    this.arucoListeners.add(listener);
    listener(this.arucoSnapshot());
    return () => this.arucoListeners.delete(listener);
  }

  subscribePerson(listener: PersonStateListener): () => void {
    this.personListeners.add(listener);
    listener(this.personSnapshot());
    return () => this.personListeners.delete(listener);
  }

  private active(mode: Extract<ControlMode, "aruco" | "person">): boolean {
    return this.sessionLive && this.mode === mode;
  }

  private blocksResults(status: VisionStatusEvent | null): boolean {
    return status?.state === "inactive" || status?.state === "error";
  }

  private arucoTargetState(
    active: boolean,
    primary: VisionArucoEngineResult<"apriltag3"> | null,
    marker: ArucoMarker | null,
  ): ArucoTargetState {
    const state: VisionStatusState | null = this.arucoStatus?.state ?? null;
    if (!active || state === "inactive") return "inactive";
    if (state === "error" || primary?.state === "error") return "error";
    if (marker !== null) return "detected";
    if (primary?.state === "ready") return this.arucoTargetId === null ? "unselected" : "searching";
    return "waitingFrame";
  }

  private personTargetState(
    active: boolean,
    event: VisionPersonEvent | null,
    detection: PersonDetection | null,
  ): PersonTargetState {
    const state: VisionStatusState | null = this.personStatus?.state ?? null;
    if (!active || state === "inactive") return "inactive";
    if (state === "error") return "error";
    if (detection !== null) return "detected";
    // No selection to be missing: a frame with nobody in it is a search.
    if (event !== null) return "searching";
    return "waitingFrame";
  }

  /**
   * A mode change or a session end releases the marker lock. It used to
   * survive, which was harmless while selection was presentation-only and is
   * not now: the lock is the follow switch, and returning to a mode should
   * never resume autonomous flight on a target the operator chose minutes ago.
   */
  private clearObservations(): void {
    this.arucoStatus = null;
    this.personStatus = null;
    this.arucoEvent = null;
    this.personEvent = null;
    this.arucoTargetId = null;
  }

  private notifyAll(): void {
    this.notifyAruco();
    this.notifyPerson();
  }

  private notifyAruco(): void {
    const state = this.arucoSnapshot();
    for (const listener of [...this.arucoListeners]) {
      try {
        listener(state);
      } catch (err) {
        console.error("native vision: ArUco subscriber threw", err);
      }
    }
  }

  private notifyPerson(): void {
    const state = this.personSnapshot();
    for (const listener of [...this.personListeners]) {
      try {
        listener(state);
      } catch (err) {
        console.error("native vision: person subscriber threw", err);
      }
    }
  }
}

export function createNativeVisionAdapter(): NativeVisionAdapter {
  return new NativeVisionStateAdapter();
}
