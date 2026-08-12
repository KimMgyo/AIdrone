/**
 * Follow status, shared by both vision panels.
 *
 * There is no button here. The lock IS the switch: locking a target starts the
 * follow loop and releasing it stops the drone, so a second control would only
 * be a second thing to disagree with. This card exists so the operator can see
 * which of those two states they are in, and what is on the wire because of it.
 */
import { type FollowPhase, type FollowPort, type FollowState } from "../follow.ts";
import { cls, must, text } from "../ui.ts";
import { DEFLECTION } from "./keymap.ts";

/** Each panel keeps its own accent so the two stay tellable apart. */
export type FollowAccent = "warn" | "ok";

/**
 * What starts the loop, and therefore what stops it, which differs by panel
 * and so cannot be inferred from the controller: a marker is followed once the
 * operator locks its id, while a person is followed the moment one is in frame.
 */
const ENGAGEMENT: Record<FollowAccent, { idle: string; searching: string; halted: string; footnote: string }> = {
  warn: {
    idle: "대상을 잠그면 그때부터 따라갑니다.",
    searching: "잠금 유지 · 대상이 화면에 없어 스틱 중립 · 다시 보이면 자동 재개",
    halted: "비상 정지 또는 모드 변경으로 중단됨 · 잠금을 해제했다가 다시 잠그면 재개",
    footnote: "잠그면 따라갑니다 · 해제하면 멈춥니다",
  },
  ok: {
    idle: "사람이 화면에 들어오면 바로 따라갑니다 · 멈추려면 모드를 바꾸세요.",
    searching: "사람이 화면에서 사라져 스틱 중립 · 다시 보이면 자동 재개",
    halted: "비상 정지 또는 모드 변경으로 중단됨 · 사람 모드로 다시 들어오면 재개",
    footnote: "사람이 보이면 따라갑니다 · 모드를 바꾸면 멈춥니다",
  },
};

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
          <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">AUTONOMOUS FOLLOW</div>
        </div>
        <div data-k="follow-badge" class="${BADGE} border border-line3 text-dim2">정지</div>
      </div>
      <div data-k="follow-detail" class="mt-[7px] text-[11px] leading-[1.55] text-dim"></div>
      <div data-k="follow-distance" class="mt-[5px] font-mono text-[10px] leading-[1.5] text-dim2">거리 --</div>
      <div data-k="follow-power" class="mt-[7px] font-mono text-[10px] leading-[1.5] text-dim2">POWER --</div>
      <div class="mt-[6px] font-mono text-[9.5px] leading-[1.5] text-dim2">${ENGAGEMENT[accent].footnote} · yaw·전후 2채널 (roll/상하 0)</div>
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
    const measured = state.targetSize === null ? "--" : `${Math.round(state.targetSize)} px`;
    // The ratio is the number the control law actually acts on, and it is the
    // one an operator can sanity-check against what they can see.
    const ratio =
      state.targetSize === null || state.targetSize <= 0
        ? ""
        : ` · ${(state.desiredSize / state.targetSize).toFixed(2)}× ${state.desiredSize > state.targetSize ? "멂" : "가까움"}`;
    text(distance, `폭 ${measured} → 목표 ${Math.round(state.desiredSize)} px (고정)${ratio}`);
  };
  const power = must("[data-k=follow-power]", HTMLDivElement, mount);
  const paint = (state: FollowState): void => {
    text(badge, LABEL[state.phase]);
    const grounded = state.airborne === false;
    switch (state.phase) {
      case "following":
        cls(card, `${CARD} border-alert/60 bg-alert/10`);
        cls(dot, `${DOT} bg-alert animate-beat-fast`);
        cls(badge, `${BADGE} border-0 bg-alert text-[#1A0A0A]`);
        // A Tello on the ground discards `rc` outright, so printing confident
        // channel values at a motionless airframe would be a lie of omission.
        text(
          detail,
          grounded
            ? `드론이 지상에 있습니다 · takeoff 전에는 rc가 무시됩니다 (전후 ${state.command.fb} · yaw ${state.command.yaw})`
            : `자동 조종 중 · 전후 ${state.command.fb} · yaw ${state.command.yaw}`,
        );
        return;
      case "searching":
        cls(card, `${CARD} border-alert/40 bg-alert/5`);
        cls(dot, `${DOT} bg-alert animate-beat`);
        cls(badge, `${BADGE} border border-alert/45 text-alert2`);
        text(detail, ENGAGEMENT[accent].searching);
        return;
      case "halted":
        cls(card, `${CARD} border-line4 bg-raised`);
        cls(dot, `${DOT} bg-dim`);
        cls(badge, `${BADGE} border border-line4 text-dim`);
        text(detail, ENGAGEMENT[accent].halted);
        return;
      case "idle":
        cls(card, IDLE_CARD[accent]);
        cls(dot, `${DOT} bg-dim3`);
        cls(badge, `${BADGE} border border-line3 text-dim2`);
        text(detail, ENGAGEMENT[accent].idle);
    }
  };

  // Nothing on this card is clickable: power is fixed and both setpoints are
  // computed, so there is no control left for a click to reach.
  const unsubscribe = follow.subscribe((state) => {
    paint(state);
    // Manual deflection is printed here and nowhere else on this card: the
    // number only means something next to the loop's own authority.
    text(power, `POWER ${state.maxRc} (고정) · 수동 조종은 ${DEFLECTION}`);
    paintDistance(state);
  });
  return {
    dispose(): void {
      unsubscribe();
    },
  };
}
