/**
 * Key map + RC output - the stick controller.
 *
 * The distinction this file turns on: the four sticks are a LEVEL, the four
 * command keys are an EDGE. `takeoff` is sent once when T goes down; `rc` has
 * to be re-sent for as long as W is held, because the Tello acts on the last
 * `rc` it received and stops on its own command timeout if nothing follows.
 * So a keydown handler alone cannot fly this - there is a 10 Hz loop, and the
 * loop is the load-bearing part of the panel.
 *
 * Everything visible is a Tailwind class toggled through `cls`/`text`/`style`.
 * The markup below is written once and never rebuilt: twelve cells, four bars
 * and one string, all of which only ever change colour, width or content.
 */
import { all, cls, must, style, text } from "../ui.ts";

/**
 * ±deflection a held key commands, on the SDK's -100..100 `rc` scale. The
 * sticks are digital - a key is down or it is not - so this single number is
 * the whole flight envelope of keyboard control. 60 is the prototype's value.
 *
 * Exported because the follow card prints it beside the follow loop's own
 * authority: two literals would be free to drift apart, and the comparison is
 * the only reason either number is on screen.
 */
export const DEFLECTION = 60;

/**
 * 10 Hz. The SDK asks for 5-10 Hz on `rc`, and the sibling tellovoice firmware
 * arrived at the same 100 ms (`RC_SEND_INTERVAL_MS` in its server and web
 * halves) after finding faster only floods the device link. This interval is
 * not a refresh rate - it IS the hold, so it cannot be lengthened casually.
 */
const RC_SEND_INTERVAL_MS = 100;

/** Sticks centred. Sent once on release, never repeated - see `pump`. */
const NEUTRAL = "rc 0 0 0 0";

/**
 * The eight codes that move the airframe, and the four that fire once. Fixed at
 * authoring time and only ever asked "is this code mine", so they are tables
 * rather than sets; `undefined` in the value type keeps a miss honest.
 */
const IS_STICK: Record<string, true | undefined> = {
  KeyW: true,
  KeyS: true,
  KeyA: true,
  KeyD: true,
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
};
const IS_COMMAND: Record<string, true | undefined> = {
  KeyT: true,
  KeyL: true,
  Space: true,
  Escape: true,
};

/** Cells in the markup below. Wired from the DOM in this order, so the count is
 *  the one place the two can disagree and `all` fails loudly if they do. */
const CELL_COUNT = 12;

/** SDK channel order in `rc <lr> <fb> <ud> <yaw>`. */
const CHANNELS = ["lr", "fb", "ud", "yaw"] as const;
type Channel = (typeof CHANNELS)[number];

const CARD =
  "flex flex-col gap-[11px] rounded-[7px] border border-[#232A33] bg-[#0E1216] p-[12px_12px_11px]";
/** Disabled kills pointer events too - a dimmed card that still shows a
 *  pointer cursor and depresses under the mouse is lying about being live. */
const CARD_OFF = `${CARD} pointer-events-none opacity-40`;

const CELL_BASE =
  "relative flex h-[34px] cursor-pointer items-center justify-center rounded-[5px] border font-mono text-[12px] select-none";
/**
 * The keycap gradient and both box-shadows are arbitrary-property utilities
 * rather than inline `style`: an inline `background` outranks every class, so
 * the released gradient would win over the held `bg-[#1B303B]` and the pressed
 * state would never show. As classes they swap cleanly in one `cls()` write.
 */
const CELL_OFF = `${CELL_BASE} border-[#2C333D] text-ink2 [background:linear-gradient(#1B2128,#141920)] [box-shadow:0_1.5px_0_#0A0D11,inset_0_1px_0_rgba(255,255,255,.05)]`;
const CELL_ON = `${CELL_BASE} translate-y-[1.5px] border-accent bg-[#1B303B] text-[#EAF7FF] [box-shadow:inset_0_2px_4px_rgba(0,0,0,.5)]`;

/** Held overlay. `pointer-events-none` so crossing onto it is not an exit. */
const GLOW_ON =
  "pointer-events-none absolute inset-[-1px] rounded-[5px] border border-accent [background:rgba(91,200,245,.24)]";
const GLOW_OFF = "hidden";

function keyCell(code: string, label: string): string {
  return `<div data-code="${code}" class="${CELL_OFF}">${label}<div data-k="glow" class="${GLOW_OFF}"></div></div>`;
}

function channelRow(name: Channel): string {
  return `
          <div data-ch="${name}" class="flex items-center gap-[9px]">
            <div class="w-[22px] font-mono text-[11px] text-dim">${name}</div>
            <div class="relative h-[6px] flex-1 overflow-hidden rounded-[3px] bg-[#181D23]">
              <div class="absolute top-0 bottom-0 left-1/2 w-px bg-[#2A313A]"></div>
              <div data-k="bar" class="absolute top-0 bottom-0 rounded-[2px] bg-accent" style="left:50%;width:0%"></div>
            </div>
            <div data-k="val" class="w-[32px] text-right font-mono text-[11px] text-ink2">0</div>
          </div>`;
}

export interface KeyMapPanel {
  setEnabled(on: boolean): void;
  /** Returns true if the code was one of ours and was consumed. */
  keyDown(code: string): boolean;
  keyUp(code: string): void;
  /** Release every stick, send one neutral rc, stop the loop. */
  neutral(): void;
  /** Stop the interval. Called when the session ends. */
  dispose(): void;
}

export interface KeyMapDeps {
  sendRc: (cmd: string) => void;
  /**
   * The three commands a key sends to the aircraft. The shell sends them AND
   * writes the timeline line, because each one also has a button behind it -
   * two copies of "이륙 명령 전송" in two files is one that eventually says
   * something else.
   */
  onCommand: (cmd: "takeoff" | "land" | "emergency") => void;
  /** A panel-local action with no drone command behind it: SPACE centring the
   *  sticks is this panel's own doing, so this panel names it. */
  onAction: (text: string) => void;
  /**
   * Fired on the edge where this panel starts and stops writing to `rc`.
   *
   * The composition root uses it to silence the follow loop for exactly as long
   * as a stick is held. Edge-triggered rather than polled, because the thing
   * downstream has to be a state and not a guess about one.
   */
  onOverride?: (active: boolean) => void;
}

export function installKeyMap(mount: HTMLElement, deps: KeyMapDeps): KeyMapPanel {
  mount.innerHTML = `
    <div class="flex h-full flex-col gap-[14px] overflow-y-auto p-[14px]">
      <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">KEY MAP · 실제 키 입력 반응</div>

      <div data-k="card" class="${CARD}">
        <div class="grid grid-cols-2 gap-[14px]">
          <div class="flex flex-col items-center gap-[6px]">
            <div class="grid grid-cols-[repeat(3,34px)] grid-rows-[repeat(2,34px)] gap-[5px]">
              <div></div>${keyCell("KeyW", "W")}<div></div>
              ${keyCell("KeyA", "A")}${keyCell("KeyS", "S")}${keyCell("KeyD", "D")}
            </div>
            <div class="font-mono text-[9.5px] tracking-[.1em] text-dim2">전후 · 좌우</div>
          </div>

          <div class="flex flex-col items-center gap-[6px]">
            <div class="grid grid-cols-[repeat(3,34px)] grid-rows-[repeat(2,34px)] gap-[5px]">
              <div></div>${keyCell("ArrowUp", "↑")}<div></div>
              ${keyCell("ArrowLeft", "←")}${keyCell("ArrowDown", "↓")}${keyCell("ArrowRight", "→")}
            </div>
            <div class="font-mono text-[9.5px] tracking-[.1em] text-dim2">고도 · 요</div>
          </div>
        </div>

        <div class="h-px bg-[#1A2027]"></div>

        <div class="grid grid-cols-4 gap-[5px]">
          ${keyCell("KeyT", "T")}${keyCell("KeyL", "L")}${keyCell("Space", "SPACE")}${keyCell("Escape", "ESC")}
        </div>
        <div class="grid grid-cols-4 gap-[5px] text-center font-mono text-[9.5px] text-[#6E7681]">
          <div>이륙</div><div>착륙</div><div>호버</div><div>비상 정지</div>
        </div>
      </div>

      <div class="h-px bg-line2"></div>

      <div class="flex flex-col gap-[9px]">
        <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">RC OUTPUT</div>
        ${CHANNELS.map(channelRow).join("")}
        <div data-k="rc" class="rounded-[3px] border border-[#212832] bg-tile px-[10px] py-[8px] font-mono text-[11px] text-dim">${NEUTRAL}</div>
      </div>
    </div>
  `;

  const card = must("[data-k=card]", HTMLDivElement, mount);
  const sdkLine = must("[data-k=rc]", HTMLDivElement, mount);

  // Wired straight off the DOM rather than from a second list of codes: the
  // markup above is the single source of truth for which cells exist.
  // `dataset.code` is a string wherever `[data-code]` matched, so the fallback
  // below is only there to satisfy the type.
  const keys = all("[data-code]", HTMLDivElement, mount, CELL_COUNT).map((el) => ({
    el,
    code: el.dataset.code ?? "",
    glow: must("[data-k=glow]", HTMLDivElement, el),
  }));

  const rows = CHANNELS.map((name) => {
    const row = must(`[data-ch="${name}"]`, HTMLDivElement, mount);
    return {
      name,
      bar: must("[data-k=bar]", HTMLDivElement, row),
      val: must("[data-k=val]", HTMLDivElement, row),
    };
  });

  const held = new Set<string>();
  const rc: Record<Channel, number> = { lr: 0, fb: 0, ud: 0, yaw: 0 };
  let enabled = false;
  /** True while the last thing put on the wire was a live deflection. The whole
   *  reason the release can emit one neutral and then fall silent. */
  let moving = false;
  /** `window.setInterval` handle; the spec never issues 0, so it doubles as
   *  "no loop running" and keeps this a plain number. */
  let loop = 0;

  function stopLoop(): void {
    if (loop === 0) return;
    window.clearInterval(loop);
    loop = 0;
  }

  /** Two keys, one channel: the SDK wants a signed magnitude, not a pair of
   *  flags, and pressing both at once has to cancel to centre. */
  function axis(pos: string, neg: string): number {
    return (held.has(pos) ? DEFLECTION : 0) - (held.has(neg) ? DEFLECTION : 0);
  }

  /** Recomputes `rc` from the held set; true if any stick is off centre. Eight
   *  Set lookups, idempotent, so the pump and the repaint each call it and
   *  neither depends on the other having run first. */
  function sample(): boolean {
    rc.lr = axis("KeyD", "KeyA");
    rc.fb = axis("KeyW", "KeyS");
    rc.ud = axis("ArrowUp", "ArrowDown");
    rc.yaw = axis("ArrowRight", "ArrowLeft");
    return rc.lr !== 0 || rc.fb !== 0 || rc.ud !== 0 || rc.yaw !== 0;
  }

  /** The one place the SDK's channel order is spelled out. Both the wire and
   *  the on-screen echo go through it so they can never disagree. */
  function sdk(): string {
    return `rc ${rc.lr} ${rc.fb} ${rc.ud} ${rc.yaw}`;
  }

  /**
   * The level trigger, and the only thing in this file that writes sticks to
   * the link.
   *
   * Runs from the 10 Hz loop and from every state change - the latter so a
   * press reaches the air immediately instead of waiting out up to a full
   * interval. Going quiet once the sticks centre is deliberate: repeating
   * `rc 0 0 0 0` forever is pure link noise. Sending it exactly once is
   * mandatory, because without it the drone keeps flying on the last
   * deflection it heard.
   */
  function pump(): void {
    const active = sample();
    if (enabled && active) {
      if (!moving) deps.onOverride?.(true);
      deps.sendRc(sdk());
      moving = true;
      if (loop === 0) loop = window.setInterval(pump, RC_SEND_INTERVAL_MS);
      return;
    }
    if (moving) {
      deps.sendRc(NEUTRAL);
      moving = false;
      // After the neutral, not before: the loop we are handing back to would
      // otherwise get one tick in ahead of our own centring command.
      deps.onOverride?.(false);
    }
    stopLoop();
  }

  function paint(): void {
    sample();
    cls(card, enabled ? CARD : CARD_OFF);

    for (const k of keys) {
      const on = held.has(k.code);
      cls(k.el, on ? CELL_ON : CELL_OFF);
      cls(k.glow, on ? GLOW_ON : GLOW_OFF);
    }

    // Bars grow out of the centre tick, so half the magnitude sits on each side
    // of 50%: full deflection (60) is 30% of the track.
    for (const r of rows) {
      const v = rc[r.name];
      const half = Math.abs(v) / 2;
      style(r.bar, "width", `${half}%`);
      style(r.bar, "left", v >= 0 ? "50%" : `${50 - half}%`);
      text(r.val, String(v));
    }

    text(sdkLine, sdk());
  }

  /** Centre the sticks and say so once. Shared by SPACE and `neutral()`; both
   *  must leave the loop stopped, or the next tick re-sends a stale zero. */
  function hover(): void {
    const wasMoving = moving;
    for (const code in IS_STICK) held.delete(code);
    moving = false;
    stopLoop();
    deps.sendRc(NEUTRAL);
    // Centring the sticks is releasing the wire, so the loop it was taken from
    // gets it back - SPACE is "stop moving", not "stop the follow", which is
    // the target box's job.
    if (wasMoving) deps.onOverride?.(false);
  }

  function press(code: string): void {
    if (!enabled) return;
    if (!IS_STICK[code] && !IS_COMMAND[code]) return;
    // The shell forwards OS key repeat as a stream of keydowns, so the held set
    // is what makes the four command keys edge triggered.
    if (held.has(code)) return;
    held.add(code);

    switch (code) {
      case "KeyT":
        deps.onCommand("takeoff");
        break;
      case "KeyL":
        deps.onCommand("land");
        break;
      case "Space":
        hover();
        deps.onAction("호버 · RC 중립");
        break;
      case "Escape":
        // `emergency` cuts the motors on the spot. It is not a landing - the
        // airframe drops from wherever it is - so the shell reports it as a stop
        // and stands the follow loop down, exactly as its own red button does.
        deps.onCommand("emergency");
        break;
      default:
        pump();
    }

    paint();
  }

  /** Runs even while disabled: a key held across a disable must not stick. */
  function release(code: string): void {
    if (!held.delete(code)) return;
    if (IS_STICK[code]) pump();
    paint();
  }

  function cellAt(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>("[data-code]") : null;
  }

  // Delegated rather than twelve pairs of handlers - the cells are static, so
  // their identity lives in `data-code` and there is nothing to re-bind.
  mount.addEventListener("pointerdown", (e) => {
    const code = cellAt(e.target)?.dataset.code;
    if (code === undefined) return;
    e.preventDefault(); // no text-selection drag off a keycap
    press(code);
  });

  const lift = (e: PointerEvent): void => {
    const code = cellAt(e.target)?.dataset.code;
    if (code !== undefined) release(code);
  };
  mount.addEventListener("pointerup", lift);
  mount.addEventListener("pointercancel", lift);

  // `pointerleave` does not bubble, so delegation needs `pointerout` - which
  // also fires when the pointer crosses onto the cell's own glow overlay. Only
  // an exit that lands outside the cell is a release.
  mount.addEventListener("pointerout", (e) => {
    const cell = cellAt(e.target);
    const code = cell?.dataset.code;
    if (!cell || code === undefined) return;
    if (e.relatedTarget instanceof Node && cell.contains(e.relatedTarget)) return;
    release(code);
  });

  paint();

  return {
    setEnabled(on: boolean): void {
      if (enabled === on) return;
      enabled = on;
      // Dropping the held set keeps the readout honest - nothing is being
      // accepted, so nothing may show as deflected - and pump() then emits the
      // trailing neutral if the last thing sent was a live stick.
      if (!on) held.clear();
      pump();
      paint();
    },

    keyDown(code: string): boolean {
      // Not consumed while disabled: the panel is inert, so the shell stays
      // free to use the key for something else.
      if (!enabled || (!IS_STICK[code] && !IS_COMMAND[code])) return false;
      press(code);
      return true;
    },

    keyUp(code: string): void {
      release(code);
    },

    neutral(): void {
      held.clear();
      hover();
      paint();
    },

    dispose(): void {
      stopLoop();
    },
  };
}
