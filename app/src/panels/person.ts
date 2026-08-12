import {
  type NativeVisionAdapter,
  type PersonDetection,
  type PersonTargetState,
  type PersonVisionState,
} from "../lib/aruco.ts";
import type { FollowPort } from "../follow.ts";
import { installFollowControl } from "./follow-control.ts";
import { cls, must, text } from "../ui.ts";

export interface PersonTrackerPanel {
  dispose(): void;
}

export interface PersonTrackerDeps {
  readonly vision: NativeVisionAdapter;
  readonly follow: FollowPort;
}

const STATUS_BOX = "flex min-h-[32px] items-center gap-[8px] rounded-[3px] border px-[11px]";
const STATUS_DOT = "h-[6px] w-[6px] flex-none rounded-full";
const STATUS_COPY = "min-w-0 text-[11.5px]";

/** Same state vocabulary the ArUco panel uses; a lock reads identically in
 * both detectors, only the accent colour differs. */
const TARGET_LABEL: Record<PersonTargetState, string> = {
  inactive: "비활성",
  waitingFrame: "프레임 대기",
  unselected: "대상 미선택",
  searching: "화면에 없음",
  detected: "감지됨",
  error: "분석 오류",
};

const TARGET_BADGE_TONE: Record<PersonTargetState, string> = {
  inactive: "border border-line3 text-dim2",
  waitingFrame: "border border-line3 text-dim",
  unselected: "border border-line3 text-dim",
  searching: "border border-line3 text-dim",
  detected: "border-0 bg-ok text-[#07140A]",
  error: "border border-alert/45 text-alert2",
};

const TARGET_BADGE = "flex-none rounded-[2px] px-[7px] py-[3px] font-mono text-[9px] tracking-[.1em]";

function personStatus(state: PersonVisionState): {
  readonly box: string;
  readonly dot: string;
  readonly copy: string;
  readonly detail: string;
} {
  if (!state.active) {
    return {
      box: "border-line3 bg-raised",
      dot: "bg-dim3",
      copy: "text-dim",
      detail: "Native YOLO26n person detector가 비활성입니다.",
    };
  }
  if (state.status?.state === "error") {
    return {
      box: "border-alert/45 bg-alert/10",
      dot: "bg-alert",
      copy: "text-alert2",
      detail:
        state.status.detail === undefined
          ? "Native YOLO26n runtime 오류가 보고되었습니다."
          : `Native YOLO26n runtime 오류 · ${state.status.detail}`,
    };
  }
  if (state.status?.state === "inactive") {
    return {
      box: "border-line3 bg-raised",
      dot: "bg-dim3",
      copy: "text-dim",
      detail: "Native YOLO26n detector가 비활성 상태를 보고했습니다.",
    };
  }
  if (state.status?.state === "waitingFrame") {
    return {
      box: "border-line3 bg-raised",
      dot: "bg-dim",
      copy: "text-dim",
      detail: "Native YOLO26n detector가 디코드 프레임을 기다리는 중입니다.",
    };
  }
  if (state.recvEpochUs === null) {
    return {
      box: "border-line3 bg-raised",
      dot: "bg-dim",
      copy: "text-dim",
      detail:
        state.status?.state === "ready"
          ? "Native YOLO26n detector 준비됨 · 첫 결과 대기 중"
          : "Native YOLO26n detector 모드 요청됨 · 상태 이벤트 대기 중",
    };
  }
  return {
    box: "border-ok/35 bg-ok/10",
    dot: "bg-ok animate-beat",
    copy: "text-[#A8D9AE]",
    detail: `Native YOLO26n 결과 ${state.detections.length}개 · 분석 ${state.analysisMs === null ? "--" : `${state.analysisMs.toFixed(1)} ms`}`,
  };
}

function detectionFacts(detection: PersonDetection): string {
  return `CONF ${(detection.confidence * 100).toFixed(1)}% · BOX ${Math.round(detection.x)}, ${Math.round(detection.y)}, ${Math.round(
    detection.width,
  )} × ${Math.round(detection.height)} px`;
}

function emptyDetectionNote(state: PersonVisionState): string | null {
  if (!state.active) return "연결된 세션에서 사람 모드를 선택하면 native YOLO26n 결과를 표시합니다.";
  if (state.recvEpochUs === null) return "native YOLO26n detector의 첫 번째 결과를 기다리는 중입니다.";
  if (state.detections.length === 0) return "최신 native YOLO26n 결과에 사람 감지가 없습니다.";
  return null;
}

type DetectionRow = { button: HTMLButtonElement; chip: HTMLSpanElement; title: HTMLSpanElement; facts: HTMLSpanElement; tag: HTMLSpanElement };

/**
 * Reconciled by track id rather than rebuilt, for the same reason as the ArUco
 * list: a row replaced between mousedown and mouseup swallows the click, and
 * this list is the only way to lock a target.
 */
function reconcileDetectionRows(
  list: HTMLDivElement,
  note: HTMLDivElement,
  rows: Map<number, DetectionRow>,
  state: PersonVisionState,
): void {
  const message = emptyDetectionNote(state);
  note.hidden = message === null;
  if (message !== null) text(note, message);

  const seen = new Set<number>();
  for (const detection of message === null ? state.detections : []) {
    if (seen.has(detection.trackId)) continue;
    seen.add(detection.trackId);
    let row = rows.get(detection.trackId);
    if (row === undefined) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.targetId = String(detection.trackId);
      button.innerHTML = `
        <span data-k="chip" class="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[2px] border font-mono text-[10px]"></span>
        <span class="min-w-0 flex-1">
          <span data-k="title" class="block font-mono text-[12px] text-ink"></span>
          <span data-k="facts" class="block truncate font-mono text-[10px] leading-[1.55] text-dim"></span>
        </span>
        <span data-k="tag" class="rounded-[2px] bg-ok px-[6px] py-[2px] font-mono text-[9px] tracking-[.1em] text-[#07140A]" hidden>표시 대상</span>`;
      row = {
        button,
        chip: must("[data-k=chip]", HTMLSpanElement, button),
        title: must("[data-k=title]", HTMLSpanElement, button),
        facts: must("[data-k=facts]", HTMLSpanElement, button),
        tag: must("[data-k=tag]", HTMLSpanElement, button),
      };
      rows.set(detection.trackId, row);
      list.append(button);
    }

    const selected = state.target.id === detection.trackId;
    cls(
      row.button,
      `flex w-full items-center gap-[10px] rounded-[3px] border px-[10px] py-[8px] text-left cursor-pointer ${
        selected ? "border-ok/45 bg-ok/10 hover:bg-ok/15" : "border-line2 bg-sunken hover:border-line4 hover:bg-raised"
      }`,
    );
    cls(
      row.chip,
      `flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[2px] border font-mono text-[10px] ${
        selected ? "border-ok/65 text-ok" : "border-line4 text-ink2"
      }`,
    );
    text(row.chip, String(detection.trackId));
    text(row.title, `TRACK ${detection.trackId}`);
    text(row.facts, detectionFacts(detection));
    row.tag.hidden = !selected;
  }

  for (const [trackId, row] of rows) {
    if (seen.has(trackId)) continue;
    row.button.remove();
    rows.delete(trackId);
  }
}

export function installPersonTracker(mount: HTMLElement, deps: PersonTrackerDeps): PersonTrackerPanel {
  mount.innerHTML = `
    <section class="flex h-full min-h-0 flex-col gap-[13px] overflow-y-auto overflow-x-hidden p-[14px]" aria-label="Native person detector">
      <div data-k="person-status" role="status" class="${STATUS_BOX}">
        <div data-k="person-status-dot" class="${STATUS_DOT}"></div>
        <div data-k="person-status-copy" class="${STATUS_COPY}"></div>
      </div>
      <div class="text-[11px] leading-[1.6] text-dim2">Native YOLO26n detector only · confidence and boxes come from the latest native result.</div>

      <div class="flex items-center gap-[10px] rounded-[3px] border border-[#1E3021] border-l-2 border-l-ok bg-sunken px-[11px] py-[10px]">
        <div data-k="person-target-id" class="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[2px] border border-ok/45 font-mono text-[10px] text-ok">--</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-[7px]">
            <div class="font-mono text-[9.5px] tracking-[.14em] text-dim2">FOLLOW TARGET</div>
            <div data-k="person-target-title" class="font-mono text-[14px] text-ok">NONE</div>
          </div>
          <div data-k="person-target-detail" class="truncate text-[11px] text-dim">사람이 보이면 가장 가까운 한 명을 자동으로 따라갑니다 · 선택 없음</div>
        </div>
        <div data-k="person-target-badge" class="${TARGET_BADGE} border border-line3 text-dim2">--</div>
      </div>
      <div data-k="follow-mount"></div>

      <div class="flex items-center justify-between">
        <div data-k="person-detected" class="font-mono text-[10.5px] tracking-[.16em] text-dim2">DETECTED · 0</div>
        <div class="font-mono text-[10px] text-dim2">YOLO26N · NATIVE</div>
      </div>
      <div data-k="person-note" class="rounded-[3px] border border-line2 bg-sunken px-[10px] py-[10px] text-[11px] leading-[1.6] text-dim2" hidden></div>
      <div data-k="person-list" class="flex flex-col gap-[6px]"></div>
      <!-- No facts block: the status line above already states the detector,
           the result count and the analysis time, and the frame size is the
           overlay's. This panel is the detections and nothing else. -->
    </section>
  `;

  const statusBox = must("[data-k=person-status]", HTMLDivElement, mount);
  const statusDot = must("[data-k=person-status-dot]", HTMLDivElement, mount);
  const statusCopy = must("[data-k=person-status-copy]", HTMLDivElement, mount);
  const targetId = must("[data-k=person-target-id]", HTMLDivElement, mount);
  const targetTitle = must("[data-k=person-target-title]", HTMLDivElement, mount);
  const targetDetail = must("[data-k=person-target-detail]", HTMLDivElement, mount);
  const targetBadge = must("[data-k=person-target-badge]", HTMLDivElement, mount);
  const detected = must("[data-k=person-detected]", HTMLDivElement, mount);
  const list = must("[data-k=person-list]", HTMLDivElement, mount);
  const listNote = must("[data-k=person-note]", HTMLDivElement, mount);
  const detectionRowNodes = new Map<number, DetectionRow>();

  const paint = (next: PersonVisionState): void => {
    const status = personStatus(next);
    cls(statusBox, `${STATUS_BOX} ${status.box}`);
    cls(statusDot, `${STATUS_DOT} ${status.dot}`);
    cls(statusCopy, `${STATUS_COPY} ${status.copy}`);
    text(statusCopy, status.detail);

    cls(targetBadge, `${TARGET_BADGE} ${TARGET_BADGE_TONE[next.target.state]}`);
    text(targetBadge, TARGET_LABEL[next.target.state]);

    const idLabel = next.target.id === null ? "--" : String(next.target.id);
    text(targetId, idLabel);
    text(targetTitle, next.target.id === null ? "NONE" : `TRACK ${idLabel}`);
    if (next.target.detection !== null) {
      text(targetDetail, `가장 가까운 사람을 자동 추적 중 · ${detectionFacts(next.target.detection)}`);
    } else {
      text(targetDetail, "사람이 보이면 가장 가까운 한 명을 자동으로 따라갑니다 · 선택 없음");
    }

    text(detected, `DETECTED · ${next.detections.length}`);
    reconcileDetectionRows(list, listNote, detectionRowNodes, next);
  };

  // Nothing here is clickable any more: the target is whoever is nearest, and
  // there is no selection for a click to make.

  const unsubscribe = deps.vision.subscribePerson(paint);
  const followControl = installFollowControl(must("[data-k=follow-mount]", HTMLDivElement, mount), "ok", deps.follow);

  return {
    dispose(): void {
      followControl.dispose();
      unsubscribe();
    },
  };
}
