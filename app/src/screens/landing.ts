/**
 * The connect screen.
 *
 * The prototype this is ported from enumerates serial ports and asks you to pick
 * one. This app has no serial link - the drone is four UDP sockets away, pinned
 * by the cable and the ESP32's soft-AP, with nothing to choose. So the picker is
 * replaced by the one interactive thing that is actually true here: a preflight
 * that binds each socket and asks the drone to answer, and reports what happened.
 *
 * That is worth more than a picker. Every failure this app has is at one of
 * three places - a port another copy of the app already holds, a drone that is
 * not on the bridge, or a state stream that never starts - and the probe names
 * which one before a session is opened rather than after it hangs.
 */
import type { Endpoints, Probe } from "../transport.ts";
import { must, style, text } from "../ui.ts";

export type LandingModel = {
  endpoints: Endpoints | null;
  probing: boolean;
  /** null until the first probe run - which is a different state from "ran and
   *  found nothing", and the screen says so. */
  probes: Probe[] | null;
  connecting: boolean;
  hint: string;
  /** Set once GitHub has been asked; the row is silent until then, and stays
   *  silent when this build is current. */
  update: UpdateModel | null;
};

export interface Landing {
  update(m: LandingModel): void;
  log(line: string): void;
  clearLog(): void;
}

/** What the landing screen says about a newer build, and what it may do about
 *  it. `applying` is one-way: the app is about to be replaced and restarted. */
export type UpdateModel = {
  version: string;
  applying: boolean;
  error: string | null;
};

const CARD = "bg-raised border border-line3 rounded-[4px]";
const LABEL = "font-mono text-[11px] tracking-[.16em] text-dim";
const ROW = "flex items-center justify-between";

/** Short mono tags for the probe tiles, in the order Rust runs them. */
const TAGS: Record<string, string> = { command: "CMD", state: "ST", video: "VID" };

export function installLanding(
  mount: HTMLElement,
  deps: { onProbe: () => void; onConnect: () => void; onUpdate: () => void },
): Landing {
  mount.innerHTML = `
    <div class="flex-1 min-h-0 overflow-hidden flex items-center justify-center px-[48px] py-[40px]"
      style="background:radial-gradient(1100px 720px at 50% -5%, #151A21 0%, #0B0D10 62%)">
      <div class="w-full max-w-[980px] max-h-full min-h-0 flex flex-col gap-[24px]">
        <div class="flex-none flex items-end justify-between gap-[24px]">
          <div class="flex flex-col gap-[11px]">
            <div class="flex items-center gap-[10px]">
              <div class="w-[9px] h-[9px] bg-accent rounded-[2px]"></div>
              <div class="font-mono text-[11px] tracking-[.22em] text-dim">AIDRONE STATION</div>
            </div>
            <div class="text-[30px] font-semibold tracking-[-.02em]">수신기 노드 연결</div>
            <div class="text-dim text-[13.5px] leading-[1.65]">
              ESP32-S3 수신기 노드의 UDP 링크를 점검합니다.<br>
              명령·상태·영상 소켓을 열어 Tello 응답을 직접 확인합니다.
            </div>
          </div>
          <div class="font-mono text-[11px] text-dim2 text-right leading-[1.95]">
            <div>NODE&nbsp;&nbsp;&nbsp;<span data-k="h-node">--</span></div>
            <div>TELLO&nbsp;&nbsp;<span data-k="h-tello">--</span></div>
            <div>SDK&nbsp;&nbsp;&nbsp;&nbsp;Tello 2.0</div>
          </div>
        </div>

        <div class="grid grid-cols-[1.35fr_1fr] gap-[20px] items-stretch flex-1 min-h-[320px] max-h-[560px] overflow-hidden">
          <div class="${CARD} flex flex-col min-h-0 overflow-hidden">
            <div class="h-[46px] flex-none px-[16px] flex items-center justify-between border-b border-line3">
              <div class="${LABEL}">UDP PREFLIGHT</div>
              <button data-k="probe" type="button"
                class="h-[28px] px-[13px] bg-btn border border-line4 rounded-[3px] text-ink text-[12px] font-medium cursor-pointer flex items-center gap-[8px] hover:bg-[#28303A] hover:border-[#3E4854] disabled:opacity-40 disabled:cursor-default">
                <div class="w-[6px] h-[6px] rounded-full bg-accent"></div>링크 검사
              </button>
            </div>

            <div data-k="probing" class="flex-1 flex-col items-center justify-center gap-[15px]" style="display:none">
              <div class="w-[26px] h-[26px] border-2 border-line3 border-t-accent rounded-full animate-spin-slow"></div>
              <div class="font-mono text-[11.5px] text-dim">검사 중 · UDP 소켓과 드론 응답</div>
            </div>

            <div data-k="empty" class="flex-1 flex-col items-center justify-center gap-[11px] text-center p-[30px]">
              <div class="w-[34px] h-[34px] border border-dashed border-line4 rounded-[4px]"></div>
              <div class="text-dim text-[12.5px]">아직 검사하지 않았습니다.</div>
              <div class="text-dim2 text-[11.5px]">링크 검사를 누르면 세 소켓을 열어보고 드론에게 직접 물어봅니다.</div>
            </div>

            <div data-k="probes" class="flex-1 basis-0 min-h-0 overflow-y-auto overflow-x-hidden p-[8px] flex-col" style="display:none"></div>
          </div>

          <div class="flex flex-col gap-[16px] min-h-0">
            <div class="${CARD} flex-none overflow-y-auto p-[16px] flex flex-col gap-[13px]">
              <div class="${LABEL}">LINK SETTINGS</div>
              <div class="flex flex-col gap-[9px]">
                <div class="${ROW}">
                  <div class="text-dim text-[12.5px]">Node</div>
                  <div data-k="e-node" class="font-mono text-[12.5px]">--</div>
                </div>
                <div class="h-px bg-[#20252D]"></div>
                <div class="${ROW}">
                  <div class="text-dim text-[12.5px]">Command</div>
                  <div data-k="e-tello" class="font-mono text-[12.5px]">--</div>
                </div>
                <div class="h-px bg-[#20252D]"></div>
                <div class="${ROW}">
                  <div class="text-dim text-[12.5px]">State</div>
                  <div data-k="e-state" class="font-mono text-[12.5px]">--</div>
                </div>
                <div class="h-px bg-[#20252D]"></div>
                <div class="${ROW}">
                  <div class="text-dim text-[12.5px]">Video</div>
                  <div data-k="e-video" class="font-mono text-[12.5px]">--</div>
                </div>
              </div>
              <button data-k="connect" type="button"
                class="h-[40px] mt-[3px] bg-accent border-none rounded-[3px] text-[#08131A] text-[13.5px] font-semibold cursor-pointer hover:bg-accent2 disabled:opacity-50 disabled:cursor-default">연결하고 시작</button>
              <div data-k="hint" class="text-[11.5px] text-dim2 text-center"></div>
              <div data-k="update" class="flex-none flex items-center justify-between gap-[10px] px-[12px] h-[38px] bg-accent/10 border border-accent/40 rounded-[3px]" style="display:none">
                <div class="font-mono text-[11.5px] text-accent2" data-k="update-text">새 버전</div>
                <button data-k="update-apply" type="button"
                  class="h-[26px] px-[11px] bg-accent border-none rounded-[3px] text-[#08131A] text-[11.5px] font-semibold cursor-pointer hover:bg-accent2 disabled:opacity-50 disabled:cursor-default">업데이트</button>
              </div>
            </div>

            <div data-k="boot" class="flex-1 basis-0 min-h-[88px] bg-sunken border border-[#1F242B] rounded-[4px] px-[14px] py-[13px] overflow-y-auto font-mono text-[11px] leading-[1.9] text-[#7C848F]"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const q = <T extends Element>(k: string, ctor: new () => T) => must(`[data-k="${k}"]`, ctor, mount);

  const probeBtn = q("probe", HTMLButtonElement);
  const connectBtn = q("connect", HTMLButtonElement);
  const probing = q("probing", HTMLDivElement);
  const empty = q("empty", HTMLDivElement);
  const probes = q("probes", HTMLDivElement);
  const boot = q("boot", HTMLDivElement);
  const hint = q("hint", HTMLDivElement);
  const updateRow = q("update", HTMLDivElement);
  const updateText = q("update-text", HTMLDivElement);
  const updateBtn = q("update-apply", HTMLButtonElement);
  const ends = {
    tello: q("e-tello", HTMLDivElement),
    state: q("e-state", HTMLDivElement),
    video: q("e-video", HTMLDivElement),
    node: q("e-node", HTMLDivElement),
    hNode: q("h-node", HTMLSpanElement),
    hTello: q("h-tello", HTMLSpanElement),
  };

  probeBtn.addEventListener("click", deps.onProbe);
  connectBtn.addEventListener("click", deps.onConnect);
  updateBtn.addEventListener("click", deps.onUpdate);

  /** Rendered from scratch on each probe run - three rows, once every few
   *  seconds, so diffing them would cost more than it saves. */
  function paintProbes(list: Probe[]): void {
    probes.replaceChildren();
    if (list.length === 0) {
      const unavailable = document.createElement("div");
      unavailable.className = "flex-1 flex items-center justify-center px-[30px] text-center text-[11.5px] text-dim2";
      unavailable.textContent = "검사 결과를 받지 못했습니다.";
      probes.append(unavailable);
      return;
    }

    for (const p of list) {
      const row = document.createElement("div");
      row.className = "relative flex-none px-[13px] py-[13px] rounded-[3px] flex items-center gap-[13px]";

      const tile = document.createElement("div");
      tile.className = `w-[28px] h-[28px] flex-none rounded-[3px] bg-btn border ${p.ok ? "border-ok/50" : "border-line4"} flex items-center justify-center font-mono text-[9.5px] ${p.ok ? "text-ok" : "text-dim"}`;
      tile.textContent = TAGS[p.id] ?? p.id.slice(0, 3).toUpperCase();

      const mid = document.createElement("div");
      mid.className = "flex-1 min-w-0 flex flex-col gap-[3px]";
      const title = document.createElement("div");
      title.className = "text-[12.5px] text-ink truncate";
      title.textContent = p.label;
      const sub = document.createElement("div");
      sub.className = "font-mono text-[11px] text-dim truncate";
      sub.textContent = p.detail;
      mid.append(title, sub);

      const verdict = document.createElement("div");
      verdict.className = `font-mono text-[10.5px] ${p.ok ? "text-ok" : "text-alert2"}`;
      verdict.textContent = p.ok ? "정상" : "실패";

      row.append(tile, mid, verdict);
      if (p.ok) {
        const glow = document.createElement("div");
        glow.className = "absolute inset-0 border border-ok/40 rounded-[3px] bg-ok/6 pointer-events-none";
        row.append(glow);
      }
      probes.append(row);
    }
  }

  return {
    update(m: LandingModel): void {
      const endpoints = m.endpoints;
      text(ends.tello, endpoints?.tello ?? "--");
      text(ends.state, endpoints?.state ?? "--");
      text(ends.video, endpoints?.video ?? "--");
      text(ends.node, endpoints?.node ?? "--");
      text(ends.hNode, endpoints?.node ?? "--");
      text(ends.hTello, endpoints?.tello ?? "--");

      style(probing, "display", m.probing ? "flex" : "none");
      style(empty, "display", !m.probing && m.probes === null ? "flex" : "none");
      style(probes, "display", !m.probing && m.probes !== null ? "flex" : "none");
      if (!m.probing && m.probes !== null) paintProbes(m.probes);

      probeBtn.disabled = m.probing || m.connecting;
      connectBtn.disabled = m.probing || m.connecting;
      text(connectBtn, m.connecting ? "연결 중…" : "연결하고 시작");
      text(hint, m.hint);

      const available = m.update;
      style(updateRow, "display", available === null ? "none" : "flex");
      if (available !== null) {
        text(
          updateText,
          available.error !== null
            ? `업데이트 실패 · ${available.error}`
            : available.applying
              ? `${available.version} 내려받는 중 · 설치 후 재시작합니다`
              : `새 버전 ${available.version}`,
        );
        updateText.className =
          available.error !== null
            ? "font-mono text-[11.5px] text-alert2"
            : "font-mono text-[11.5px] text-accent2";
        // A session replaces the whole binary, so it may only start from an
        // idle screen - never while a probe or a connect is in flight.
        updateBtn.disabled = available.applying || m.probing || m.connecting;
        text(updateBtn, available.applying ? "설치 중…" : "업데이트");
      }
    },

    log(line: string): void {
      const el = document.createElement("div");
      el.textContent = line;
      boot.append(el);
      // Bounded: a connect that retries the stream handshake writes a line per
      // attempt, and this box outlives every one of them.
      while (boot.childElementCount > 200) boot.firstElementChild?.remove();
      boot.scrollTop = boot.scrollHeight;
    },

    clearLog(): void {
      boot.replaceChildren();
    },
  };
}
