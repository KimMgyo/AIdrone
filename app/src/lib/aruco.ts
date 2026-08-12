import type { ControlMode } from "../control-mode.ts";
import type {
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

/**
 * The marker this project ships a print of - `ARUCO_MIP_36h12_ID_0_A4.svg` in
 * the repository root. Seeded onto the roster and selected when a session comes
 * up, so the common case needs no clicks at all.
 *
 * It arrives with no size, which is the whole reason seeding it is safe: the
 * follow loop refuses an unmeasured tag, so this is a selection and not an
 * armed autonomous flight. The operator types the printed edge length, and only
 * then can anything move.
 */
export const DEFAULT_MARKER_ID = 0;

export type ArucoMarker = VisionArucoMarker;
export type PersonDetection = VisionPersonDetection;

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

/**
 * One row of the panel's marker roster: an id this session knows about, with
 * its current-frame observation when it has one. `marker: null` is the honest
 * reading for a marker that is on the list but not in front of the camera.
 */
export type ArucoKnownMarker = Readonly<{
  id: number;
  marker: ArucoMarker | null;
}>;

export type ArucoVisionState = Readonly<{
  active: boolean;
  dictionaryName: typeof NATIVE_ARUCO_DICTIONARY;
  /** The verbatim native status for the active detector mode, if it sent one. */
  status: VisionStatusEvent | null;
  /** Current-frame markers, when the detector reported a healthy frame. */
  markers: readonly ArucoMarker[];
  /** Every id this session knows about, seen or expected, in join order. */
  known: readonly ArucoKnownMarker[];
  recvEpochUs: number | null;
  frameSize: Readonly<{ width: number; height: number }> | null;
  analysisMs: number | null;
  /** The verbatim last frame, so a panel can read a detector error's detail
   *  without this class deciding what to do about it. */
  observation: VisionArucoEvent | null;
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
  /** Puts a marker on the roster before it has ever been seen, which is how the
   *  panel's marker library turns a printed pattern into a tracking choice. */
  addArucoMarker(id: number): void;
  /** Takes one off, releasing it first if it was the target. */
  forgetArucoMarker(id: number): void;
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
  /**
   * Every marker id this session has either seen or been told to expect, in
   * the order it joined. Sticky on purpose: a printed marker does not stop
   * existing when it leaves frame, and a list that emptied itself every time
   * the drone looked away could not be used to pick a target.
   *
   * Scoped to the session, not the mode: switching to keyboard and back must
   * not lose the roster an operator built, but carrying "seen in the last
   * flight" into a fresh one would be a claim about a scene this app has not
   * looked at yet. Forgotten one at a time by `forgetArucoMarker`.
   */
  private arucoKnown: number[] = [];
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
    // Seeded AFTER the reset, which nulls the target: a live session starts on
    // the marker this project prints, already chosen. Not armed - see
    // `DEFAULT_MARKER_ID` - just selected, so the common case is "type the edge
    // length" rather than "find it in the list first".
    //
    // Only here, and deliberately not on every entry into marker mode. A mode
    // change clears the lock, and re-seeding it there would hand the operator a
    // freshly armed follow loop the moment they pressed F3 with a size already
    // stored. Re-picking from the roster is one click on a row that is still
    // sitting there.
    this.arucoKnown = live ? [DEFAULT_MARKER_ID] : [];
    this.arucoTargetId = live ? DEFAULT_MARKER_ID : null;
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
      if (event.state === "ready") {
        for (const marker of event.markers) {
          if (!this.arucoKnown.includes(marker.id)) this.arucoKnown.push(marker.id);
        }
      }
      this.notifyAruco();
      return;
    }

    if (!this.active("person") || this.blocksResults(this.personStatus)) return;
    this.personEvent = event;
    // The selection deliberately survives this event. A track missing from the
    // current frame is reported as `searching`, not as a cleared lock.
    this.notifyPerson();
  }

  /**
   * A target must be a marker this session knows about - seen at least once,
   * or added from the marker library. It does NOT have to be in the current
   * frame: that is what makes a lock survive the drone looking away, and what
   * lets an operator choose the marker they are about to hold up.
   *
   * The size requirement is not relaxed with it. An unmeasured tag would be
   * held at a distance nobody chose, so the panel refuses to arm one and the
   * follow loop never receives it.
   */
  setArucoTarget(id: number | null): void {
    if (id !== null && !this.arucoKnown.includes(id)) return;
    if (id === this.arucoTargetId) return;
    this.arucoTargetId = id;
    this.notifyAruco();
  }

  addArucoMarker(id: number): void {
    if (this.arucoKnown.includes(id)) return;
    this.arucoKnown.push(id);
    this.notifyAruco();
  }

  forgetArucoMarker(id: number): void {
    const at = this.arucoKnown.indexOf(id);
    if (at < 0) return;
    this.arucoKnown.splice(at, 1);
    // Forgetting the marker being followed is a release: the loop may not keep
    // steering at an id the operator has just taken off the list.
    if (this.arucoTargetId === id) this.arucoTargetId = null;
    this.notifyAruco();
  }

  arucoSnapshot(): ArucoVisionState {
    const event = this.arucoEvent;
    const active = this.active("aruco");
    const markers = active && event?.state === "ready" ? event.markers : [];
    const marker = this.arucoTargetId === null ? null : (markers.find((candidate) => candidate.id === this.arucoTargetId) ?? null);
    return {
      active,
      dictionaryName: NATIVE_ARUCO_DICTIONARY,
      status: active ? this.arucoStatus : null,
      markers,
      known: this.arucoKnown.map((id) => ({
        id,
        marker: markers.find((candidate) => candidate.id === id) ?? null,
      })),
      recvEpochUs: active ? (event?.recvEpochUs ?? null) : null,
      frameSize: active && event !== null ? { width: event.width, height: event.height } : null,
      analysisMs: active && event?.state === "ready" ? event.analysisMs : null,
      observation: active ? event : null,
      target: {
        id: this.arucoTargetId,
        marker,
        state: this.arucoTargetState(active, active ? event : null, marker),
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
    event: VisionArucoEvent | null,
    marker: ArucoMarker | null,
  ): ArucoTargetState {
    const state: VisionStatusState | null = this.arucoStatus?.state ?? null;
    if (!active || state === "inactive") return "inactive";
    if (state === "error" || event?.state === "error") return "error";
    if (marker !== null) return "detected";
    if (event?.state === "ready") return this.arucoTargetId === null ? "unselected" : "searching";
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
