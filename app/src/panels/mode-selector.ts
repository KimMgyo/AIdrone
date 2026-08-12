import { CONTROL_MODES, type ControlMode } from "../control-mode.ts";
import { all, cls } from "../ui.ts";

/** The station owns the actual panel swap; this selector only owns its radio UI. */
export interface ModeSelectorDeps {
  mode: ControlMode;
  onModeChange(mode: ControlMode): void;
}

export interface ModeSelectorPanel {
  /** Synchronize the exclusive selection after a mode change originating elsewhere. */
  setMode(mode: ControlMode): void;
  /** Remove the selector's event listeners before its mount is discarded. */
  dispose(): void;
}

const ROW =
  "relative flex h-[44px] w-full items-center gap-[11px] rounded-[3px] border border-[#232931] bg-chip px-[12px] text-left hover:bg-[#1B2129] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
/**
 * The selected row is drawn in the mode's OWN colour, not one house blue for
 * all three. Each mode already declares that colour in `control-mode.ts` and
 * everything else downstream honours it - the panel accent, the stage tag, the
 * follow card - so a blue highlight over the marker mode was the one place the
 * selection disagreed with what selecting it does.
 */
const ACTIVE: Record<(typeof CONTROL_MODES)[number]["color"], string> = {
  accent: "pointer-events-none absolute inset-0 rounded-[3px] border border-accent bg-accent/10",
  ok: "pointer-events-none absolute inset-0 rounded-[3px] border border-ok bg-ok/10",
  warn: "pointer-events-none absolute inset-0 rounded-[3px] border border-warn bg-warn/10",
};
const INACTIVE = "pointer-events-none absolute inset-0 rounded-[3px] border border-transparent";

/**
 * Installs the three mutually exclusive control-mode rows from the prototype.
 * F1/F2/F3 are visual labels, not global key bindings: the station's key map
 * remains the sole owner of flight-control keyboard input.
 */
export function installModeSelector(
  mount: HTMLElement,
  deps: ModeSelectorDeps,
): ModeSelectorPanel {
  mount.innerHTML = `
    <section class="flex-none border-b border-line2 px-[14px] pb-[12px] pt-[14px]" aria-labelledby="mode-heading">
      <div id="mode-heading" class="mb-[9px] font-mono text-[10.5px] tracking-[.16em] text-dim2">CONTROL MODE · 배타적</div>
      <div role="radiogroup" aria-labelledby="mode-heading" class="flex flex-col gap-[9px]">
        ${CONTROL_MODES.map(
          (spec) => `
            <button
              type="button"
              role="radio"
              data-k="mode-${spec.id}"
              data-mode="${spec.id}"
              aria-checked="false"
              class="${ROW}"
            >
              <span data-k="mode-dot" class="h-[7px] w-[7px] flex-none rounded-[2px] bg-[#39414C]"></span>
              <span class="min-w-0 flex-1 text-[12.5px] text-ink2">${spec.label}</span>
              <kbd class="font-mono text-[10px] tracking-[.12em] text-dim2">${spec.key}</kbd>
              <span data-k="mode-active" aria-hidden="true" class="${INACTIVE}"></span>
            </button>`,
        ).join("")}
      </div>
    </section>
  `;

  const buttons = all("[data-mode]", HTMLButtonElement, mount, CONTROL_MODES.length);
  const dots = all("[data-k=\"mode-dot\"]", HTMLSpanElement, mount, CONTROL_MODES.length);
  const overlays = all("[data-k=\"mode-active\"]", HTMLSpanElement, mount, CONTROL_MODES.length);
  const dotClasses = CONTROL_MODES.map((spec) =>
    spec.color === "accent"
      ? "h-[7px] w-[7px] flex-none rounded-[2px] bg-accent"
      : spec.color === "ok"
        ? "h-[7px] w-[7px] flex-none rounded-[2px] bg-ok"
        : "h-[7px] w-[7px] flex-none rounded-[2px] bg-warn",
  );
  const inactiveDot = "h-[7px] w-[7px] flex-none rounded-[2px] bg-[#39414C]";

  let current = deps.mode;

  const render = (mode: ControlMode): void => {
    current = mode;
    for (let index = 0; index < CONTROL_MODES.length; index += 1) {
      const active = CONTROL_MODES[index].id === mode;
      buttons[index].setAttribute("aria-checked", String(active));
      cls(dots[index], active ? dotClasses[index] : inactiveDot);
      cls(overlays[index], active ? ACTIVE[CONTROL_MODES[index].color] : INACTIVE);
    }
  };

  const listeners = buttons.map((button) => {
    const mode = button.dataset.mode as ControlMode;
    const select = (): void => {
      if (mode === current) return;
      deps.onModeChange(mode);
      render(mode);
    };
    button.addEventListener("click", select);
    return { button, select };
  });

  render(current);

  return {
    setMode: render,
    dispose() {
      for (const { button, select } of listeners) button.removeEventListener("click", select);
    },
  };
}
