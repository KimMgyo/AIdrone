import {
  markerMetrics,
  NATIVE_ARUCO_DICTIONARY,
  type ArucoTargetState,
  type ArucoVisionState,
  type NativeVisionAdapter,
} from "../lib/aruco.ts";
import type { FollowPort } from "../follow.ts";
import type { VisionArucoEngineResult, VisionArucoEngineState } from "../transport.ts";
import { markerTargetPx, parseMarkerSize, type MarkerSizes } from "../marker-size.ts";
import { installFollowControl } from "./follow-control.ts";
import { cls, must, text } from "../ui.ts";

export interface ArucoPanelDeps {
  readonly vision: NativeVisionAdapter;
  readonly follow: FollowPort;
  readonly sizes: MarkerSizes;
}

export interface ArucoPanel {
  dispose(): void;
}

const TARGET_LABEL: Record<ArucoTargetState, string> = {
  inactive: "비활성",
  waitingFrame: "프레임 대기",
  unselected: "대상 미선택",
  searching: "화면에 없음",
  detected: "감지됨",
  error: "분석 오류",
};

const STATUS_TONE: Record<ArucoTargetState, { box: string; dot: string; copy: string; badge: string }> = {
  inactive: {
    box: "border-line3 bg-raised",
    dot: "bg-dim3",
    copy: "text-dim",
    badge: "border border-line3 text-dim2",
  },
  waitingFrame: {
    box: "border-line3 bg-raised",
    dot: "bg-dim",
    copy: "text-dim",
    badge: "border border-line3 text-dim",
  },
  unselected: {
    box: "border-line3 bg-raised",
    dot: "bg-dim",
    copy: "text-dim",
    badge: "border border-line3 text-dim",
  },
  searching: {
    box: "border-line3 bg-raised",
    dot: "bg-dim",
    copy: "text-dim",
    badge: "border border-line3 text-dim",
  },
  detected: {
    box: "border-warn/35 bg-warn/10",
    dot: "bg-warn animate-beat",
    copy: "text-[#F0D19A]",
    badge: "border-0 bg-warn text-[#1A1204]",
  },
  error: {
    box: "border-alert/45 bg-alert/10",
    dot: "bg-alert",
    copy: "text-alert2",
    badge: "border border-alert/45 text-alert2",
  },
};

type EnginePanelState = "waiting" | VisionArucoEngineState;

type EngineView = Readonly<{
  card: HTMLDivElement;
  badge: HTMLDivElement;
  timing: HTMLDivElement;
  ids: HTMLDivElement;
  detail: HTMLDivElement;
}>;

const ENGINE_STATE_LABEL: Record<EnginePanelState, string> = {
  waiting: "결과 대기",
  ready: "READY",
  error: "ERROR",
};

const ENGINE_TONE: Record<EnginePanelState, { card: string; badge: string }> = {
  waiting: {
    card: "border-line2 bg-sunken",
    badge: "border border-line3 text-dim2",
  },
  ready: {
    card: "border-line3 bg-raised",
    badge: "border border-line4 text-ink2",
  },
  error: {
    card: "border-alert/45 bg-alert/10",
    badge: "border border-alert/45 text-alert2",
  },
};

/** Ids with the two numbers that qualify them: hamming, and AprilTag's own
 *  decision margin. aruco-rs publishes no margin, so it simply has none. */
function engineSummary(result: VisionArucoEngineResult): string {
  if (result.markers.length === 0) return "없음";
  return result.markers
    .map((marker) => {
      const margin =
        result.engine === "aruco-rs" || marker.decisionMargin === undefined ? "" : ` · M ${marker.decisionMargin.toFixed(0)}`;
      return `ID ${marker.id} · H${marker.hammingDistance}${margin}`;
    })
    .join(" / ");
}

function paintEngine(view: EngineView, result: VisionArucoEngineResult | null): void {
  const state: EnginePanelState = result?.state ?? "waiting";
  const tone = ENGINE_TONE[state];
  cls(view.card, `rounded-[3px] border px-[9px] py-[7px] ${tone.card}`);
  cls(view.badge, `flex-none rounded-[2px] px-[5px] py-[1px] font-mono text-[8.5px] tracking-[.1em] ${tone.badge}`);
  text(view.badge, ENGINE_STATE_LABEL[state]);
  text(view.timing, result === null ? "--" : `${result.analysisMs.toFixed(1)} ms`);
  text(view.ids, result === null || result.state === "error" ? "--" : engineSummary(result));
  const detail = result?.state === "error" ? result.detail : undefined;
  view.detail.hidden = detail === undefined;
  if (detail !== undefined) text(view.detail, detail);
}

/** A state word, not a sentence: the empty list is a reading like any other. */
function emptyMarkerNote(state: ArucoVisionState): string | null {
  if (!state.active) return "비활성";
  if (state.recvEpochUs === null) return "결과 대기";
  if (state.comparison?.engines[0].state === "error") return "AprilTag 3 오류";
  if (state.markers.length === 0) return "감지 없음";
  return null;
}

type MarkerRow = {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  chip: HTMLSpanElement;
  title: HTMLSpanElement;
  facts: HTMLSpanElement;
  tag: HTMLSpanElement;
  sizeBox: HTMLLabelElement;
  size: HTMLInputElement;
};

/** Shared because the size field's frame is painted from the markup and from `paintSizeField`. */
const SIZE_BOX = "flex flex-none items-center gap-[4px] rounded-[3px] border px-[7px]";

/**
 * The registry refuses to store a measurement it cannot parse, so the only
 * record that the operator typed something unusable is the text still sitting
 * in the field. This reads that back rather than tracking a flag beside a row
 * that repaints at stream rate and would have to keep the two in step.
 */
function paintSizeField(row: MarkerRow): void {
  const rejected = row.size.value.trim() !== "" && parseMarkerSize(row.size.value) === null;
  cls(row.sizeBox, `${SIZE_BOX} ${rejected ? "border-alert/45 bg-alert/10" : "border-line2 bg-sunken"}`);
}

/**
 * Rows are reconciled by marker id, never re-created from a template string.
 * The detector now publishes at the stream's own rate, and rebuilding this
 * list on each observation replaced the button under the pointer between
 * mousedown and mouseup - which is a click the browser never reports, and an
 * operator who cannot lock a target no matter how carefully they aim.
 */
function reconcileMarkerRows(
  list: HTMLDivElement,
  note: HTMLDivElement,
  rows: Map<number, MarkerRow>,
  state: ArucoVisionState,
  sizes: MarkerSizes,
): void {
  const message = emptyMarkerNote(state);
  note.hidden = message === null;
  if (message !== null) text(note, message);

  const seen = new Set<number>();
  for (const marker of message === null ? state.markers : []) {
    if (seen.has(marker.id)) continue;
    seen.add(marker.id);
    let row = rows.get(marker.id);
    if (row === undefined) {
      const id = marker.id;
      const root = document.createElement("div");
      root.className = "flex items-stretch gap-[7px]";
      // The size field is `type="text"`: a number field hands back an empty
      // string for input it cannot parse, which would turn a typo into
      // "forget this marker's size" instead of showing it as rejected.
      root.innerHTML = `
        <button data-k="select" type="button" class="flex min-w-0 flex-1 items-center gap-[10px] rounded-[3px] border px-[10px] py-[8px] text-left">
          <span data-k="chip" class="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[2px] border font-mono text-[10px]"></span>
          <span class="min-w-0 flex-1">
            <span data-k="title" class="block font-mono text-[12px] text-ink"></span>
            <span data-k="facts" class="block truncate font-mono text-[10px] leading-[1.55] text-dim"></span>
          </span>
          <span data-k="tag" class="rounded-[2px] bg-warn px-[6px] py-[2px] font-mono text-[9px] tracking-[.1em] text-[#1A1204]" hidden>표시 대상</span>
        </button>
        <label data-k="size-box" class="${SIZE_BOX} border-line2 bg-sunken">
          <input data-k="size" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
            class="w-[40px] min-w-0 border-none bg-transparent text-right font-mono text-[11px] text-ink outline-none" />
          <span class="font-mono text-[9.5px] text-dim2">cm</span>
        </label>`;
      const button = must("[data-k=select]", HTMLButtonElement, root);
      button.dataset.targetId = String(id);
      const size = must("[data-k=size]", HTMLInputElement, root);
      size.setAttribute("aria-label", `ID ${id} 마커 한 변 길이 (cm)`);
      const created: MarkerRow = {
        root,
        button,
        chip: must("[data-k=chip]", HTMLSpanElement, root),
        title: must("[data-k=title]", HTMLSpanElement, root),
        facts: must("[data-k=facts]", HTMLSpanElement, root),
        tag: must("[data-k=tag]", HTMLSpanElement, root),
        sizeBox: must("[data-k=size-box]", HTMLLabelElement, root),
        size,
      };
      // `change`, not `input`: the half-typed "1" of "15" would register as a
      // 1 cm tag, and the drone holds distance by apparent size - it would
      // close to touching range on the way to the second digit.
      size.addEventListener("change", () => {
        const raw = size.value;
        if (raw.trim() === "") {
          sizes.set(id, null);
        } else {
          const cm = parseMarkerSize(raw);
          // A rejected entry leaves the stored size alone: fixing one digit
          // must not cost the operator a marker they already measured.
          if (cm !== null) sizes.set(id, cm);
        }
        paintSizeField(created);
      });
      row = created;
      rows.set(id, created);
      list.append(root);
    }

    const metrics = markerMetrics(marker);
    const selected = marker.id === state.target.id;
    const sizeCm = sizes.get(marker.id);
    // No measurement, no selection. The follow loop steers on apparent size,
    // so an unmeasured tag would be held at a distance nobody chose - and the
    // failure mode of guessing too small is flying too close.
    const followable = sizeCm !== null;
    row.button.disabled = !followable;
    cls(
      row.button,
      `flex min-w-0 flex-1 items-center gap-[10px] rounded-[3px] border px-[10px] py-[8px] text-left ${
        !followable
          ? "cursor-not-allowed border-line2 bg-sunken text-dim2 opacity-60"
          : selected
            ? "cursor-pointer border-warn/45 bg-warn/10 hover:bg-warn/15"
            : "cursor-pointer border-line2 bg-sunken hover:border-line4 hover:bg-raised"
      }`,
    );
    cls(
      row.chip,
      `flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[2px] border font-mono text-[10px] ${
        !followable ? "border-line3 text-dim2" : selected ? "border-warn/65 text-warn" : "border-line4 text-ink2"
      }`,
    );
    text(row.chip, String(marker.id));
    text(row.title, `ID ${marker.id}`);
    const facts = `H ${marker.hammingDistance} · ${Math.round(metrics.area)} px² · (${Math.round(metrics.centerX)}, ${Math.round(metrics.centerY)})`;
    // No "measure this first" hint: the size box sits at the end of this very
    // row, and an empty one says it without spending a line saying it.
    text(row.facts, sizeCm === null ? facts : `${facts} · ${sizeCm} cm → ${Math.round(markerTargetPx(sizeCm))} px`);
    row.tag.hidden = !selected;

    // The registry owns this field only while the operator is not using it.
    // Two ways it is in use: focused, or holding text the registry refused.
    // Observations land at the stream's rate, so overwriting either one means
    // the digits vanish mid-entry, or a rejection flashes red for one frame
    // and is gone before anybody reads it. The rejected text IS the record -
    // see `paintSizeField` - so it has to survive until they edit again.
    const holdingRejection = row.size.value.trim() !== "" && parseMarkerSize(row.size.value) === null;
    if (row.size !== document.activeElement && !holdingRejection) {
      const value = sizeCm === null ? "" : String(sizeCm);
      if (row.size.value !== value) row.size.value = value;
      paintSizeField(row);
    }
  }

  for (const [id, row] of rows) {
    if (seen.has(id)) continue;
    row.root.remove();
    rows.delete(id);
  }
}

/** A fragment, never a sentence. The status line is a reading; anything that
 *  had to be explained in prose did not belong on the panel. */
function detectorStatus(state: ArucoVisionState): string {
  if (!state.active) return "비활성";
  if (state.status?.state === "error") {
    return state.status.detail === undefined ? "오류" : `오류 · ${state.status.detail}`;
  }
  if (state.status?.state === "inactive") return "비활성";
  if (state.status?.state === "waitingFrame") return "프레임 대기";
  const primary = state.comparison?.engines[0] ?? null;
  if (primary?.state === "error") {
    return primary.detail === undefined ? "AprilTag 3 오류" : `AprilTag 3 오류 · ${primary.detail}`;
  }
  if (state.recvEpochUs === null) return "결과 대기";
  return `AprilTag 3 · ${state.markers.length}개 · ${state.analysisMs === null ? "--" : `${state.analysisMs.toFixed(1)} ms`}`;
}

export function installArucoPanel(mount: HTMLElement, deps: ArucoPanelDeps): ArucoPanel {
  mount.innerHTML = `
    <section class="flex h-full min-h-0 flex-col gap-[10px] overflow-y-auto overflow-x-hidden p-[14px]" aria-label="ArUco marker detector">
      <div data-k="status-box" role="status" class="flex min-h-[30px] items-center gap-[8px] rounded-[3px] border px-[10px]">
        <div data-k="status-dot" class="h-[6px] w-[6px] flex-none rounded-full"></div>
        <div data-k="status" class="min-w-0 flex-1 truncate text-[11.5px]"></div>
        <div class="flex-none font-mono text-[9px] tracking-[.1em] text-dim2">${NATIVE_ARUCO_DICTIONARY}</div>
      </div>

      <div class="flex items-center gap-[8px] rounded-[3px] border border-[#2A2418] border-l-2 border-l-warn bg-sunken px-[10px] py-[8px]">
        <div class="flex-none font-mono text-[9.5px] tracking-[.14em] text-dim2">TARGET</div>
        <div data-k="target-title" class="min-w-0 flex-1 truncate font-mono text-[13px] text-warn">--</div>
        <div data-k="target-badge" class="flex-none rounded-[2px] px-[6px] py-[2px] font-mono text-[9px] tracking-[.1em]">--</div>
        <button data-k="clear" type="button" data-action="clear-target" hidden class="h-[21px] flex-none rounded-[2px] border border-line4 bg-key px-[7px] font-mono text-[9.5px] text-dim cursor-pointer hover:bg-btn hover:text-ink2">해제</button>
      </div>
      <div data-k="follow-mount"></div>

      <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">DETECTED · <span data-k="count">0</span></div>
      <div data-k="marker-note" class="font-mono text-[10.5px] text-dim2" hidden></div>
      <div data-k="marker-list" class="flex flex-col gap-[6px]"></div>

      <div class="flex flex-col gap-[5px] border-t border-line2 pt-[9px]">
        <div data-k="engine-apriltag-card" class="rounded-[3px] border">
          <div class="flex items-baseline gap-[7px] font-mono text-[10px] leading-[1.5]">
            <div class="w-[62px] flex-none tracking-[.1em] text-ink2">APRILTAG3</div>
            <div data-k="engine-apriltag-time" class="w-[48px] flex-none text-ink">--</div>
            <div data-k="engine-apriltag-ids" class="min-w-0 flex-1 truncate text-dim">--</div>
            <div data-k="engine-apriltag-badge"></div>
          </div>
          <div data-k="engine-apriltag-detail" hidden class="mt-[5px] break-words font-mono text-[9px] leading-[1.45] text-alert2"></div>
        </div>
        <div data-k="engine-aruco-card" class="rounded-[3px] border">
          <div class="flex items-baseline gap-[7px] font-mono text-[10px] leading-[1.5]">
            <div class="w-[62px] flex-none tracking-[.1em] text-ink2">ARUCO-RS</div>
            <div data-k="engine-aruco-time" class="w-[48px] flex-none text-ink">--</div>
            <div data-k="engine-aruco-ids" class="min-w-0 flex-1 truncate text-dim">--</div>
            <div data-k="engine-aruco-badge"></div>
          </div>
          <div data-k="engine-aruco-detail" hidden class="mt-[5px] break-words font-mono text-[9px] leading-[1.45] text-alert2"></div>
        </div>
      </div>
    </section>
  `;

  const statusBox = must("[data-k=status-box]", HTMLDivElement, mount);
  const statusDot = must("[data-k=status-dot]", HTMLDivElement, mount);
  const status = must("[data-k=status]", HTMLDivElement, mount);
  const targetTitle = must("[data-k=target-title]", HTMLDivElement, mount);
  const targetBadge = must("[data-k=target-badge]", HTMLDivElement, mount);
  const clear = must("[data-k=clear]", HTMLButtonElement, mount);
  const count = must("[data-k=count]", HTMLSpanElement, mount);
  const markerList = must("[data-k=marker-list]", HTMLDivElement, mount);
  const markerNote = must("[data-k=marker-note]", HTMLDivElement, mount);
  const markerRowNodes = new Map<number, MarkerRow>();
  const arucoEngine: EngineView = {
    card: must("[data-k=engine-aruco-card]", HTMLDivElement, mount),
    badge: must("[data-k=engine-aruco-badge]", HTMLDivElement, mount),
    timing: must("[data-k=engine-aruco-time]", HTMLDivElement, mount),
    ids: must("[data-k=engine-aruco-ids]", HTMLDivElement, mount),
    detail: must("[data-k=engine-aruco-detail]", HTMLDivElement, mount),
  };
  const apriltagEngine: EngineView = {
    card: must("[data-k=engine-apriltag-card]", HTMLDivElement, mount),
    badge: must("[data-k=engine-apriltag-badge]", HTMLDivElement, mount),
    timing: must("[data-k=engine-apriltag-time]", HTMLDivElement, mount),
    ids: must("[data-k=engine-apriltag-ids]", HTMLDivElement, mount),
    detail: must("[data-k=engine-apriltag-detail]", HTMLDivElement, mount),
  };

  let current = deps.vision.arucoSnapshot();

  const paint = (next: ArucoVisionState): void => {
    current = next;
    const tone = STATUS_TONE[next.target.state];
    cls(statusBox, `flex min-h-[30px] items-center gap-[8px] rounded-[3px] border px-[10px] ${tone.box}`);
    cls(statusDot, `h-[6px] w-[6px] flex-none rounded-full ${tone.dot}`);
    cls(targetBadge, `flex-none rounded-[2px] px-[6px] py-[2px] font-mono text-[9px] tracking-[.1em] ${tone.badge}`);
    cls(status, `min-w-0 flex-1 truncate text-[11.5px] ${tone.copy}`);
    text(status, detectorStatus(next));

    // A target whose size has since been cleared is not being followed, so the
    // badge says which of the two it is rather than a sentence saying why.
    const targetSizeCm = next.target.id === null ? null : deps.sizes.get(next.target.id);
    text(targetBadge, next.target.id !== null && targetSizeCm === null ? "크기 필요" : TARGET_LABEL[next.target.state]);
    // The only control on this panel, and it is only shown when there is a
    // lock for it to release.
    clear.hidden = next.target.id === null;
    text(targetTitle, next.target.id === null ? "--" : `ID ${next.target.id}`);

    text(count, String(next.markers.length));
    reconcileMarkerRows(markerList, markerNote, markerRowNodes, next, deps.sizes);
    paintEngine(apriltagEngine, next.comparison?.engines[0] ?? null);
    paintEngine(arucoEngine, next.comparison?.engines[1] ?? null);
  };

  const onClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (button === null || !mount.contains(button)) return;
    if (button.dataset.action === "clear-target") {
      deps.vision.setArucoTarget(null);
      return;
    }
    const encoded = button.dataset.targetId;
    if (encoded === undefined) return;
    const id = Number(encoded);
    if (!Number.isSafeInteger(id) || id < 0 || !current.markers.some((marker) => marker.id === id)) return;
    // Refused here as well as disabled in the markup, because a disabled
    // button is a rendering detail and this is the safety rule.
    if (deps.sizes.get(id) === null) return;
    deps.vision.setArucoTarget(id);
  };

  mount.addEventListener("click", onClick);
  const unsubscribe = deps.vision.subscribeAruco(paint);
  const unsubscribeSizes = deps.sizes.subscribe(() => {
    paint(current);
  });
  const followControl = installFollowControl(must("[data-k=follow-mount]", HTMLDivElement, mount), "warn", deps.follow);

  return {
    dispose(): void {
      followControl.dispose();
      unsubscribe();
      unsubscribeSizes();
      mount.removeEventListener("click", onClick);
    },
  };
}
