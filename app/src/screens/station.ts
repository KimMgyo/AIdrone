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
import type { NodeLink } from "../transport.ts";
import { must, style, text } from "../ui.ts";

/**
 * The connection, as the shell needs to show it, has two peers. The node is a
 * USB bulk transport; the drone is a radio peer behind it. They fail
 * separately and the remedies differ, so a single "연결됨" hid the first
 * thing an operator needs to know: plug the cable in, or power-cycle the
 * drone.
 *
 * `node` is two-valued because the direct vendor interface is either available
 * to Rust or absent. There is no network-link state to infer.
 *
 * `drone` is `null`, never `false`, while the node is not ready: with no path
 * to the aircraft, calling it silent would be a claim this app cannot make.
 */
export type LinkView = {
  phase: "connecting" | "online" | "offline";
  node: NodeLink;
  drone: boolean | null;
  /** The reason there is no picture - a failure message, or what to do about
   *  it. Empty exactly when there is nothing to explain. */
  detail: string;
};

/** The newer build, once GitHub has been asked. Offered in the top bar only
 *  while the link is down: the installer replaces this binary underneath a
 *  running process, so it must never be reachable with a drone in the air. */
export type UpdateView = {
  version: string;
  applying: boolean;
  error: string | null;
};

/** Every live cell in the shell, in one shape. Panels own their own state; this
 *  is only the chrome around them. */
export type StationModel = {
  /** The selected left-rail surface. It is a selection, not an autonomous-flight claim. */
  mode: ControlMode;
  live: boolean;
  /** What the supervisor is doing about the link. The addresses it dials are
   *  fixed constants, so they are not modelled here - only the outcome is. */
  link: LinkView;
  /** Measured receive-to-paint p50, not a command round-trip time. */
  rttMs: number | null;
  /** The transport half of that same number: Rust's arrival stamp to the
   *  moment the WebView was handed the bytes. Shown beside the total because
   *  the two halves have opposite fixes - a large IPC number is the Tauri hop,
   *  a large remainder is decode plus however long the compositor made the
   *  paint wait. */
  ipcMs: number | null;
  /** Decoder-only latency, so the remainder of `rttMs` is ours. */
  decodeMs: number | null;
  /** Painted frames in the last second - the pipeline's own output rate, which
   *  is not the link's arrival rate and must not be read as it. */
  fps: number | null;
  status: string;
  rxPktsPerSec: number | null;
  mbps: number | null;
  gapMaxMs: number | null;
  dropped: number | null;
  /** False once link.rs reports the datapath silent. */
  linkOk: boolean;
  /** `null` while this build is current, or while a drone is flying. */
  update: UpdateView | null;
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

const CHIP =
  "flex flex-none items-center gap-[7px] h-[26px] px-[10px] bg-chip border border-[#232931] rounded-[3px]";
const TOGGLE =
  "flex-none w-[28px] h-[26px] bg-chip border border-[#232931] rounded-[3px] cursor-pointer flex items-center justify-center hover:bg-[#1C222A] hover:border-line4";
const HEADER_DOT = "w-[6px] h-[6px] rounded-full";
/** Every divider in the bar. `flex-none` because a 1px rule that flexes is a
 *  0px rule the moment the window is narrow. */
const RULE = "w-px h-[20px] flex-none bg-line";
/** Takeoff and land. Same footprint as the emergency button beside them so the
 *  three read as one group, but never its colour - the red one has to stay the
 *  only red thing in the bar. */
const FLIGHT_BTN =
  "h-[30px] flex-none px-[13px] border rounded-[3px] text-[12px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-default";

/** The hatch's headline, which is about the picture and so still follows the
 *  phase. The two chips beside it answer a narrower question each. */
const PHASE_COPY: Record<LinkView["phase"], string> = {
  connecting: "연결 중",
  online: "연결됨",
  offline: "오프라인",
};

/** The node cell reflects direct vendor-interface availability, not an inferred
 * network adapter state. */
const NODE_COPY: Record<NodeLink, { copy: string; dot: string }> = {
  ready: { copy: "연결됨", dot: "bg-ok" },
  absent: { copy: "없음", dot: "bg-alert" },
};

/** `null` is not a third kind of down - it is "cannot say", which is what the
 *  drone cell honestly reads while the node is missing. */
function peerCopy(up: boolean | null): { copy: string; dot: string } {
  if (up === null) return { copy: "--", dot: "bg-dim3" };
  return up ? { copy: "연결됨", dot: "bg-ok" } : { copy: "없음", dot: "bg-alert" };
}

type StationDeps = {
  onEmergency: () => void;
  onUpdate: () => void;
  /** The two flight commands in the top bar. Same path as the T and L keys -
   *  the shell does not decide whether they are allowed, it only asks. */
  onTakeoff: () => void;
  onLand: () => void;
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
    <!-- Nowrap, and every item flex-none: at a narrow window the bar must run
         out of room rather than reflow, because the window has a minimum width
         that fits it exactly once (see tauri.conf.json). -->
    <div class="h-[52px] flex-none border-b border-line bg-[#101318] flex items-center overflow-hidden px-[13px] gap-[13px] whitespace-nowrap">
      <div class="flex flex-none items-center gap-[9px]">
        <div class="w-[9px] h-[9px] flex-none bg-accent rounded-[2px]"></div>
        <div class="text-[13px] font-semibold tracking-[-.01em]">AIdrone Station</div>
      </div>
      <div class="${RULE}"></div>

      <!-- Two chips, because there are two connections and they fail
           separately: the node is a USB adapter that is either attached or
           not, the drone is a radio peer behind it. One combined "연결됨" hid
           which of the two to go and fix. Neither carries an address - both
           ends are fixed constants the app already knows. -->
      <div class="${CHIP}">
        <div data-k="node-dot" class="${HEADER_DOT} bg-dim3"></div>
        <div class="font-mono text-[11px] text-dim2">NODE</div>
        <div data-k="node-copy" class="font-mono text-[11px] text-ink2">--</div>
      </div>
      <div class="${CHIP}">
        <div data-k="drone-dot" class="${HEADER_DOT} bg-dim3"></div>
        <div class="font-mono text-[11px] text-dim2">DRONE</div>
        <div data-k="drone-copy" class="font-mono text-[11px] text-ink2">--</div>
      </div>
      <div data-k="update" class="${CHIP} border-accent/40 bg-accent/10" hidden>
        <div class="font-mono text-[11px] text-accent">새 버전 <span data-k="update-version">--</span></div>
        <button data-k="update-apply" type="button" class="h-[19px] rounded-[2px] bg-accent px-[7px] font-mono text-[10px] font-semibold text-[#08131A] cursor-pointer hover:bg-accent2 disabled:opacity-50 disabled:cursor-default">설치</button>
      </div>

      <div class="flex-1 min-w-[8px]"></div>

      <div class="flex flex-none items-center gap-[5px]">
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
      <div class="${RULE}"></div>

      <!-- Takeoff, land, then the emergency. Ordered by how bad it is to hit
           the wrong one: the two flight commands are ordinary buttons in the
           app's own tones, and the red one keeps its own space at the end. -->
      <button data-k="takeoff" type="button" title="이륙 (T)"
        class="${FLIGHT_BTN} border-ok/40 bg-ok/10 text-ok hover:bg-ok/20 hover:border-ok/60">이륙</button>
      <button data-k="land" type="button" title="착륙 (L)"
        class="${FLIGHT_BTN} border-line4 bg-raised text-ink2 hover:bg-[#1C222A] hover:border-[#7C848F]">착륙</button>
      <button data-k="estop" type="button" title="모터 즉시 정지 (ESC)"
        class="h-[30px] flex-none px-[15px] bg-alert/12 border border-alert/45 rounded-[3px] text-alert2 text-[12px] font-semibold cursor-pointer hover:bg-alert/22 hover:text-[#FFB3B3]">비상 정지</button>

      <div class="${RULE}"></div>
      <!-- Last, because it is the only control here that changes the shape of
           the window rather than the state of the aircraft. -->
      <button data-k="fullscreen" type="button" title="전체 화면 (F)"
        class="flex flex-none items-center justify-center w-[26px] h-[26px] bg-raised border border-line3 rounded-[3px] text-dim cursor-pointer hover:bg-[#1C222A] hover:border-line4 hover:text-ink2">
        <svg aria-hidden="true" viewBox="0 0 16 16" class="w-[13px] h-[13px] fill-none stroke-current stroke-[1.25]">
          <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4"></path>
        </svg>
      </button>
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
          <!-- The hatch is the connection screen now. There is no separate one
               to return to, so what used to be a static caption carries the
               supervisor's state and, when it failed, the reason. -->
          <div data-k="hatch-label" class="absolute inset-0 flex flex-col items-center justify-center gap-[9px] px-[24px]">
            <div data-k="hatch-state" class="font-mono text-[11px] tracking-[.2em] text-[#5A646F]">영상 대기</div>
            <div data-k="hatch-detail" class="max-w-[520px] text-center font-mono text-[10.5px] leading-[1.6] text-[#373F49]"></div>
          </div>
          <canvas id="video" width="960" height="720" class="absolute inset-0"></canvas>
          <!-- Battery and flight time used to sit here, in their own box in the
               picture's bottom-left. They now ride the stage overlay's own top
               bar, which is still ON the picture and still inside the rectangle
               a pilot watches while flying - a reading two feet from where the
               eyes are is a reading nobody takes in time. This mount stays
               pointer-events-none, so nothing the overlay draws can eat a click
               meant for the stage. -->
          <div data-k="m-overlay" class="absolute inset-0 pointer-events-none"></div>
        </div>
        <div data-k="m-console" class="flex-none border-t border-line bg-sunken flex flex-col"></div>
      </div>

      <div data-k="right" class="flex-1 basis-0 min-w-[300px] min-h-0 overflow-hidden flex flex-col bg-panel border-l border-line">
        <div data-k="m-copilot" class="flex-1 min-h-0 flex flex-col"></div>
        <div data-k="m-timeline" class="flex-none border-t border-line2 flex flex-col"></div>
      </div>
    </div>

    <!-- One strip, one subject: everything here measures the pipeline that
         carries the picture, left to right in the order the bytes travel -
         off the wire, through the IPC hop, through the decoder, onto the
         canvas. Nothing about the aircraft belongs here.

         Every cell is flex-none and nowrap. A flex item's default
         min-width:auto still lets its TEXT wrap once the item is squeezed, so
         "RX -- pkt/s" broke into two lines inside a 26 px strip and pushed the
         numbers out of the window. Nothing here may reflow: the strip is a fixed
         row of readings, and the window has a minimum width that fits all of
         them (see tauri.conf.json). Hidden overflow is the backstop for a
         browser tab, which has no such minimum. -->
    <div class="h-[26px] flex-none border-t border-line bg-[#0D1014] flex items-center overflow-hidden px-[14px] gap-[16px] font-mono text-[10.5px] text-dim2 whitespace-nowrap">
      <div data-k="status" class="flex-none text-dim">idle</div>
      <div class="flex-1 min-w-[8px]"></div>
      <div class="flex-none">RX <span data-k="rx">--</span> pkt/s</div>
      <div class="flex-none"><span data-k="mbps">--</span> Mb/s</div>
      <div class="flex-none">GAP <span data-k="gap">--</span> ms</div>
      <div class="flex-none">IPC <span data-k="ipc">--</span> ms</div>
      <div class="flex-none">DEC <span data-k="dec">--</span> ms</div>
      <div class="flex-none">PAINT <span data-k="rtt">--</span> ms</div>
      <div class="flex-none"><span data-k="fps">--</span> fps</div>
      <div class="flex-none">DROP <span data-k="drop">--</span></div>
      <div data-k="link" class="flex-none text-dim2">LINK IDLE</div>
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
    nodeDot: q("node-dot", HTMLDivElement),
    nodeCopy: q("node-copy", HTMLDivElement),
    droneDot: q("drone-dot", HTMLDivElement),
    droneCopy: q("drone-copy", HTMLDivElement),
    update: q("update", HTMLDivElement),
    updateVersion: q("update-version", HTMLSpanElement),
    updateApply: q("update-apply", HTMLButtonElement),
    hatchState: q("hatch-state", HTMLDivElement),
    hatchDetail: q("hatch-detail", HTMLDivElement),
    rtt: q("rtt", HTMLSpanElement),
    takeoff: q("takeoff", HTMLButtonElement),
    land: q("land", HTMLButtonElement),
    status: q("status", HTMLDivElement),
    rx: q("rx", HTMLSpanElement),
    fps: q("fps", HTMLSpanElement),
    mbps: q("mbps", HTMLSpanElement),
    gap: q("gap", HTMLSpanElement),
    ipc: q("ipc", HTMLSpanElement),
    dec: q("dec", HTMLSpanElement),
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

  cell.updateApply.addEventListener("click", deps.onUpdate);
  q("estop", HTMLButtonElement).addEventListener("click", deps.onEmergency);
  cell.takeoff.addEventListener("click", deps.onTakeoff);
  cell.land.addEventListener("click", deps.onLand);

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
      // Neither command means anything without a link, and a button that looks
      // pressable when it is not is the panel making a promise for the drone.
      cell.takeoff.disabled = !m.live;
      cell.land.disabled = !m.live;

      // Each chip answers its own question; the hatch keeps the headline about
      // the picture, which is the thing neither chip is about.
      const node = NODE_COPY[m.link.node];
      text(cell.nodeCopy, node.copy);
      cell.nodeDot.className = `${HEADER_DOT} ${node.dot}`;
      const drone = peerCopy(m.link.drone);
      text(cell.droneCopy, drone.copy);
      cell.droneDot.className = `${HEADER_DOT} ${drone.dot}`;
      text(cell.hatchState, PHASE_COPY[m.link.phase]);
      text(cell.hatchDetail, m.link.detail);

      cell.update.hidden = m.update === null;
      if (m.update !== null) {
        text(cell.updateVersion, m.update.version);
        cell.updateApply.disabled = m.update.applying;
        text(cell.updateApply, m.update.applying ? "설치 중" : "설치");
        if (m.update.error !== null) cell.updateApply.title = m.update.error;
      }

      text(cell.status, known(m.status));
      const rx = finite(m.rxPktsPerSec);
      const mbps = finite(m.mbps);
      const gap = finite(m.gapMaxMs);
      const ipc = finite(m.ipcMs);
      const dec = finite(m.decodeMs);
      const receiveToPaint = finite(m.rttMs);
      const fps = finite(m.fps);
      const dropped = finite(m.dropped);
      text(cell.rx, rx === null ? MISSING : String(rx));
      text(cell.mbps, mbps === null ? MISSING : mbps.toFixed(2));
      text(cell.gap, gap === null ? MISSING : String(gap));
      text(cell.ipc, ipc === null ? MISSING : ipc.toFixed(1));
      text(cell.dec, dec === null ? MISSING : dec.toFixed(1));
      text(cell.rtt, receiveToPaint === null ? MISSING : receiveToPaint.toFixed(1));
      text(cell.fps, fps === null || fps <= 0 ? MISSING : String(Math.round(fps)));
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
