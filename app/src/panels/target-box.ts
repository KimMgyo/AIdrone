/**
 * The TARGET box, shared by both vision panels.
 *
 * One box, because there is one subject: who the loop is flying at, and what
 * it is putting on the wire to do it. That used to be three stacked boxes - a
 * detector status pill, a target row, and a follow card - which is three
 * borders and three badges for one answer.
 *
 * There is no start button. The lock IS the switch: locking a target starts
 * the follow loop and releasing it stops the drone, so a second control would
 * only be a second thing to disagree with.
 */
import { type FollowPhase, type FollowPort, type FollowState } from "../follow.ts";
import { cls, must, text } from "../ui.ts";
import { DEFLECTION } from "./keymap.ts";

/** Each panel keeps its own accent so the two stay tellable apart. */
export type TargetAccent = "warn" | "ok";

/** The half of the box the panel owns. The follow half updates itself. */
export type TargetView = {
  /** Who is being followed, in the panel's own vocabulary - `TRACK 1`, `ID 7`. */
  title: string;
  /** The detector's own line: engine and how long this frame took. */
  engine: string;
  /**
   * A detector fault, which outranks the follow phase in the badge because a
   * loop reported idle by a detector that is not running is not the fact worth
   * showing. `null` when the detector is healthy.
   */
  trouble: string | null;
  /**
   * Whether a target is locked, which is not the same as one being visible: a
   * lock survives the target leaving frame, and the release control has to
   * survive with it or the operator cannot let go of something they cannot
   * see. Keying this off the follow state's `targetSize` got that wrong.
   */
  locked: boolean;
};

export interface TargetBox {
  update(view: TargetView): void;
  dispose(): void;
}

const BOX = "rounded-[3px] border p-[10px]";
const BADGE = "flex-none rounded-[2px] px-[6px] py-[2px] font-mono text-[8.5px] tracking-[.1em]";
const DOT = "h-[6px] w-[6px] flex-none rounded-full";
const ROW = "mt-[4px] font-mono text-[10px] leading-[1.5] text-dim2";

const IDLE_BOX: Record<TargetAccent, string> = {
  warn: `${BOX} border-[#2A2418] bg-sunken`,
  ok: `${BOX} border-[#1E3021] bg-sunken`,
};

const TITLE_TONE: Record<TargetAccent, string> = {
  warn: "text-warn",
  ok: "text-ok",
};

const LABEL: Record<FollowPhase, string> = {
  idle: "정지",
  following: "추적 중",
  searching: "대상 탐색",
  halted: "중단됨",
};

/**
 * `clear` is optional because only the marker panel has anything to clear: a
 * person target is whoever is nearest, so there is no lock to release and a
 * button offering to would do nothing.
 */
export function installTargetBox(
  mount: HTMLElement,
  accent: TargetAccent,
  follow: FollowPort,
  clear?: () => void,
): TargetBox {
  mount.innerHTML = `
    <div data-k="box" class="${IDLE_BOX[accent]}">
      <div class="flex items-center justify-between gap-[8px]">
        <div class="flex min-w-0 items-center gap-[7px]">
          <div data-k="dot" class="${DOT} bg-dim3"></div>
          <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">TARGET</div>
        </div>
        <div class="flex flex-none items-center gap-[6px]">
          <div data-k="badge" class="${BADGE} border border-line3 text-dim2">정지</div>
          <button data-k="clear" type="button" hidden
            class="h-[19px] flex-none rounded-[2px] border border-line4 bg-key px-[6px] font-mono text-[9.5px] text-dim cursor-pointer hover:bg-btn hover:text-ink2">해제</button>
        </div>
      </div>
      <div data-k="title" class="mt-[6px] truncate font-mono text-[14px] ${TITLE_TONE[accent]}">--</div>
      <div data-k="command" class="${ROW} text-dim" hidden></div>
      <div data-k="distance" class="${ROW}">폭 --</div>
      <div data-k="power" class="${ROW}">POWER --</div>
      <div data-k="engine" class="${ROW} text-dim3"></div>
    </div>
  `;

  const box = must("[data-k=box]", HTMLDivElement, mount);
  const dot = must("[data-k=dot]", HTMLDivElement, mount);
  const badge = must("[data-k=badge]", HTMLDivElement, mount);
  const title = must("[data-k=title]", HTMLDivElement, mount);
  const command = must("[data-k=command]", HTMLDivElement, mount);
  const distance = must("[data-k=distance]", HTMLDivElement, mount);
  const power = must("[data-k=power]", HTMLDivElement, mount);
  const engine = must("[data-k=engine]", HTMLDivElement, mount);
  const clearBtn = must("[data-k=clear]", HTMLButtonElement, mount);

  if (clear !== undefined) clearBtn.addEventListener("click", clear);

  /** The panel's half, held so a follow update can repaint the whole box. */
  let view: TargetView = { title: "--", engine: "", trouble: null, locked: false };
  let state: FollowState = follow.state();

  /**
   * The distance readout is the diagnosis, not decoration: "it does not judge
   * distance properly" is only actionable once the measured width and the
   * setpoint it is being compared against are both on screen.
   */
  function paintDistance(): void {
    const measured = state.targetSize === null ? "--" : `${Math.round(state.targetSize)}`;
    // The ratio is the number the control law actually acts on, and it is the
    // one an operator can sanity-check against what they can see.
    const ratio =
      state.targetSize === null || state.targetSize <= 0
        ? ""
        : ` · ${(state.desiredSize / state.targetSize).toFixed(2)}× ${state.desiredSize > state.targetSize ? "멂" : "가까움"}`;
    text(distance, `폭 ${measured} → ${Math.round(state.desiredSize)} px${ratio}`);
  }

  function paint(): void {
    text(title, view.title);
    text(engine, view.engine);
    // A detector fault takes the badge; otherwise the phase word carries it,
    // and no line in this box explains itself in prose.
    const trouble = view.trouble;
    text(badge, trouble ?? LABEL[state.phase]);

    if (trouble !== null) {
      cls(box, `${BOX} border-alert/45 bg-alert/10`);
      cls(dot, `${DOT} bg-alert`);
      cls(badge, `${BADGE} border border-alert/45 text-alert2`);
    } else {
      switch (state.phase) {
        case "following":
          cls(box, `${BOX} border-alert/60 bg-alert/10`);
          cls(dot, `${DOT} bg-alert animate-beat-fast`);
          cls(badge, `${BADGE} border-0 bg-alert text-[#1A0A0A]`);
          break;
        case "searching":
          cls(box, `${BOX} border-alert/40 bg-alert/5`);
          cls(dot, `${DOT} bg-alert animate-beat`);
          cls(badge, `${BADGE} border border-alert/45 text-alert2`);
          break;
        case "halted":
          cls(box, `${BOX} border-line4 bg-raised`);
          cls(dot, `${DOT} bg-dim`);
          cls(badge, `${BADGE} border border-line4 text-dim`);
          break;
        case "idle":
          cls(box, IDLE_BOX[accent]);
          cls(dot, `${DOT} bg-dim3`);
          cls(badge, `${BADGE} border border-line3 text-dim2`);
      }
    }

    // Only `following` has channel values worth printing, and a Tello on the
    // ground discards `rc` outright - printing confident numbers at a
    // motionless airframe would be a lie of omission.
    command.hidden = state.phase !== "following";
    if (state.phase === "following") {
      text(
        command,
        `${state.airborne === false ? "지상 · rc 무시됨 · " : ""}전후 ${state.command.fb} · yaw ${state.command.yaw}`,
      );
    }
    paintDistance();
    // Manual deflection is printed here and nowhere else in this panel: the
    // number only means something next to the loop's own authority.
    text(power, `POWER ${state.maxRc} · 수동 ${DEFLECTION}`);
    clearBtn.hidden = clear === undefined || !view.locked;
  }

  const unsubscribe = follow.subscribe((next) => {
    state = next;
    paint();
  });

  return {
    update(next: TargetView): void {
      view = next;
      paint();
    },
    dispose(): void {
      unsubscribe();
    },
  };
}
