import {
  markerMetrics,
  NATIVE_ARUCO_DICTIONARY,
  type ArucoVisionState,
  type NativeVisionAdapter,
} from "../lib/aruco.ts";
import type { FollowPort } from "../follow.ts";
import { markerTargetPx, parseMarkerSize, type MarkerSizes } from "../marker-size.ts";
import { installTargetBox } from "./target-box.ts";
import { cls, must, text } from "../ui.ts";

export interface ArucoPanelDeps {
  readonly vision: NativeVisionAdapter;
  readonly follow: FollowPort;
  readonly sizes: MarkerSizes;
}

export interface ArucoPanel {
  dispose(): void;
}

/** A state word, not a sentence: the empty list is a reading like any other. */
function emptyMarkerNote(state: ArucoVisionState): string | null {
  if (!state.active) return "비활성";
  if (state.recvEpochUs === null) return "결과 대기";
  if (state.observation?.state === "error") return "AprilTag 3 오류";
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

/**
 * The detector's own line inside the TARGET box: the primary engine, the
 * dictionary it reads, and how long this frame took. The marker count is NOT
 * here - `DETECTED · N` below owns it.
 */
function detectorStatus(state: ArucoVisionState): string {
  if (!state.active) return `AprilTag 3 · ${NATIVE_ARUCO_DICTIONARY} · 비활성`;
  if (state.recvEpochUs === null) return `AprilTag 3 · ${NATIVE_ARUCO_DICTIONARY} · 결과 대기`;
  const ms = state.analysisMs === null ? "--" : `${state.analysisMs.toFixed(1)} ms`;
  return `AprilTag 3 · ${NATIVE_ARUCO_DICTIONARY} · ${ms}`;
}

/** A detector fault, in fragments, or `null` when it is running. Only these
 *  outrank the follow phase in the box's badge. */
function arucoTrouble(state: ArucoVisionState): string | null {
  if (!state.active) return "비활성";
  if (state.status?.state === "error") return "오류";
  if (state.status?.state === "inactive") return "비활성";
  if (state.status?.state === "waitingFrame") return "프레임 대기";
  if (state.observation?.state === "error") return "AprilTag 3 오류";
  if (state.recvEpochUs === null) return "결과 대기";
  return null;
}

export function installArucoPanel(mount: HTMLElement, deps: ArucoPanelDeps): ArucoPanel {
  mount.innerHTML = `
    <section class="flex h-full min-h-0 flex-col gap-[10px] overflow-y-auto overflow-x-hidden p-[14px]" aria-label="ArUco marker detector">
      <!-- The same two sections as the person panel: who is being followed,
           and what was seen. Nothing else - the A/B engine rows that used to
           sit here went with the comparison engine they existed to show. -->
      <div data-k="target-mount"></div>

      <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">DETECTED · <span data-k="count">0</span></div>
      <div data-k="marker-note" class="font-mono text-[10.5px] text-dim2" hidden></div>
      <div data-k="marker-list" class="flex flex-col gap-[6px]"></div>
    </section>
  `;

  const count = must("[data-k=count]", HTMLSpanElement, mount);
  const markerList = must("[data-k=marker-list]", HTMLDivElement, mount);
  const markerNote = must("[data-k=marker-note]", HTMLDivElement, mount);
  const markerRowNodes = new Map<number, MarkerRow>();

  let current = deps.vision.arucoSnapshot();
  const target = installTargetBox(must("[data-k=target-mount]", HTMLDivElement, mount), "warn", deps.follow, () =>
    deps.vision.setArucoTarget(null),
  );

  const paint = (next: ArucoVisionState): void => {
    current = next;
    // A target whose size has since been cleared is not being followed, so the
    // badge says which of the two it is rather than a sentence saying why.
    const targetSizeCm = next.target.id === null ? null : deps.sizes.get(next.target.id);
    target.update({
      title: next.target.id === null ? "--" : `ID ${next.target.id}`,
      engine: detectorStatus(next),
      trouble:
        next.target.id !== null && targetSizeCm === null ? "크기 필요" : arucoTrouble(next),
      locked: next.target.id !== null,
    });

    text(count, String(next.markers.length));
    reconcileMarkerRows(markerList, markerNote, markerRowNodes, next, deps.sizes);
  };

  const onClick = (event: MouseEvent): void => {
    // The clear button lives inside the target box and has its own handler;
    // this only owns the marker rows.
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (button === null || !mount.contains(button)) return;
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

  return {
    dispose(): void {
      target.dispose();
      unsubscribe();
      unsubscribeSizes();
      mount.removeEventListener("click", onClick);
    },
  };
}
