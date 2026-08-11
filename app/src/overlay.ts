import { controlMode, type ControlMode } from "./control-mode.ts";
import type { FollowState } from "./follow.ts";
import type {
  ArucoMarker,
  ArucoTarget,
  PersonDetection,
  PersonTarget,
} from "./lib/aruco.ts";
import type { DroneState, VisionStatusEvent } from "./transport.ts";
import { cls, must, style, text } from "./ui.ts";

const MISSING = "--";
const DOT = "w-[6px] h-[6px] rounded-full";
const STREAM = "flex-1 min-w-0 font-mono text-[10.5px] text-[#7C848F] truncate";
const CROSS = "absolute left-1/2 top-1/2 w-[200px] h-[200px] -ml-[100px] -mt-[100px]";
const HUD =
  "absolute left-[15px] top-1/2 -translate-y-1/2 font-mono text-[10.5px] text-[#7C848F] leading-[2.1]";
const DETECTIONS = "absolute inset-0";
const ARUCO_MARKER = "absolute border border-warn/70";
const ARUCO_TARGET = "absolute border border-warn";
const ARUCO_TAG =
  "absolute left-0 top-0 -translate-y-full whitespace-nowrap border border-warn/40 bg-bg/70 px-[5px] py-[2px] font-mono text-[9px] text-[#B9924A]";
const ARUCO_TARGET_TAG =
  "absolute left-0 top-0 -translate-y-full whitespace-nowrap border border-warn/60 bg-warn px-[5px] py-[2px] font-mono text-[9px] text-[#1A1204]";
const PERSON_DETECTION = "absolute border border-ok/70";
const PERSON_TARGET = "absolute border border-ok";
const PERSON_TAG =
  "absolute left-0 top-0 -translate-y-full whitespace-nowrap border border-ok/40 bg-bg/70 px-[5px] py-[2px] font-mono text-[9px] text-[#A8D9AE]";
const PERSON_TARGET_TAG =
  "absolute left-0 top-0 -translate-y-full whitespace-nowrap border border-ok/60 bg-ok px-[5px] py-[2px] font-mono text-[9px] text-[#07140A]";

const MODE_DOT: Record<ControlMode, string> = {
  key: "bg-accent",
  person: "bg-ok",
  aruco: "bg-warn",
};

const HAIR = "bg-[rgba(230,233,238,.25)]";

type NativeFrameSize = Readonly<{ width: number; height: number }>;

/** Actual native ArUco result and presentation selection; no screen-space fallback. */
export type ArucoOverlayData = Readonly<{
  active: boolean;
  status: VisionStatusEvent | null;
  frameSize: NativeFrameSize | null;
  markers: readonly ArucoMarker[];
  target: ArucoTarget;
}>;

/** Actual native YOLO result and the presentation lock, keyed by native track id. */
export type PersonOverlayData = Readonly<{
  active: boolean;
  status: VisionStatusEvent | null;
  frameSize: NativeFrameSize | null;
  detections: readonly PersonDetection[];
  target: PersonTarget;
}>;

export type StageOverlayModel = Readonly<{
  state: DroneState | null;
  live: boolean;
  linkFps: number;
  linkMbps: number;
  width: number;
  height: number;
  mode?: ControlMode;
}>;

export interface StageOverlay {
  /** Shell chrome and telemetry text; driven by the slow shell tick. */
  update(m: StageOverlayModel): void;
  /**
   * Detection geometry, driven by the observation itself. Sampling a 10 Hz
   * detector on the 250 ms shell tick drops most of its results and makes a
   * box that is genuinely tracking look like it is stepping.
   */
  setAruco(data: ArucoOverlayData | null): void;
  setPerson(data: PersonOverlayData | null): void;
  /**
   * Autonomous follow state. It gets a banner of its own over the picture
   * because "the drone is flying itself right now" must be readable without
   * looking away from the video, from any panel, at a glance.
   */
  setFollow(state: FollowState | null): void;
}

type OverlayNode = { box: HTMLDivElement; tag: HTMLDivElement };
type Rect = { left: string; top: string; width: string; height: string };

/**
 * Fills `mount` with stage chrome. Vision layers receive only native event
 * geometry expressed in the event's decoded-frame coordinates; renderer pixels
 * are never read back into this component.
 */
export function installStageOverlay(mount: HTMLElement): StageOverlay {
  mount.innerHTML = `
    <div class="absolute top-[13px] left-[15px] right-[47px] flex items-center justify-between gap-[12px] min-w-0">
      <div class="flex min-w-0 flex-1 items-center gap-[11px]">
        <div class="flex-none flex items-center gap-[7px] h-[24px] px-[9px] bg-bg/75 border border-line3 rounded-[3px]">
          <div data-k="dot" class="${DOT} bg-dim3"></div>
          <div class="font-mono text-[10.5px] text-ink">LIVE</div>
        </div>
        <div data-k="stream" class="${STREAM} hidden">${MISSING}</div>
      </div>
      <div class="flex-none flex items-center gap-[8px] h-[24px] px-[10px] bg-bg/75 border border-line3 rounded-[3px]">
        <div data-k="mode-dot" class="${DOT} bg-dim3"></div>
        <div data-k="mode" class="font-mono text-[10.5px] tracking-[.14em] text-ink whitespace-nowrap">MODE / ${MISSING}</div>
      </div>
    </div>

    <div data-k="cross" class="${CROSS} hidden">
      <div class="absolute left-1/2 top-0 w-px h-[20px] ${HAIR}"></div>
      <div class="absolute left-1/2 bottom-0 w-px h-[20px] ${HAIR}"></div>
      <div class="absolute top-1/2 left-0 h-px w-[20px] ${HAIR}"></div>
      <div class="absolute top-1/2 right-0 h-px w-[20px] ${HAIR}"></div>
      <div class="absolute left-1/2 top-1/2 w-[5px] h-[5px] -ml-[2.5px] -mt-[2.5px] rounded-full bg-[rgba(230,233,238,.45)]"></div>
    </div>

    <div data-k="hud" class="${HUD} hidden">
      <div>ALT&nbsp;&nbsp;<span data-k="alt">${MISSING}</span></div>
      <div>SPD&nbsp;&nbsp;<span data-k="spd">${MISSING}</span></div>
      <div>YAW&nbsp;&nbsp;<span data-k="yaw">${MISSING}</span></div>
    </div>

    <div data-k="follow" class="absolute left-1/2 top-[52px] hidden -translate-x-1/2 items-center gap-[9px] rounded-[3px] border border-alert bg-alert/85 px-[12px] py-[6px]">
      <div class="${DOT} bg-[#1A0A0A] animate-beat-fast"></div>
      <div data-k="follow-label" class="font-mono text-[11px] tracking-[.16em] text-[#1A0A0A]">FOLLOWING</div>
      <div data-k="follow-detail" class="font-mono text-[10.5px] text-[#3A1414]"></div>
    </div>

    <div data-k="aruco-detections" class="${DETECTIONS} hidden"></div>
    <div data-k="person-detections" class="${DETECTIONS} hidden"></div>
  `;

  const dot = must('[data-k="dot"]', HTMLDivElement, mount);
  const stream = must('[data-k="stream"]', HTMLDivElement, mount);
  const modeDot = must('[data-k="mode-dot"]', HTMLDivElement, mount);
  const modeCell = must('[data-k="mode"]', HTMLDivElement, mount);
  const cross = must('[data-k="cross"]', HTMLDivElement, mount);
  const hud = must('[data-k="hud"]', HTMLDivElement, mount);
  const altCell = must('[data-k="alt"]', HTMLSpanElement, mount);
  const spdCell = must('[data-k="spd"]', HTMLSpanElement, mount);
  const yawCell = must('[data-k="yaw"]', HTMLSpanElement, mount);
  const arucoLayer = must('[data-k="aruco-detections"]', HTMLDivElement, mount);
  const personLayer = must('[data-k="person-detections"]', HTMLDivElement, mount);
  const arucoNodes = new Map<number, OverlayNode>();
  const personNodes = new Map<number, OverlayNode>();
  const visibleArucoIds = new Set<number>();
  const visiblePersonTrackIds = new Set<number>();

  let live = false;
  let selectedMode: ControlMode | undefined;
  let arucoData: ArucoOverlayData | null = null;
  let personData: PersonOverlayData | null = null;
  let followState: FollowState | null = null;
  const followBanner = must('[data-k="follow"]', HTMLDivElement, mount);
  const followDetail = must('[data-k="follow-detail"]', HTMLDivElement, mount);
  const followLabel = must('[data-k="follow-label"]', HTMLDivElement, mount);

  /**
   * Detection geometry lands in the same animation frame as the canvas paint.
   * `render.ts` draws inside `requestAnimationFrame`; writing box styles
   * straight from the IPC callback instead put the box and the picture it
   * belongs to in different composited frames, which reads as the box
   * shimmering against a steady image. Coalescing also collapses two
   * observations that arrive inside one vsync into a single layout pass.
   */
  let pendingPaint = 0;
  const scheduleDetections = (): void => {
    if (pendingPaint !== 0) return;
    pendingPaint = requestAnimationFrame(() => {
      pendingPaint = 0;
      paintModeTag();
      paintDetections();
    });
  };

  const paintModeTag = (): void => {
    if (selectedMode === undefined) {
      cls(modeDot, `${DOT} bg-dim3`);
      text(modeCell, `MODE / ${MISSING}`);
      return;
    }
    const spec = controlMode(selectedMode);
    let tag: string = spec.stageTag;
    let dotTone = MODE_DOT[selectedMode];
    if (selectedMode === "aruco") {
      const aruco = arucoData;
      if (!aruco?.active || aruco.status?.state === "inactive") {
        tag = "ARUCO / NATIVE OFF";
        dotTone = "bg-dim3";
      } else if (aruco.status?.state === "error") {
        tag = "ARUCO / NATIVE ERROR";
        dotTone = "bg-alert";
      } else if (aruco.frameSize === null) {
        tag = "ARUCO / WAITING FRAME";
        dotTone = "bg-dim";
      } else {
        tag = "ARUCO / NATIVE DETECTOR";
      }
    } else if (selectedMode === "person") {
      const person = personData;
      if (!person?.active || person.status?.state === "inactive") {
        tag = "PERSON / NATIVE OFF";
        dotTone = "bg-dim3";
      } else if (person.status?.state === "error") {
        tag = "PERSON / NATIVE ERROR";
        dotTone = "bg-alert";
      } else if (person.frameSize === null) {
        tag = "PERSON / WAITING FRAME";
        dotTone = "bg-dim";
      } else {
        tag = "PERSON / NATIVE YOLO26N";
      }
    }
    cls(modeDot, `${DOT} ${dotTone}`);
    text(modeCell, tag);
  };

  const paintDetections = (): void => {
    const stageWidth = mount.clientWidth;
    const stageHeight = mount.clientHeight;
    const measured = stageWidth > 0 && stageHeight > 0;

    visibleArucoIds.clear();
    const aruco = selectedMode === "aruco" ? arucoData : null;
    if (live && measured && aruco?.active && aruco.frameSize !== null) {
      const targetId = aruco.target.marker?.id;
      for (const marker of aruco.markers) {
        const rect = markerRect(marker, aruco.frameSize, stageWidth, stageHeight);
        if (rect === null || visibleArucoIds.has(marker.id)) continue;
        visibleArucoIds.add(marker.id);
        let node = arucoNodes.get(marker.id);
        if (node === undefined) {
          node = addOverlayNode(arucoLayer);
          arucoNodes.set(marker.id, node);
        }
        const selected = targetId === marker.id;
        cls(node.box, selected ? ARUCO_TARGET : ARUCO_MARKER);
        cls(node.tag, selected ? ARUCO_TARGET_TAG : ARUCO_TAG);
        text(node.tag, selected ? `ID ${marker.id} · PRESENTATION` : `ID ${marker.id}`);
        paintRect(node.box, rect);
      }
    }
    retireMissingNodes(arucoNodes, visibleArucoIds);
    cls(arucoLayer, live && arucoNodes.size > 0 ? DETECTIONS : `${DETECTIONS} hidden`);

    visiblePersonTrackIds.clear();
    const person = selectedMode === "person" ? personData : null;
    if (live && measured && person?.active && person.frameSize !== null) {
      // Only a track matched in the current frame has geometry, so an id that
      // resolved to no detection paints nothing and simply keeps the lock.
      const targetTrackId = person.target.detection?.trackId;
      for (const detection of person.detections) {
        const rect = personRect(detection, person.frameSize, stageWidth, stageHeight);
        if (rect === null || visiblePersonTrackIds.has(detection.trackId)) continue;
        visiblePersonTrackIds.add(detection.trackId);
        let node = personNodes.get(detection.trackId);
        if (node === undefined) {
          node = addOverlayNode(personLayer);
          personNodes.set(detection.trackId, node);
        }
        const selected = targetTrackId === detection.trackId;
        cls(node.box, selected ? PERSON_TARGET : PERSON_DETECTION);
        cls(node.tag, selected ? PERSON_TARGET_TAG : PERSON_TAG);
        text(
          node.tag,
          selected
            ? `TRACK ${detection.trackId} · PRESENTATION`
            : `TRACK ${detection.trackId} · ${(detection.confidence * 100).toFixed(1)}%`,
        );
        paintRect(node.box, rect);
      }
    }
    retireMissingNodes(personNodes, visiblePersonTrackIds);
    cls(personLayer, live && personNodes.size > 0 ? DETECTIONS : `${DETECTIONS} hidden`);
  };

  return {
    update(m) {
      const s = m.state;
      live = m.live;
      selectedMode = m.mode;

      cls(dot, m.live ? `${DOT} bg-alert animate-beat-fast` : `${DOT} bg-dim3`);
      cls(stream, m.live ? STREAM : `${STREAM} hidden`);
      cls(cross, m.live ? CROSS : `${CROSS} hidden`);
      cls(hud, m.live ? HUD : `${HUD} hidden`);
      paintModeTag();

      const width = Math.round(m.width);
      const height = Math.round(m.height);
      const sized = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
      const linkFps = finiteNumber(m.linkFps);
      const linkMbps = finiteNumber(m.linkMbps);
      const fps = linkFps === null || linkFps <= 0 ? MISSING : linkFps.toFixed(0);
      const mbps = linkMbps === null || linkMbps <= 0 ? MISSING : linkMbps.toFixed(1);
      text(stream, `${sized ? `${width}×${height}` : MISSING} · ${sized ? aspect(width, height) : MISSING} · ${fps} fps · ${mbps} Mb/s`);

      const altCm = finiteNumber(s?.h);
      text(altCell, altCm === null ? MISSING : `${(altCm / 100).toFixed(2)} m`);
      const vx = finiteNumber(s?.vgx);
      const vy = finiteNumber(s?.vgy);
      const vz = finiteNumber(s?.vgz);
      const speed = vx === null || vy === null || vz === null ? null : Math.hypot(vx, vy, vz);
      text(spdCell, speed === null ? MISSING : speed.toFixed(1));
      const heading = finiteNumber(s?.yaw);
      text(yawCell, heading === null ? MISSING : `${heading.toFixed(0)}°`);

      // The stage can resize between observations, so geometry is reprojected
      // here too - not only when a new detection arrives.
      paintDetections();
    },

    setAruco(data) {
      arucoData = data;
      scheduleDetections();
    },

    setPerson(data) {
      personData = data;
      scheduleDetections();
    },

    setFollow(state) {
      followState = state;
      const phase = followState?.phase ?? "idle";
      const live = phase === "following" || phase === "searching";
      const base = "absolute left-1/2 top-[52px] -translate-x-1/2 items-center gap-[9px] rounded-[3px] border border-alert px-[12px] py-[6px]";
      cls(followBanner, live ? `${base} flex ${phase === "following" ? "bg-alert/85" : "bg-alert/55"}` : `${base} hidden`);
      if (!live || followState === null) return;
      text(followLabel, phase === "following" ? "FOLLOWING" : "TARGET LOST");
      text(
        followDetail,
        phase === "following" ? `전후 ${followState.command.fb} · yaw ${followState.command.yaw}` : "스틱 중립 · 잠금 유지",
      );
    },
  };
}

function addOverlayNode(layer: HTMLDivElement): OverlayNode {
  const box = document.createElement("div");
  const tag = document.createElement("div");
  box.append(tag);
  layer.append(box);
  return { box, tag };
}

function paintRect(box: HTMLDivElement, rect: Rect): void {
  style(box, "left", rect.left);
  style(box, "top", rect.top);
  style(box, "width", rect.width);
  style(box, "height", rect.height);
}

function retireMissingNodes(nodes: Map<number, OverlayNode>, visible: Set<number>): void {
  for (const [id, node] of nodes) {
    if (visible.has(id)) continue;
    node.box.remove();
    nodes.delete(id);
  }
}

function finiteNumber(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

function markerRect(marker: ArucoMarker, frame: NativeFrameSize, stageWidth: number, stageHeight: number): Rect | null {
  if (!Number.isInteger(marker.id) || marker.id < 0 || marker.corners.length !== 4) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of marker.corners) {
    if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y)) return null;
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  return projectedRect(minX, minY, maxX, maxY, frame, stageWidth, stageHeight);
}

function personRect(detection: PersonDetection, frame: NativeFrameSize, stageWidth: number, stageHeight: number): Rect | null {
  if (
    !Number.isFinite(detection.x) ||
    !Number.isFinite(detection.y) ||
    !Number.isFinite(detection.width) ||
    !Number.isFinite(detection.height) ||
    detection.width <= 0 ||
    detection.height <= 0
  ) {
    return null;
  }
  return projectedRect(
    detection.x,
    detection.y,
    detection.x + detection.width,
    detection.y + detection.height,
    frame,
    stageWidth,
    stageHeight,
  );
}

function projectedRect(
  sourceLeft: number,
  sourceTop: number,
  sourceRight: number,
  sourceBottom: number,
  frame: NativeFrameSize,
  stageWidth: number,
  stageHeight: number,
): Rect | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const left = Math.max(0, sourceLeft);
  const top = Math.max(0, sourceTop);
  const right = Math.min(frame.width, sourceRight);
  const bottom = Math.min(frame.height, sourceBottom);
  if (right <= left || bottom <= top) return null;
  const scale = Math.min(stageWidth / frame.width, stageHeight / frame.height);
  const frameLeft = (stageWidth - frame.width * scale) / 2;
  const frameTop = (stageHeight - frame.height * scale) / 2;
  return {
    left: `${((frameLeft + left * scale) / stageWidth) * 100}%`,
    top: `${((frameTop + top * scale) / stageHeight) * 100}%`,
    width: `${((right - left) * scale / stageWidth) * 100}%`,
    height: `${((bottom - top) * scale / stageHeight) * 100}%`,
  };
}

function aspect(width: number, height: number): string {
  let a = width;
  let b = height;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return `${width / a}:${height / a}`;
}
