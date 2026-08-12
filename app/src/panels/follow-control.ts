/**
 * Follow status, shared by both vision panels.
 *
 * There is no button here. The lock IS the switch: locking a target starts the
 * follow loop and releasing it stops the drone, so a second control would only
 * be a second thing to disagree with. The card is four readings and a badge -
 * the phase word carries what prose used to, so no line here explains itself.
 */
import { type FollowPhase, type FollowPort, type FollowState } from "../follow.ts";
import { cls, must, text } from "../ui.ts";
import { DEFLECTION } from "./keymap.ts";

/** Each panel keeps its own accent so the two stay tellable apart. */
export type FollowAccent = "warn" | "ok";

export interface FollowControl {
  dispose(): void;
}

const CARD = "rounded-[3px] border p-[10px]";
const BADGE = "flex-none rounded-[2px] px-[6px] py-[2px] font-mono text-[8.5px] tracking-[.1em]";
const DOT = "h-[6px] w-[6px] flex-none rounded-full";

const IDLE_CARD: Record<FollowAccent, string> = {
  warn: `${CARD} border-[#2A2418] bg-sunken`,
  ok: `${CARD} border-[#1E3021] bg-sunken`,
};

const LABEL: Record<FollowPhase, string> = {
  idle: "정지",
  following: "추적 중",
  searching: "대상 탐색",
  halted: "중단됨",
};

export function installFollowControl(mount: HTMLElement, accent: FollowAccent, follow: FollowPort): FollowControl {
  mount.innerHTML = `
    <div data-k="follow-card" class="${IDLE_CARD[accent]}">
      <div class="flex items-center justify-between gap-[8px]">
        <div class="flex min-w-0 items-center gap-[7px]">
          <div data-k="follow-dot" class="${DOT} bg-dim3"></div>
          <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">FOLLOW</div>
        </div>
        <div data-k="follow-badge" class="${BADGE} border border-line3 text-dim2">정지</div>
      </div>
      <div data-k="follow-detail" class="mt-[6px] font-mono text-[10px] leading-[1.5] text-dim" hidden></div>
      <div data-k="follow-distance" class="mt-[5px] font-mono text-[10px] leading-[1.5] text-dim2">폭 --</div>
      <div data-k="follow-power" class="mt-[3px] font-mono text-[10px] leading-[1.5] text-dim2">POWER --</div>
    </div>
  `;

  const card = must("[data-k=follow-card]", HTMLDivElement, mount);
  const dot = must("[data-k=follow-dot]", HTMLDivElement, mount);
  const badge = must("[data-k=follow-badge]", HTMLDivElement, mount);
  const detail = must("[data-k=follow-detail]", HTMLDivElement, mount);
  const distance = must("[data-k=follow-distance]", HTMLDivElement, mount);


  /**
   * The distance readout is the diagnosis, not decoration: "it does not judge
   * distance properly" is only actionable once the measured width and the
   * setpoint it is being compared against are both on screen.
   */
  const paintDistance = (state: FollowState): void => {
    const measured = state.targetSize === null ? "--" : `${Math.round(state.targetSize)}`;
    // The ratio is the number the control law actually acts on, and it is the
    // one an operator can sanity-check against what they can see.
    const ratio =
      state.targetSize === null || state.targetSize <= 0
        ? ""
        : ` · ${(state.desiredSize / state.targetSize).toFixed(2)}× ${state.desiredSize > state.targetSize ? "멂" : "가까움"}`;
    text(distance, `폭 ${measured} → ${Math.round(state.desiredSize)} px${ratio}`);
  };
  const power = must("[data-k=follow-power]", HTMLDivElement, mount);
  const paint = (state: FollowState): void => {
    text(badge, LABEL[state.phase]);
    // Only `following` has anything to add that the badge does not already
    // say, so every other phase leaves the line off rather than restating it.
    detail.hidden = state.phase !== "following";
    switch (state.phase) {
      case "following":
        cls(card, `${CARD} border-alert/60 bg-alert/10`);
        cls(dot, `${DOT} bg-alert animate-beat-fast`);
        cls(badge, `${BADGE} border-0 bg-alert text-[#1A0A0A]`);
        // A Tello on the ground discards `rc` outright, so printing confident
        // channel values at a motionless airframe would be a lie of omission.
        text(
          detail,
          `${state.airborne === false ? "지상 · rc 무시됨 · " : ""}전후 ${state.command.fb} · yaw ${state.command.yaw}`,
        );
        return;
      case "searching":
        cls(card, `${CARD} border-alert/40 bg-alert/5`);
        cls(dot, `${DOT} bg-alert animate-beat`);
        cls(badge, `${BADGE} border border-alert/45 text-alert2`);
        return;
      case "halted":
        cls(card, `${CARD} border-line4 bg-raised`);
        cls(dot, `${DOT} bg-dim`);
        cls(badge, `${BADGE} border border-line4 text-dim`);
        return;
      case "idle":
        cls(card, IDLE_CARD[accent]);
        cls(dot, `${DOT} bg-dim3`);
        cls(badge, `${BADGE} border border-line3 text-dim2`);
    }
  };

  // Nothing on this card is clickable: power is fixed and both setpoints are
  // computed, so there is no control left for a click to reach.
  const unsubscribe = follow.subscribe((state) => {
    paint(state);
    // Manual deflection is printed here and nowhere else on this card: the
    // number only means something next to the loop's own authority.
    text(power, `POWER ${state.maxRc} · 수동 ${DEFLECTION}`);
    paintDistance(state);
  });
  return {
    dispose(): void {
      unsubscribe();
    },
  };
}
