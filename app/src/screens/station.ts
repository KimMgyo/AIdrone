/**
 * The station shell: top bar, three columns, status bar - and the geometry that
 * keeps the drone's 4:3 picture whole inside them.
 *
 * The layout's one non-obvious rule is that the CENTRE column is sized, not
 * flexed. Its width is computed from the space the two side rails leave, then
 * floored to an exact 4:3 box; the rails are `flex:1 1 0` and absorb whatever is
 * left over. Letting the centre flex instead would letterbox the stream inside
 * its own stage - black bars the app itself painted, on top of the black bars
 * the canvas already draws - so the measurement is what makes the picture
 * reach the edges of its frame.
 *
 * Panels are docked, not floating, so there is no idle-fade here: the old viewer
 * hid chrome that sat ON the picture, and nothing does any more. What replaced
 * it is explicit - Ctrl+B drops the left rail, Ctrl+J drops the console, and
 * both give their space straight back to the stage through the same measure.
 */
import type { ControlMode } from "../control-mode.ts";
import { must, style, text } from "../ui.ts";

/** Every live cell in the shell, in one shape. Panels own their own state; this
 *  is only the chrome around them. */
export type StationModel = {
  /** The selected left-rail surface. It is a selection, not an autonomous-flight claim. */
  mode: ControlMode;
  live: boolean;
  node: string;
  tello: string;
  /** Measured receive-to-paint p50, not a command round-trip time. */
  rttMs: number | null;
  /** The transport half of that same number: Rust's arrival stamp to the
   *  moment the WebView was handed the bytes. Shown beside the total because
   *  the two halves have opposite fixes - a large IPC number is the Tauri hop,
   *  a large remainder is decode plus however long the compositor made the
   *  paint wait. */
  ipcMs: number | null;
  bat: number | null;
  /** Motor-on seconds, straight off the drone's state datagram. */
  flightS: number | null;
  status: string;
  rxPktsPerSec: number | null;
  mbps: number | null;
  gapMaxMs: number | null;
  dropped: number | null;
  /** False once link.rs reports the datapath silent. */
  linkOk: boolean;
};

export interface Station {
  readonly canvas: HTMLCanvasElement;
  readonly mounts: {
    mode: HTMLElement;
    manual: HTMLElement;
    person: HTMLElement;
    aruco: HTMLElement;
    telemetry: HTMLElement;
    overlay: HTMLElement;
    console: HTMLElement;
    copilot: HTMLElement;
    timeline: HTMLElement;
  };
  update(m: StationModel): void;
  setMode(mode: ControlMode): void;
  toggleLeft(): void;
  toggleBottom(): void;
  dispose(): void;
}

/** Both rails are `min-width:300px` plus their 1px border. The stage may not
 *  claim that space, so the measurement subtracts it whether or not the rail is
 *  currently showing anything. */
const RAIL_W = 301;

/** Floor for the console / telemetry / timeline blocks, and the fraction of the
 *  window they may take. Below ~190 px the console shows fewer than four lines
 *  and stops being readable at a glance. */
const PANEL_MIN = 190;
const PANEL_MAX = 290;
const MISSING = "--";

const CHIP = "flex items-center gap-[7px] h-[26px] px-[10px] bg-chip border border-[#232931] rounded-[3px]";
const TOGGLE =
  "w-[28px] h-[26px] bg-chip border border-[#232931] rounded-[3px] cursor-pointer flex items-center justify-center hover:bg-[#1C222A] hover:border-line4";
const HEADER_DOT = "w-[6px] h-[6px] rounded-full";

type StationDeps = {
  onDisconnect: () => void;
  onEmergency: () => void;
  /**
   * The Tauri host can provide its native window toggle. The browser fallback
   * keeps the visual control useful in a plain webview without coupling this
   * shell to main.ts or to a platform API.
   */
  onFullscreen?: () => void | Promise<void>;
};

function known(value: string): string {
  return value.trim() === "" ? MISSING : value;
}

function finite(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value;
}


export function installStation(mount: HTMLElement, deps: StationDeps): Station {
  mount.innerHTML = `
    <div class="h-[52px] flex-none border-b border-line bg-[#101318] flex items-center px-[13px] gap-[14px]">
      <div class="flex items-center gap-[9px]">
        <div class="w-[9px] h-[9px] bg-accent rounded-[2px]"></div>
        <div class="text-[13px] font-semibold tracking-[-.01em]">AIdrone Station</div>
      </div>
      <div class="w-px h-[20px] bg-line"></div>

      <div class="${CHIP}">
        <div data-k="node-dot" class="${HEADER_DOT} bg-dim3"></div>
        <div class="font-mono text-[11px] text-ink2">NODE <span data-k="node">--</span></div>
      </div>
      <div class="${CHIP}">
        <div data-k="tello-dot" class="${HEADER_DOT} bg-dim3"></div>
        <div class="font-mono text-[11px] text-ink2">TELLO <span data-k="tello">--</span></div>
      </div>
      <div class="${CHIP}">
        <div class="font-mono text-[11px] text-dim2">RECV&rarr;PAINT</div>
        <div class="font-mono text-[11px] text-ink2"><span data-k="rtt">--</span> ms</div>
      </div>

      <div class="flex-1"></div>

      <div class="flex items-center gap-[18px] pr-[6px]">
        <div class="flex flex-col gap-[2px] items-end">
          <div class="font-mono text-[9.5px] tracking-[.14em] text-dim2">BATTERY</div>
          <div data-k="bat" class="font-mono text-[13px] text-dim">--</div>
        </div>
        <div class="flex flex-col gap-[2px] items-end">
          <div class="font-mono text-[9.5px] tracking-[.14em] text-dim2">FLIGHT</div>
          <div data-k="flight" class="font-mono text-[13px] text-ink2">--</div>
        </div>
      </div>

      <div class="flex items-center gap-[5px] pr-[2px]">
        <button data-k="tg-left" type="button" title="좌측 패널 (Ctrl+B)" class="${TOGGLE}">
          <div class="relative w-[15px] h-[11px] border border-[#7C848F] rounded-[1px]">
            <div data-k="gl-left" class="absolute left-0 top-0 bottom-0 w-[4px] bg-accent"></div>
          </div>
        </button>
        <button data-k="tg-bottom" type="button" title="UDP 콘솔 (Ctrl+J)" class="${TOGGLE}">
          <div class="relative w-[15px] h-[11px] border border-[#7C848F] rounded-[1px]">
            <div data-k="gl-bottom" class="absolute left-0 right-0 bottom-0 h-[4px] bg-accent"></div>
          </div>
        </button>
      </div>
      <div class="w-px h-[20px] bg-line"></div>

      <button data-k="disconnect" type="button"
        class="h-[30px] px-[13px] bg-chip border border-[#232931] rounded-[3px] text-ink2 text-[12px] cursor-pointer hover:bg-[#1C222A] hover:border-line4">연결 해제</button>
      <button data-k="estop" type="button" title="모터 즉시 정지 (ESC)"
        class="h-[30px] px-[15px] bg-alert/12 border border-alert/45 rounded-[3px] text-alert2 text-[12px] font-semibold cursor-pointer hover:bg-alert/22 hover:text-[#FFB3B3]">비상 정지</button>
    </div>

    <div data-k="row" class="flex-1 min-h-0 flex">
      <div data-k="left" class="flex-1 basis-0 min-w-[300px] min-h-0 overflow-hidden flex flex-col bg-panel border-r border-line">
        <div data-k="m-mode" class="flex-none border-b border-line2"></div>
        <div data-k="mode-panels" class="flex-1 basis-0 min-h-[120px] overflow-hidden">
          <div data-k="m-manual" class="h-full overflow-y-auto overflow-x-hidden"></div>
          <div data-k="m-person" class="h-full overflow-y-auto overflow-x-hidden"></div>
          <div data-k="m-aruco" class="h-full overflow-y-auto overflow-x-hidden"></div>
        </div>
        <div data-k="m-telemetry" class="flex-none max-h-[38%] border-t border-line2 flex flex-col"></div>
      </div>

      <div data-k="stage-col" class="flex-none min-w-0 flex flex-col justify-center bg-stage">
        <div data-k="stage" class="flex-none m-auto w-full relative bg-[#0E1114] overflow-hidden">
          <div data-k="hatch" class="absolute inset-0"
            style="background-image:repeating-linear-gradient(135deg,#12161A 0px,#12161A 9px,#0E1114 9px,#0E1114 18px)"></div>
          <div data-k="hatch-label" class="absolute inset-0 flex items-center justify-center">
            <div class="font-mono text-[11px] tracking-[.2em] text-[#373F49]">DRONE&nbsp;CAMERA&nbsp;FEED&nbsp;&middot;&nbsp;H.264&nbsp;UDP&nbsp;11111</div>
          </div>
          <canvas id="video" width="960" height="720" class="absolute inset-0"></canvas>
          <div data-k="m-overlay" class="absolute inset-0 pointer-events-none"></div>
          <button data-k="fullscreen" type="button" title="전체 화면 (F)"
            class="absolute top-[13px] right-[15px] flex items-center justify-center w-[24px] h-[24px] bg-bg/75 border border-line3 rounded-[3px] text-dim hover:bg-[#1C222A] hover:border-line4 hover:text-ink2">
            <svg aria-hidden="true" viewBox="0 0 16 16" class="w-[13px] h-[13px] fill-none stroke-current stroke-[1.25]">
              <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4"></path>
            </svg>
          </button>
        </div>
        <div data-k="m-console" class="flex-none border-t border-line bg-sunken flex flex-col"></div>
      </div>

      <div data-k="right" class="flex-1 basis-0 min-w-[300px] min-h-0 overflow-hidden flex flex-col bg-panel border-l border-line">
        <div data-k="m-copilot" class="flex-1 min-h-0 flex flex-col"></div>
        <div data-k="m-timeline" class="flex-none border-t border-line2 flex flex-col"></div>
      </div>
    </div>

    <div class="h-[26px] flex-none border-t border-line bg-[#0D1014] flex items-center px-[14px] gap-[18px] font-mono text-[10.5px] text-dim2">
      <div data-k="status" class="text-dim">idle</div>
      <div class="flex-1"></div>
      <div>RX <span data-k="rx">--</span> pkt/s</div>
      <div><span data-k="mbps">--</span> Mb/s</div>
      <div>GAP <span data-k="gap">--</span> ms</div>
      <div>IPC <span data-k="ipc">--</span> ms</div>
      <div>DROP <span data-k="drop">--</span></div>
      <div data-k="link" class="text-dim2">LINK IDLE</div>
    </div>
  `;

  const q = <T extends Element>(k: string, ctor: new () => T) => must(`[data-k="${k}"]`, ctor, mount);

  const row = q("row", HTMLDivElement);
  const left = q("left", HTMLDivElement);
  const stageCol = q("stage-col", HTMLDivElement);
  const stage = q("stage", HTMLDivElement);
  const hatch = q("hatch", HTMLDivElement);
  const hatchLabel = q("hatch-label", HTMLDivElement);
  const canvas = must("#video", HTMLCanvasElement, mount);

  const mounts: Station["mounts"] = {
    mode: q("m-mode", HTMLDivElement),
    manual: q("m-manual", HTMLDivElement),
    person: q("m-person", HTMLDivElement),
    aruco: q("m-aruco", HTMLDivElement),
    telemetry: q("m-telemetry", HTMLDivElement),
    overlay: q("m-overlay", HTMLDivElement),
    console: q("m-console", HTMLDivElement),
    copilot: q("m-copilot", HTMLDivElement),
    timeline: q("m-timeline", HTMLDivElement),
  };

  const cell = {
    node: q("node", HTMLSpanElement),
    nodeDot: q("node-dot", HTMLDivElement),
    tello: q("tello", HTMLSpanElement),
    telloDot: q("tello-dot", HTMLDivElement),
    rtt: q("rtt", HTMLSpanElement),
    bat: q("bat", HTMLDivElement),
    flight: q("flight", HTMLDivElement),
    status: q("status", HTMLDivElement),
    rx: q("rx", HTMLSpanElement),
    mbps: q("mbps", HTMLSpanElement),
    gap: q("gap", HTMLSpanElement),
    ipc: q("ipc", HTMLSpanElement),
    drop: q("drop", HTMLSpanElement),
    link: q("link", HTMLDivElement),
    glLeft: q("gl-left", HTMLDivElement),
    glBottom: q("gl-bottom", HTMLDivElement),
  };

  let leftOpen = true;
  let bottomOpen = true;
  let currentMode: ControlMode = "key";

  /**
   * Ported from the prototype's own `measure()`. Runs on every resize and every
   * rail toggle; writes only when a number actually changed, because a
   * ResizeObserver that writes the size it just observed re-triggers itself.
   */
  function measure(): void {
    const w = row.clientWidth;
    const h = row.clientHeight;
    if (w === 0 || h === 0) return;

    const availW = Math.max(360, w - (leftOpen ? RAIL_W : 0) - RAIL_W);
    const panelH = Math.round(
      Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.min(window.innerHeight * 0.3, h - 200))),
    );
    const availH = Math.max(260, h - (bottomOpen ? panelH + 1 : 0));
    const frameW = Math.floor(Math.min((availH * 4) / 3, availW));
    const frameH = Math.round((frameW * 3) / 4);

    style(stageCol, "width", `${frameW}px`);
    style(stage, "height", `${frameH}px`);
    style(mounts.console, "height", `${panelH}px`);
    style(mounts.telemetry, "height", `${panelH}px`);
    style(mounts.timeline, "height", `${panelH}px`);
  }

  const ro = new ResizeObserver(() => measure());
  ro.observe(row);

  q("disconnect", HTMLButtonElement).addEventListener("click", deps.onDisconnect);
  q("estop", HTMLButtonElement).addEventListener("click", deps.onEmergency);

  function setLeft(open: boolean): void {
    leftOpen = open;
    style(left, "display", open ? "flex" : "none");
    cell.glLeft.className = `absolute left-0 top-0 bottom-0 w-[4px] ${open ? "bg-accent" : "bg-dim3"}`;
    measure();
  }

  function setBottom(open: boolean): void {
    bottomOpen = open;
    style(mounts.console, "display", open ? "flex" : "none");
    cell.glBottom.className = `absolute left-0 right-0 bottom-0 h-[4px] ${open ? "bg-accent" : "bg-dim3"}`;
    measure();
  }

  function showModePanel(panel: HTMLElement, visible: boolean): void {
    panel.hidden = !visible;
    panel.setAttribute("aria-hidden", String(!visible));
  }

  function setMode(mode: ControlMode): void {
    currentMode = mode;
    showModePanel(mounts.manual, mode === "key");
    showModePanel(mounts.person, mode === "person");
    showModePanel(mounts.aruco, mode === "aruco");

  }

  function toggleFullscreen(): void {
    if (deps.onFullscreen !== undefined) {
      void deps.onFullscreen();
      return;
    }

    const action =
      document.fullscreenElement === null ? document.documentElement.requestFullscreen() : document.exitFullscreen();
    void action.catch(() => undefined);
  }

  q("tg-left", HTMLButtonElement).addEventListener("click", () => setLeft(!leftOpen));
  q("tg-bottom", HTMLButtonElement).addEventListener("click", () => setBottom(!bottomOpen));
  q("fullscreen", HTMLButtonElement).addEventListener("click", toggleFullscreen);

  setMode(currentMode);
  measure();

  return {
    canvas,
    mounts,

    update(m: StationModel): void {
      if (m.mode !== currentMode) setMode(m.mode);

      // The hatch is what says "no picture" - it must vanish the instant the
      // canvas has something on it, or the first frames paint over a texture.
      style(hatch, "display", m.live ? "none" : "block");
      style(hatchLabel, "display", m.live ? "none" : "flex");
      style(canvas, "display", m.live ? "block" : "none");

      const node = known(m.node);
      const tello = known(m.tello);
      text(cell.node, node);
      text(cell.tello, tello);
      const nodeLive = m.live && node !== MISSING;
      const telloLive = m.live && tello !== MISSING;
      cell.nodeDot.className = `${HEADER_DOT} ${nodeLive ? "bg-ok animate-beat" : "bg-dim3"}`;
      cell.telloDot.className = `${HEADER_DOT} ${telloLive ? "bg-ok" : "bg-dim3"}`;

      const receiveToPaint = finite(m.rttMs);
      text(cell.rtt, receiveToPaint === null ? MISSING : receiveToPaint.toFixed(1));

      // Battery is the one readout that changes colour, and it uses the drone's
      // own thresholds: a Tello's SDK channel gets unreliable well before the
      // pack is empty (README, three separate sessions died that way).
      const battery = finite(m.bat);
      text(cell.bat, battery === null ? MISSING : `${battery}%`);
      const batTone =
        battery === null ? "text-dim" : battery >= 30 ? "text-ok" : battery >= 15 ? "text-warn" : "text-alert";
      cell.bat.className = `font-mono text-[13px] ${batTone}`;

      const flight = finite(m.flightS);
      text(
        cell.flight,
        flight === null ? MISSING : `${Math.floor(flight / 60)}:${String(Math.floor(flight) % 60).padStart(2, "0")}`,
      );

      text(cell.status, known(m.status));
      const rx = finite(m.rxPktsPerSec);
      const mbps = finite(m.mbps);
      const gap = finite(m.gapMaxMs);
      const dropped = finite(m.dropped);
      text(cell.rx, rx === null ? MISSING : String(rx));
      text(cell.mbps, mbps === null ? MISSING : mbps.toFixed(2));
      text(cell.gap, gap === null ? MISSING : String(gap));
      const ipc = finite(m.ipcMs);
      text(cell.ipc, ipc === null ? MISSING : ipc.toFixed(1));
      text(cell.drop, dropped === null ? MISSING : String(dropped));

      text(cell.link, !m.live ? "LINK IDLE" : m.linkOk ? "LINK STABLE" : "LINK SILENT");
      cell.link.className = !m.live ? "text-dim2" : m.linkOk ? "text-ok" : "text-alert";
    },

    setMode,
    toggleLeft: () => setLeft(!leftOpen),
    toggleBottom: () => setBottom(!bottomOpen),
    dispose: () => ro.disconnect(),
  };
}
