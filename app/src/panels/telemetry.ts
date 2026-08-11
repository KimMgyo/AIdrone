/**
 * The left panel's TELEMETRY block: nine tiles straight off the Tello state
 * datagram, plus three attitude tracks.
 *
 * Every number is printed in the SDK's own unit and nothing is converted here.
 * `h`, `tof` and `baro` are documented in cm so they say cm; `vgx/vgy/vgz` have
 * NO documented unit in SDK 2.0, so they carry no unit label at all - printing
 * a guessed cm/s next to a velocity on a flight display is worse than admitting
 * the datagram never said. (The HUD's metre conversion for altitude is safe
 * only because `h` is documented; that licence does not extend to anything
 * else, so no arithmetic happens in this file beyond fixed-point formatting.)
 *
 * An absent field renders `--`, never 0. Firmware revisions omit fields and a
 * half-parsed datagram must not read as "on the ground, stationary, 0 %
 * battery". `update(null)` blanks every cell for the same reason: no session is
 * not a reading.
 */
import type { DroneState } from "../transport.ts";
import { all, cls, style, text } from "../ui.ts";

/**
 * Link measurements that the state datagram cannot carry. A missing value is
 * deliberately different from zero: the grid must not turn "not measured" into
 * a measurement just to fill a prototype cell.
 */
export type TelemetryRates = {
  /** Receiver-side frame rate derived from real video counters. */
  fps?: number | null;
};

export interface TelemetryPanel {
  /** `null` is the no-session state and blanks every state-backed cell. */
  update(s: DroneState | null, rates?: TelemetryRates): void;
}

const MISSING = "--";

/** Split out because the battery cell is the only one whose colour moves, so
 *  its className is rebuilt on every tick and has to agree with the markup. */
const TILE_VALUE = "font-mono text-[14px]";

/** The prototype's ten-cell grid, with only fields the station can substantiate
 * bound below. WIFI and LOSS have no source on this link, so they stay `--`;
 * FPS has an optional real receiver-side measurement. */
const TILES: readonly { k: string; label: string; unit: string }[] = [
  { k: "bat", label: "BATT", unit: "%" },
  { k: "alt", label: "ALT", unit: "m" },
  { k: "flight", label: "FLIGHT", unit: "s" },
  { k: "temp", label: "TEMP", unit: "°C" },
  { k: "vgx", label: "VX", unit: "" },
  { k: "vgy", label: "VY", unit: "" },
  { k: "vgz", label: "VZ", unit: "" },
  { k: "wifi", label: "WIFI", unit: "snr" },
  { k: "fps", label: "FPS", unit: "" },
  { k: "loss", label: "LOSS", unit: "%" },
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
        <div class="flex-none grid grid-cols-[repeat(auto-fit,minmax(70px,1fr))] gap-px bg-line2 border border-line2 rounded-[3px] overflow-hidden">${tiles}
        </div>${rows}
      </div>
    </div>
  `;

  const [vBat, vAlt, vFlight, vTemp, vVgx, vVgy, vVgz, vWifi, vFps, vLoss] = all(
    "[data-t]",
    HTMLDivElement,
    mount,
    TILES.length,
  );
  const attValues = all("[data-a]", HTMLDivElement, mount, ATT.length);
  const needles = all("[data-n]", HTMLDivElement, mount, ATT.length);

  const panel: TelemetryPanel = {
    update(s, rates) {
      text(vBat, num(s?.bat, 0));
      cls(vBat, `${TILE_VALUE} ${batTone(s?.bat)}`);
      text(vAlt, metres(s?.h));
      text(vFlight, num(s?.time, 0));
      text(vTemp, tempRange(s?.templ, s?.temph));
      // The SDK names these fields vgx/vgy/vgz but documents no unit. Their
      // raw values are real; printing m/s beside them would not be.
      text(vVgx, num(s?.vgx, 0));
      text(vVgy, num(s?.vgy, 0));
      text(vVgz, num(s?.vgz, 0));
      text(vWifi, MISSING);
      text(vFps, rate(rates?.fps));
      text(vLoss, MISSING);

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

/** Tello's `h` is documented in centimetres; the station's ALT cell is metres. */
function metres(cm: number | undefined): string {
  const value = fin(cm);
  if (value === null) return MISSING;
  return (value / 100).toFixed(2);
}

/** A zero receiver rate is the pre-measurement / stopped-stream sentinel, not
 * a completed FPS sample. */
function rate(v: number | null | undefined): string {
  const value = fin(v);
  if (value === null || value <= 0) return MISSING;
  return value.toFixed(0);
}

/** `templ`/`temph` are the two ends of one board-temperature range, so one
 *  without the other is not a range and there is nothing honest to print. */
function tempRange(lo: number | undefined, hi: number | undefined): string {
  const a = fin(lo);
  const b = fin(hi);
  return a === null || b === null ? MISSING : `${a.toFixed(0)}-${b.toFixed(0)}`;
}

/**
 * The one threshold colour on the panel. 30 % is where a Tello still has a
 * comfortable return margin, 15 % is where it starts refusing to take off, and
 * everything else on screen stays neutral so that this cell is the only thing
 * that can go red. A blank battery is not an alert - `--` stays `text-ink`.
 */
function batTone(bat: number | undefined): string {
  const v = fin(bat);
  if (v === null) return "text-ink";
  if (v >= 30) return "text-ok";
  return v >= 15 ? "text-warn" : "text-alert";
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
