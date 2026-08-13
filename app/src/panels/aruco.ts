import {
  markerMetrics,
  NATIVE_ARUCO_DICTIONARY,
  type ArucoVisionState,
  type NativeVisionAdapter,
} from "../lib/aruco.ts";
import type { FollowPort } from "../follow.ts";
import { markerCodes } from "../transport.ts";
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

/**
 * A state word, not a sentence. An empty roster is a different reading from a
 * detector that is not running, and neither is a sentence about what to do.
 */
function emptyRosterNote(state: ArucoVisionState): string | null {
  if (!state.active) return "비활성";
  if (state.observation?.state === "error") return "AprilTag 3 오류";
  if (state.known.length > 0) return null;
  if (state.recvEpochUs === null) return "결과 대기";
  return "등록된 마커 없음";
}

type MarkerRow = {
  root: HTMLDivElement;
  button: HTMLButtonElement;
  chip: HTMLCanvasElement;
  title: HTMLSpanElement;
  facts: HTMLSpanElement;
  tag: HTMLSpanElement;
  sizeBox: HTMLLabelElement;
  forget: HTMLButtonElement;
  size: HTMLInputElement;
};

/** Shared because the size field's frame is painted from the markup and from `paintSizeField`. */
const SIZE_BOX = "flex flex-none items-center gap-[4px] rounded-[3px] border px-[7px]";

/**
 * `selected` tints the whole row, not just the button: the size field and the
 * remove control belong to the marker being followed as much as its name does,
 * and leaving them grey made the row look half-selected.
 */
function paintSizeField(row: MarkerRow, selected: boolean): void {
  const rejected = row.size.value.trim() !== "" && parseMarkerSize(row.size.value) === null;
  const frame = rejected
    ? "border-alert/45 bg-alert/10"
    : selected
      ? "border-warn/45 bg-warn/10"
      : "border-line2 bg-sunken";
  cls(row.sizeBox, `${SIZE_BOX} ${frame}`);
  cls(
    row.forget,
    `${FORGET_BUTTON} ${
      selected ? "border-warn/45 bg-warn/10 text-warn" : "border-line2 bg-sunken text-dim2"
    } hover:border-alert/45 hover:text-alert2`,
  );
}

const FORGET_BUTTON = "w-[24px] flex-none rounded-[3px] border font-mono text-[12px] cursor-pointer";

/**
 * Rows are reconciled by marker id, never re-created from a template string.
 * The detector publishes at the stream's own rate, and rebuilding this list on
 * each observation replaced the button under the pointer between mousedown and
 * mouseup - a click the browser never reports.
 */

/**
 * One payload cell on the drawing pad.
 *
 * A hairline ring rather than a gap: the pad has to be comparable to a printed
 * marker at a glance, and gaps between cells change the shape. The ring is dim
 * enough to vanish against a filled neighbour and just enough to show the 6x6
 * structure when every cell is black, which is how the pad starts.
 */
const PAD_CELL = "h-[17px] w-[17px] cursor-pointer ring-inset ring-[0.5px] ring-[#1E242B]";
const PAD_CELL_OFF = `${PAD_CELL} bg-black`;
const PAD_CELL_ON = `${PAD_CELL} bg-white`;

/**
 * Geometry for all three pad actions, shared so they cannot drift apart.
 *
 * The three differ by colour only. Sizing them individually is how one of them
 * ends up a few pixels shorter than the others, and a column of buttons that do
 * not line up reads as three unrelated controls instead of one set.
 */
const PAD_BUTTON = "h-[26px] w-full rounded-[3px] border px-[9px] font-mono text-[10.5px]";

function reconcileMarkerRows(
  list: HTMLDivElement,
  note: HTMLDivElement,
  rows: Map<number, MarkerRow>,
  state: ArucoVisionState,
  sizes: MarkerSizes,
  codes: readonly number[],
): void {
  const message = emptyRosterNote(state);
  note.hidden = message === null;
  if (message !== null) text(note, message);

  const seen = new Set<number>();
  for (const entry of state.known) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    let row = rows.get(entry.id);
    if (row === undefined) {
      const id = entry.id;
      const root = document.createElement("div");
      root.className = "flex items-stretch gap-[7px]";
      // The size field is `type="text"`: a number field hands back an empty
      // string for input it cannot parse, which would turn a typo into
      // "forget this marker's size" instead of showing it as rejected.
      root.innerHTML = `
        <button data-k="select" type="button" class="flex min-w-0 flex-1 items-center gap-[10px] rounded-[3px] border px-[10px] py-[8px] text-left">
          <canvas data-k="chip" class="h-[30px] w-[30px] flex-none rounded-[2px]" style="image-rendering:pixelated"></canvas>
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
        </label>
        <button data-k="forget" type="button" title="목록에서 제거" class="${FORGET_BUTTON} border-line2 bg-sunken text-dim2">×</button>`;
      const button = must("[data-k=select]", HTMLButtonElement, root);
      button.dataset.targetId = String(id);
      const forget = must("[data-k=forget]", HTMLButtonElement, root);
      forget.dataset.forgetId = String(id);
      const size = must("[data-k=size]", HTMLInputElement, root);
      size.setAttribute("aria-label", `ID ${id} 마커 한 변 길이 (cm)`);
      const created: MarkerRow = {
        root,
        button,
        chip: must("[data-k=chip]", HTMLCanvasElement, root),
        title: must("[data-k=title]", HTMLSpanElement, root),
        facts: must("[data-k=facts]", HTMLSpanElement, root),
        tag: must("[data-k=tag]", HTMLSpanElement, root),
        sizeBox: must("[data-k=size-box]", HTMLLabelElement, root),
        forget,
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
        paintSizeField(created, id === state.target.id);
      });
      row = created;
      rows.set(id, created);
      list.append(root);
    }

    const marker = entry.marker;
    const selected = entry.id === state.target.id;
    const sizeCm = sizes.get(entry.id);
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
    // The chip is the marker's own pattern, not its number: an operator holding
    // a print matches it by looking, and the digits are on the line beside it.
    // Drawn once per id, because a codeword does not change.
    if (row.chip.dataset.drawn !== String(entry.id) && codes.length > entry.id) {
      drawMarker(row.chip, codes[entry.id], 4);
      row.chip.dataset.drawn = String(entry.id);
    }
    row.chip.style.opacity = followable ? "1" : "0.45";
    text(row.title, `ID ${entry.id}`);
    // A row on the roster but not in this frame has no geometry to print, and
    // printing the last frame's would be a position the drone is not seeing.
    const facts =
      marker === null
        ? "화면에 없음"
        : (() => {
            const metrics = markerMetrics(marker);
            return `H ${marker.hammingDistance} · ${Math.round(metrics.area)} px² · (${Math.round(metrics.centerX)}, ${Math.round(metrics.centerY)})`;
          })();
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
      paintSizeField(row, selected);
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

function readId(encoded: string | undefined): number | null {
  if (encoded === undefined) return null;
  const id = Number(encoded);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/** Payload cells across one marker, and the quiet black border around them. */
const MIP_CELLS = 6;
const MARKER_CELLS = MIP_CELLS + 2;

/**
 * Draws one dictionary id at `cell` device pixels per marker cell.
 *
 * The code is row-major with bit 35 at the top-left payload cell, which is how
 * `aruco-rs` stores it and what `apriltag3.rs` repacks away from. A set bit is
 * white; the border is always black. Drawing from the same list the detector
 * decodes is the point - a second hand-drawn table would be free to disagree
 * with the thing the drone is actually looking for.
 */
function drawMarker(canvas: HTMLCanvasElement, code: number, cell: number): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const size = MARKER_CELLS * cell;
  canvas.width = size;
  canvas.height = size;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#fff";
  for (let row = 0; row < MIP_CELLS; row++) {
    for (let column = 0; column < MIP_CELLS; column++) {
      const bit = row * MIP_CELLS + column;
      // `2 ** n`, not `1 << n`: the shift operators coerce to int32 and this
      // code is 36 bits, so bit 35 would come back negative and bits above 31
      // would vanish entirely.
      if (Math.floor(code / 2 ** (35 - bit)) % 2 === 1) {
        ctx.fillRect((column + 1) * cell, (row + 1) * cell, cell, cell);
      }
    }
  }
}

/** Packs a 6x6 boolean grid the way the dictionary stores it: row-major, bit
 *  35 at the top-left. */
function packGrid(grid: readonly boolean[]): number {
  let code = 0;
  for (const on of grid) code = code * 2 + (on ? 1 : 0);
  return code;
}

/** `packGrid`'s inverse: one dictionary code back into the 6x6 grid it packs from. */
function unpackGrid(code: number): boolean[] {
  const out: boolean[] = [];
  // `2 ** n`, never a shift - same 36-bit reason as `drawMarker`.
  for (let bit = 0; bit < MIP_CELLS * MIP_CELLS; bit++) out.push(Math.floor(code / 2 ** (35 - bit)) % 2 === 1);
  return out;
}

/** One quarter turn clockwise. */
function rotateGrid(grid: readonly boolean[]): boolean[] {
  const out: boolean[] = [];
  for (let row = 0; row < MIP_CELLS; row++) {
    for (let column = 0; column < MIP_CELLS; column++) {
      out.push(grid[(MIP_CELLS - 1 - column) * MIP_CELLS + row]);
    }
  }
  return out;
}

/**
 * The dictionary id the drawn grid names, with how many cells it took to get
 * there.
 *
 * Not exact-match-only, which is where this started and which was unusable: 36
 * cells read off a print in a room, and one mis-clicked corner left the operator
 * with a dead button and nothing to go on. The tolerance is the DETECTOR's own -
 * AprilTag is built with `BITS_CORRECTED = 2` in `apriltag3.rs`, so a drawing
 * within two bits of a codeword names exactly the marker the detector would
 * name off the same print. Anything looser is a guess and is refused.
 *
 * All four rotations are tried: the same physical marker read upside down is the
 * same marker, and demanding the dictionary's canonical orientation would fail
 * honest input.
 */
const PAD_MATCH_BITS = 2;

function matchGrid(grid: readonly boolean[], codes: readonly number[]): { id: number; distance: number } | null {
  let best: { id: number; distance: number } | null = null;
  let candidate = grid;
  for (let turn = 0; turn < 4; turn++) {
    const code = packGrid(candidate);
    for (const [id, entry] of codes.entries()) {
      let distance = 0;
      for (let bit = 0; bit < MIP_CELLS * MIP_CELLS; bit++) {
        const mask = 2 ** bit;
        if (Math.floor(code / mask) % 2 !== Math.floor(entry / mask) % 2) distance++;
        if (distance > PAD_MATCH_BITS) break;
      }
      if (distance <= PAD_MATCH_BITS && (best === null || distance < best.distance)) {
        best = { id, distance };
      }
      if (best?.distance === 0) return best;
    }
    candidate = rotateGrid(candidate);
  }
  return best;
}

export function installArucoPanel(mount: HTMLElement, deps: ArucoPanelDeps): ArucoPanel {
  mount.innerHTML = `
    <section class="flex h-full min-h-0 flex-col gap-[10px] overflow-y-auto overflow-x-hidden p-[14px]" aria-label="ArUco marker detector">
      <!-- Three sections: who is being followed, the roster of markers that
           can be, and the pad that adds one by drawing it. The roster is not
           called DETECTED any more because it is no longer only what the
           camera can see right now - a marker joins it by being detected OR by
           being drawn below, and stays until it is removed. -->
      <div data-k="target-mount"></div>

      <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">MARKERS · <span data-k="count">0</span></div>
      <div data-k="marker-note" class="font-mono text-[10.5px] leading-[1.6] text-dim2" hidden></div>
      <div data-k="marker-list" class="flex flex-col gap-[6px]"></div>

      <div class="flex items-center justify-between border-t border-line2 pt-[9px]">
        <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">MARKER DRAW</div>
        <div class="font-mono text-[10px] text-dim3">${NATIVE_ARUCO_DICTIONARY}</div>
      </div>
      <div class="flex items-start gap-[10px]">
        <!-- The black frame is the marker's quiet border, drawn by the wrapper
             so the 36 clickable cells are only the payload - which is exactly
             what the dictionary stores and what an operator can read off a
             print. -->
        <div class="flex-none bg-black p-[6px]">
          <div data-k="pad" class="grid grid-cols-6 gap-0"></div>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-[6px]">
          <!-- The id is an editable view of the pad, not a readout: an operator
               who already knows the number should not have to click 36 cells to
               reach it, and one who drew it should still see what it names. The
               placeholder carries 일치 없음 so an unnamed drawing costs no line. -->
          <input data-k="pad-id" type="text" inputmode="numeric" placeholder="일치 없음" aria-label="마커 ID"
            autocomplete="off" spellcheck="false"
            class="h-[26px] w-full min-w-0 rounded-[3px] border border-line2 bg-sunken px-[7px] font-mono text-[13px] text-ink focus:border-line4 focus:outline-none" />
          <div data-k="pad-note" class="font-mono text-[10px] text-dim2"></div>
          <button data-k="pad-add" type="button" disabled
            class="${PAD_BUTTON} border-line4 bg-key text-dim enabled:cursor-pointer enabled:hover:bg-btn enabled:hover:text-ink2 disabled:opacity-40">목록에 추가</button>
          <button data-k="pad-random" type="button" disabled
            class="${PAD_BUTTON} border-line2 bg-sunken text-dim2 enabled:cursor-pointer enabled:hover:border-line4 enabled:hover:text-ink2 disabled:opacity-40">랜덤 생성</button>
          <button data-k="pad-clear" type="button"
            class="${PAD_BUTTON} border-line2 bg-sunken text-dim2 cursor-pointer hover:border-line4 hover:text-ink2">지우기</button>
        </div>
      </div>
    </section>
  `;

  const count = must("[data-k=count]", HTMLSpanElement, mount);
  const markerList = must("[data-k=marker-list]", HTMLDivElement, mount);
  const markerNote = must("[data-k=marker-note]", HTMLDivElement, mount);
  const pad = must("[data-k=pad]", HTMLDivElement, mount);
  const padId = must("[data-k=pad-id]", HTMLInputElement, mount);
  const padNote = must("[data-k=pad-note]", HTMLDivElement, mount);
  const padAdd = must("[data-k=pad-add]", HTMLButtonElement, mount);
  const padRandom = must("[data-k=pad-random]", HTMLButtonElement, mount);
  const markerRowNodes = new Map<number, MarkerRow>();

  /** The drawn payload, and the codebook once Rust has answered. */
  const grid: boolean[] = new Array<boolean>(MIP_CELLS * MIP_CELLS).fill(false);
  let codes: readonly number[] = [];
  let drawn: { id: number; distance: number } | null = null;
  /**
   * Set while the id field holds something the dictionary cannot name.
   *
   * The pad still shows the last pattern, so without this the field would read
   * 99999 while 목록에 추가 quietly added whatever was drawn before it.
   */
  let fieldError = false;

  /** The pad grid stays the source of truth, so a code is copied into the array
   *  the painters close over rather than replacing it. */
  function drawCode(code: number): void {
    for (const [index, on] of unpackGrid(code).entries()) grid[index] = on;
  }

  const cells = Array.from({ length: MIP_CELLS * MIP_CELLS }, (_, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.dataset.cell = String(index);
    cell.setAttribute("aria-label", `${Math.floor(index / MIP_CELLS) + 1}행 ${(index % MIP_CELLS) + 1}열`);
    cell.className = PAD_CELL_OFF;
    pad.append(cell);
    return cell;
  });

  /**
   * `syncField` is false only while the operator is typing into the field: the
   * pad follows the digits, but rewriting the digits underneath them would move
   * the caret and fight the keystroke.
   */
  function paintPad(syncField = true): void {
    for (const [index, cell] of cells.entries()) cls(cell, grid[index] ? PAD_CELL_ON : PAD_CELL_OFF);
    drawn = codes.length === 0 ? null : matchGrid(grid, codes);
    // Guarded like the roster's size field: an unconditional `value` write is
    // not free, and it drops the selection on a field the operator just left.
    if (syncField) {
      const shown = drawn === null ? "" : String(drawn.id);
      if (padId.value !== shown) padId.value = shown;
    }
    // The distance is printed when there is one, because a drawing that needed
    // correcting is worth knowing about: it is either a mis-clicked cell or a
    // print this operator should look at again. An exact match says nothing:
    // the id in the field above is the whole answer.
    const drifted = !fieldError && drawn !== null && drawn.distance > 0;
    // An emptied field names nothing, which is not the same complaint as a
    // number the dictionary does not have - saying 없는 ID to someone who just
    // cleared the box blames them for a digit they deleted.
    const fieldNote = padId.value.trim() === "" ? "일치 없음" : "없는 ID";
    text(
      padNote,
      codes.length === 0
        ? "사전 로딩 중"
        : fieldError
          ? fieldNote
          : drawn === null
            ? "일치 없음"
            : drifted
              ? `${drawn.distance}비트 차이`
              : "",
    );
    cls(padNote, `font-mono text-[10px] ${drifted ? "text-warn" : "text-dim2"}`);
    padAdd.disabled = fieldError || drawn === null;
    padRandom.disabled = codes.length === 0;
  }

  let current = deps.vision.arucoSnapshot();
  const target = installTargetBox(must("[data-k=target-mount]", HTMLDivElement, mount), "warn", deps.follow);

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

    text(count, String(next.known.length));
    reconcileMarkerRows(markerList, markerNote, markerRowNodes, next, deps.sizes, codes);
  };

  const onClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (button === null || !mount.contains(button)) return;

    const cell = readId(button.dataset.cell);
    if (cell !== null && cell < grid.length) {
      grid[cell] = !grid[cell];
      fieldError = false;
      paintPad();
      return;
    }

    if (button === padAdd) {
      // Adding a drawn marker cannot arm the loop by itself: an unmeasured tag
      // stays unfollowable, which the target box reports as 크기 필요 until a
      // size is typed into its row.
      if (fieldError || drawn === null) return;
      deps.vision.addArucoMarker(drawn.id);
      if (deps.sizes.get(drawn.id) !== null) deps.vision.setArucoTarget(drawn.id);
      return;
    }

    if (button.dataset.k === "pad-random") {
      // Picked out of the codebook, not out of 36 coin flips: a random pattern
      // is essentially never within PAD_MATCH_BITS of a codeword, so it would
      // name no marker and could not be printed as one - a drawing nobody can
      // use. The button is disabled until the codebook lands, and refuses here
      // too because disabling is only a rendering detail.
      if (codes.length === 0) return;
      drawCode(codes[Math.floor(Math.random() * codes.length)]);
      fieldError = false;
      paintPad();
      return;
    }

    if (button.dataset.k === "pad-clear") {
      grid.fill(false);
      fieldError = false;
      paintPad();
      return;
    }

    const forget = readId(button.dataset.forgetId);
    if (forget !== null) {
      deps.vision.forgetArucoMarker(forget);
      return;
    }

    const id = readId(button.dataset.targetId);
    if (id === null || !current.known.some((entry) => entry.id === id)) return;
    // Refused here as well as disabled in the markup, because a disabled
    // button is a rendering detail and this is the safety rule.
    if (deps.sizes.get(id) === null) return;
    deps.vision.setArucoTarget(id);
  };

  /**
   * While the field is being typed into it drives the pad, not the reverse: a
   * valid id draws that marker's own pattern. Anything else - empty, not a
   * number, or past the end of the dictionary - is held as an error instead of
   * being left to name whatever pattern happens to still be drawn.
   */
  const syncFromField = (): void => {
    const raw = padId.value.trim();
    const typed = raw === "" ? null : readId(raw);
    if (typed === null || typed >= codes.length) {
      fieldError = true;
    } else {
      fieldError = false;
      drawCode(codes[typed]);
    }
    // The caret is in the field, so the field is the one thing not repainted.
    paintPad(false);
  };

  /** Leaving the field cannot leave it showing something the pad does not draw. */
  const onFieldBlur = (): void => {
    fieldError = false;
    paintPad();
  };

  mount.addEventListener("click", onClick);
  padId.addEventListener("input", syncFromField);
  padId.addEventListener("blur", onFieldBlur);
  const unsubscribe = deps.vision.subscribeAruco(paint);
  const unsubscribeSizes = deps.sizes.subscribe(() => {
    paint(current);
  });
  // The codebook is constant for the life of the build, so it is asked once.
  // Until it answers the pad cannot name what is drawn on it, and the roster's
  // glyphs stay blank - both of which are honest and neither of which stops a
  // detected marker from being selected.
  void markerCodes()
    .then((table) => {
      codes = table;
      // An id typed before the codebook landed was refused for having nothing
      // to check against; now there is, so it is re-read rather than left
      // sitting as 없는 ID against a dictionary that has since arrived.
      if (padId.value.trim() === "") paintPad();
      else syncFromField();
      paint(current);
    })
    .catch(() => {
      paintPad();
    });
  paintPad();

  return {
    dispose(): void {
      target.dispose();
      unsubscribe();
      unsubscribeSizes();
      mount.removeEventListener("click", onClick);
      padId.removeEventListener("input", syncFromField);
      padId.removeEventListener("blur", onFieldBlur);
    },
  };
}
