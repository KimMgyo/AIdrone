/**
 * The left panel's TELEMETRY block: the drone's own state, in the SDK's own
 * units, and nothing else.
 *
 * What is NOT here is deliberate. Battery and flight time live in the top bar,
 * altitude and heading in the HUD over the picture, and every link/pipeline
 * rate in the status bar - each fact has exactly one home, so a glance at two
 * places can never disagree. This block holds what those three cannot: the
 * readings you consult rather than fly by.
 *
 * `tof` and `baro` are documented in cm so they say cm; `vgx/vgy/vgz` have NO
 * documented unit in SDK 2.0, so they carry no unit label at all - printing a
 * guessed cm/s next to a velocity on a flight display is worse than admitting
 * the datagram never said. No arithmetic happens in this file beyond
 * fixed-point formatting.
 *
 * An absent field renders `--`, never 0. Firmware revisions omit fields and a
 * half-parsed datagram must not read as "on the ground, stationary". A cell
 * with no source at all does not belong here in any form: WIFI and LOSS were
 * such cells, printed `--` forever, and they are gone rather than pretending
 * to be instruments that were merely quiet.
 */
import type { DroneState } from "../transport.ts";
import { all, style, text } from "../ui.ts";

export interface TelemetryPanel {
  /** `null` blanks every cell: no session is not a reading. */
  update(state: DroneState | null): void;
}

const MISSING = "--";

/** Every tile prints the same way; nothing on this panel changes colour, since
 *  the one reading with a threshold - battery - is the top bar's. */
const TILE_VALUE = "font-mono text-[14px] text-ink";

/** Six cells, all of them substantiated by the state datagram. */
const TILES: readonly { k: string; label: string; unit: string }[] = [
  { k: "tof", label: "TOF", unit: "cm" },
  { k: "baro", label: "BARO", unit: "cm" },
  { k: "temp", label: "TEMP", unit: "°C" },
  { k: "vgx", label: "VX", unit: "" },
  { k: "vgy", label: "VY", unit: "" },
  { k: "vgz", label: "VZ", unit: "" },
];

/**
 * The three attitude tracks. `deflect` maps degrees onto the needle's input:
 * pitch and roll stay within ±30° in normal flight, so the prototype's
 * 3.2 %/° fills the 4px track without saturating, while yaw spans the full
 * ±180 and is divided by 12 first so a heading sweep crosses the track instead
 * of sitting pinned at an end. Both constants are the prototype's.
 */
const ATT: readonly {
  k: string;
  label: string;
  pick: (s: DroneState) => number | undefined;
  deflect: (v: number) => number;
}[] = [
  { k: "pitch", label: "PITCH", pick: (s) => s.pitch, deflect: (v) => v },
  { k: "roll", label: "ROLL", pick: (s) => s.roll, deflect: (v) => v },
  {
    k: "yaw",
    label: "YAW",
    pick: (s) => s.yaw,
    // Wrapped to -180..180 before scaling. Tello already reports it that way,
    // but firmware handing back 359 must not peg the needle, and JS `%` keeps
    // the sign of the dividend - hence the +540 detour over a bare `% 360`.
    deflect: (v) => ((((v % 360) + 540) % 360) - 180) / 12,
  },
];

/** Needle at rest. Also the parked position for a field the drone did not
 *  send, which is why it is a shared constant and not written twice. */
const CENTRE = "calc(50% - 3px)";

/**
 * ten tiles and three rows whose structure is fixed, so a tick only ever
 * moves text, one class and three `left` offsets.
 *
 * The root is `h-full`: station.ts hands the mount a px height from its measure
 * loop plus `max-h-[38%]`, so height:100% resolves and the scroll body can hang
 * its `min-h-0` off it. The block's outer `border-t` and that height are the
 * shell's - drawing either here would double the hairline.
 */
export function installTelemetry(mount: HTMLElement): TelemetryPanel {
  const tiles = TILES.map(
    (t) => `
          <div class="bg-tile px-[9px] py-[9px] flex flex-col gap-[4px]">
            <div class="font-mono text-[9px] tracking-[.1em] text-dim2">${t.label}</div>
            <div class="flex items-baseline gap-[3px]">
              <div data-t="${t.k}" class="${TILE_VALUE} text-ink">${MISSING}</div>${
                t.unit
                  ? `
              <div class="font-mono text-[9px] text-dim2">${t.unit}</div>`
                  : ""
              }
            </div>
          </div>`,
  ).join("");

  const rows = ATT.map(
    (a) => `
        <div class="flex-none flex items-center gap-[9px]">
          <div class="font-mono text-[10px] tracking-[.1em] text-dim2 w-[38px]">${a.label}</div>
          <div class="flex-1 h-[4px] bg-[#1A2027] rounded-[2px] relative">
            <div class="absolute left-1/2 -top-[2px] -bottom-[2px] w-px bg-[#2A313A]"></div>
            <div data-n="${a.k}" class="absolute -top-[2px] w-[6px] h-[8px] rounded-[1px] bg-accent"
                 style="left:${CENTRE}"></div>
          </div>
          <div data-a="${a.k}" class="font-mono text-[10.5px] text-ink2 w-[34px] text-right">${MISSING}</div>
        </div>`,
  ).join("");

  mount.innerHTML = `
    <div class="h-full flex flex-col">
      <div class="flex-none h-[36px] px-[14px] flex items-center">
        <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">TELEMETRY</div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-[14px] pb-[12px] flex flex-col gap-[10px]">
        <!-- Exactly three columns for exactly six cells: an auto-fit grid left
             a half-empty seventh cell as soon as the dead readouts went. -->
        <div class="flex-none grid grid-cols-3 gap-px bg-line2 border border-line2 rounded-[3px] overflow-hidden">${tiles}
        </div>${rows}
      </div>
    </div>
  `;

  const [vTof, vBaro, vTemp, vVgx, vVgy, vVgz] = all("[data-t]", HTMLDivElement, mount, TILES.length);
  const attValues = all("[data-a]", HTMLDivElement, mount, ATT.length);
  const needles = all("[data-n]", HTMLDivElement, mount, ATT.length);

  const panel: TelemetryPanel = {
    update(s) {
      text(vTof, num(s?.tof, 0));
      text(vBaro, num(s?.baro, 0));
      text(vTemp, tempRange(s?.templ, s?.temph));
      // The SDK names these fields vgx/vgy/vgz but documents no unit. Their
      // raw values are real; printing m/s beside them would not be.
      text(vVgx, num(s?.vgx, 0));
      text(vVgy, num(s?.vgy, 0));
      text(vVgz, num(s?.vgz, 0));

      for (let i = 0; i < ATT.length; i++) {
        const a = ATT[i];
        const v = fin(s === null ? undefined : a.pick(s));
        text(attValues[i], v === null ? MISSING : `${v.toFixed(0)}°`);
        style(needles[i], "left", v === null ? CENTRE : offset(a.deflect(v)));
      }
    },
  };

  return panel;
}


/** Every state field is optional, and a truncated datagram can parse to NaN;
 * both mean "the drone did not tell us", so both collapse to one null. */
function fin(v: number | null | undefined): number | null {
  if (v === undefined || v === null || !Number.isFinite(v)) return null;
  return v;
}

function num(v: number | null | undefined, dp: number): string {
  const n = fin(v);
  return n === null ? MISSING : n.toFixed(dp);
}

/** `templ`/`temph` are the two ends of one board-temperature range, so one
 *  without the other is not a range and there is nothing honest to print. */
function tempRange(lo: number | undefined, hi: number | undefined): string {
  const a = fin(lo);
  const b = fin(hi);
  return a === null || b === null ? MISSING : `${a.toFixed(0)}-${b.toFixed(0)}`;
}

/**
 * Needle offset along the track. 3px is half the needle's width, so the value
 * sits under its centre rather than beside it.
 *
 * Rounded to one decimal - 0.1 % of this track is ~0.2px, under a device pixel
 * - and stringified WITHOUT `toFixed`, because Chromium serialises the property
 * back as `calc(74% - 3px)`: a written `74.0` never equals what it reads, and
 * `style()` would then rewrite the needle on every tick of a hovering drone.
 */
function offset(deflection: number): string {
  const p = Math.max(0, Math.min(100, 50 + deflection * 3.2));
  return `calc(${Math.round(p * 10) / 10}% - 3px)`;
}
