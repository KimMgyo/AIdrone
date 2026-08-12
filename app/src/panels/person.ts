import {
  type NativeVisionAdapter,
  type PersonDetection,
  type PersonVisionState,
} from "../lib/aruco.ts";
import type { FollowPort } from "../follow.ts";
import { installTargetBox } from "./target-box.ts";
import { cls, must, text } from "../ui.ts";

export interface PersonTrackerPanel {
  dispose(): void;
}

export interface PersonTrackerDeps {
  readonly vision: NativeVisionAdapter;
  readonly follow: FollowPort;
}

/**
 * The detector's own line inside the TARGET box: which engine, and how long
 * this frame took it. The result count is NOT here - `DETECTED · N` below is
 * its one home, and this line sat above it saying the same number.
 */
function personEngine(state: PersonVisionState): string {
  if (!state.active) return "YOLO26n · 비활성";
  if (state.recvEpochUs === null) return "YOLO26n · 결과 대기";
  return `YOLO26n · ${state.analysisMs === null ? "--" : `${state.analysisMs.toFixed(1)} ms`}`;
}

/** A detector fault, in fragments, or `null` when it is running. Only these
 *  outrank the follow phase in the box's badge. */
function personTrouble(state: PersonVisionState): string | null {
  if (!state.active) return "비활성";
  if (state.status?.state === "error") return "분석 오류";
  if (state.status?.state === "inactive") return "비활성";
  if (state.status?.state === "waitingFrame") return "프레임 대기";
  if (state.recvEpochUs === null) return "결과 대기";
  return null;
}

function detectionFacts(detection: PersonDetection): string {
  return `CONF ${(detection.confidence * 100).toFixed(1)}% · BOX ${Math.round(detection.x)}, ${Math.round(detection.y)}, ${Math.round(
    detection.width,
  )} × ${Math.round(detection.height)} px`;
}

/** A state word, not a sentence. */
function emptyDetectionNote(state: PersonVisionState): string | null {
  if (!state.active) return "비활성";
  if (state.recvEpochUs === null) return "결과 대기";
  if (state.detections.length === 0) return "감지 없음";
  return null;
}

type DetectionRow = { root: HTMLDivElement; chip: HTMLSpanElement; title: HTMLSpanElement; facts: HTMLSpanElement; tag: HTMLSpanElement };

/**
 * Reconciled by track id rather than rebuilt: rows replaced at stream rate
 * flicker, and the list is read while the drone is moving. Nothing here is a
 * button - the target is whoever is nearest, so there is no click to make and
 * a row must not look like it offers one.
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
      const root = document.createElement("div");
      root.innerHTML = `
        <span data-k="chip" class="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[2px] border font-mono text-[10px]"></span>
        <span class="min-w-0 flex-1">
          <span data-k="title" class="block font-mono text-[12px] text-ink"></span>
          <span data-k="facts" class="block truncate font-mono text-[10px] leading-[1.55] text-dim"></span>
        </span>
        <span data-k="tag" class="rounded-[2px] bg-ok px-[6px] py-[2px] font-mono text-[9px] tracking-[.1em] text-[#07140A]" hidden>표시 대상</span>`;
      row = {
        root,
        chip: must("[data-k=chip]", HTMLSpanElement, root),
        title: must("[data-k=title]", HTMLSpanElement, root),
        facts: must("[data-k=facts]", HTMLSpanElement, root),
        tag: must("[data-k=tag]", HTMLSpanElement, root),
      };
      rows.set(detection.trackId, row);
      list.append(root);
    }

    const selected = state.target.id === detection.trackId;
    cls(
      row.root,
      `flex w-full items-center gap-[10px] rounded-[3px] border px-[10px] py-[8px] ${
        selected ? "border-ok/45 bg-ok/10" : "border-line2 bg-sunken"
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
    row.root.remove();
    rows.delete(trackId);
  }
}

export function installPersonTracker(mount: HTMLElement, deps: PersonTrackerDeps): PersonTrackerPanel {
  mount.innerHTML = `
    <section class="flex h-full min-h-0 flex-col gap-[10px] overflow-y-auto overflow-x-hidden p-[14px]" aria-label="Native person detector">
      <!-- Two sections and no more: who is being followed, and what was seen.
           The detector's own line lives inside the first because it is the
           evidence behind it, not a third subject. -->
      <div data-k="target-mount"></div>

      <div data-k="person-detected" class="font-mono text-[10.5px] tracking-[.16em] text-dim2">DETECTED · 0</div>
      <div data-k="person-note" class="font-mono text-[10.5px] text-dim2" hidden></div>
      <div data-k="person-list" class="flex flex-col gap-[6px]"></div>
    </section>
  `;

  const detected = must("[data-k=person-detected]", HTMLDivElement, mount);
  const list = must("[data-k=person-list]", HTMLDivElement, mount);
  const listNote = must("[data-k=person-note]", HTMLDivElement, mount);
  const detectionRowNodes = new Map<number, DetectionRow>();
  // No clear button: the target is whoever is nearest, so there is no lock to
  // release and a control offering to would do nothing.
  const target = installTargetBox(must("[data-k=target-mount]", HTMLDivElement, mount), "ok", deps.follow);

  const paint = (next: PersonVisionState): void => {
    target.update({
      title: next.target.id === null ? "--" : `TRACK ${next.target.id}`,
      engine: personEngine(next),
      trouble: personTrouble(next),
      locked: next.target.id !== null,
    });
    text(detected, `DETECTED · ${next.detections.length}`);
    reconcileDetectionRows(list, listNote, detectionRowNodes, next);
  };

  const unsubscribe = deps.vision.subscribePerson(paint);

  return {
    dispose(): void {
      target.dispose();
      unsubscribe();
    },
  };
}
