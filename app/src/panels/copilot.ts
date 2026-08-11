/**
 * The copilot panel: type a task, watch it fly.
 *
 * Everything is one conversation - your message, what it thought, what it did,
 * then what it says about it - in the order those happened. That ordering is
 * the whole design. A turn alternates between reasoning and tool calls, and a
 * view that shows only the surviving state ("here are the four calls") throws
 * away the part that explains them.
 *
 * So the activity block is append-only: each burst of reasoning opens a box,
 * the calls that follow land under it, and the next burst opens a new box
 * beneath those. When the task ends every box collapses to its first line,
 * because by then the answer is the interesting thing and the working is not.
 *
 * The connected provider is silent while it thinks and then writes quickly, so
 * without this the panel would learn everything at once, at the end - and a
 * drone is airborne for the whole wait.
 */
import type { AgentActivity, AgentStep } from "../copilot/agent.ts";
import { dictateReady, dictateStart, dictateStop, type TurnNotice } from "../transport.ts";
import { cls, must, text } from "../ui.ts";

export interface CopilotRun {
  /** Resolves when the task ends, however it ends. */
  readonly done: Promise<{ summary: string }>;
  cancel(): void;
}

export interface CopilotHooks {
  onStep: (step: AgentStep) => void;
  onActivity: (activity: AgentActivity) => void;
  /** Live progress from the transport while a reply is still being written. */
  onNotice: (notice: TurnNotice) => void;
}

export interface CopilotDeps {
  run?: (instruction: string, hooks: CopilotHooks) => CopilotRun;
  /** True once a session exists; without one there is nothing to fly. */
  ready?: () => boolean;
}

export interface CopilotPanel {
  /** Cancels any task in flight - the emergency stop calls this. */
  abort(): void;
  dispose(): void;
}

const STEP_TONE: Record<AgentStep["state"], { dot: string; text: string }> = {
  running: { dot: "bg-accent animate-beat-fast", text: "text-ink2" },
  ok: { dot: "bg-ok", text: "text-dim" },
  failed: { dot: "bg-alert", text: "text-alert2" },
  cancelled: { dot: "bg-dim3", text: "text-dim2" },
};

const SEND_IDLE =
  "h-[38px] rounded-[3px] bg-accent px-[16px] text-[12.5px] font-semibold text-[#08131A] hover:bg-accent2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const SEND_BUSY =
  "h-[38px] rounded-[3px] bg-alert px-[16px] text-[12.5px] font-semibold text-[#1A0A0A] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const ROW = "flex items-baseline gap-[8px] py-[2px]";

const MIC_OFF =
  "flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[3px] border border-line3 bg-key text-dim2 cursor-not-allowed opacity-60";
const MIC_IDLE =
  "flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[3px] border border-line3 bg-key text-dim cursor-pointer hover:border-line4 hover:text-ink2";
const MIC_LIVE =
  "flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[3px] border-0 bg-alert text-[#1A0A0A] cursor-pointer animate-beat-fast";
const DOT = "mt-[5px] h-[5px] w-[5px] flex-none rounded-full";
const CHIP = "rounded-[2px] border border-line3 bg-key px-[5px] py-[1px] font-mono text-[9px] text-dim2";

/** A burst of reasoning: header always visible, body foldable. */
type Thought = {
  root: HTMLDivElement;
  head: HTMLButtonElement;
  caret: HTMLSpanElement;
  title: HTMLSpanElement;
  body: HTMLDivElement;
  text: string;
};

/** The answer bubble: text, its tool chips, and the folded working beneath. */
type Reply = {
  bubble: HTMLButtonElement;
  text: HTMLSpanElement;
  chips: HTMLSpanElement;
  detail: HTMLDivElement;
};

export function installCopilot(mount: HTMLElement, deps: CopilotDeps = {}): CopilotPanel {
  mount.innerHTML = `
    <section class="flex h-full min-h-0 flex-col bg-panel" aria-labelledby="copilot-heading">
      <header class="flex h-[46px] flex-none items-center justify-between border-b border-line2 px-[15px]">
        <div class="flex items-center gap-[9px]">
          <div data-k="copilot-dot" aria-hidden="true" class="h-[6px] w-[6px] rounded-full bg-dim3"></div>
          <div id="copilot-heading" class="font-mono text-[10.5px] tracking-[.16em] text-dim">LLM COPILOT</div>
        </div>
        <div data-k="copilot-status" class="font-mono text-[10px] text-dim2">대기</div>
      </header>

      <div data-k="copilot-chat" role="log" aria-live="polite" aria-relevant="additions text" aria-label="코파일럿 대화" class="flex min-h-0 flex-1 flex-col gap-[11px] overflow-y-auto px-[15px] py-[14px]"></div>

      <div class="flex flex-none items-center gap-[8px] px-[15px] pb-[13px]">
        <button type="button" data-k="copilot-mic" aria-label="음성 입력" class="${MIC_OFF}">
          <span aria-hidden="true" class="relative h-[13px] w-[8px] rounded-[4px] bg-current before:absolute before:left-1/2 before:top-[11px] before:h-[5px] before:w-px before:-translate-x-1/2 before:bg-current after:absolute after:left-1/2 after:top-[15px] after:h-px after:w-[12px] after:-translate-x-1/2 after:bg-current"></span>
        </button>
        <div class="flex h-[38px] flex-1 items-center rounded-[3px] border border-[#232A33] bg-tile px-[12px]">
          <input data-k="copilot-input" autocomplete="off" placeholder="예: 이륙해서 한 바퀴 돌면서 마커 찾고 있으면 따라가" aria-label="코파일럿 지시" class="h-full min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-dim2" />
        </div>
        <button type="button" data-k="copilot-send" class="${SEND_IDLE}">전송</button>
      </div>
    </section>
  `;

  const dot = must('[data-k="copilot-dot"]', HTMLDivElement, mount);
  const status = must('[data-k="copilot-status"]', HTMLDivElement, mount);
  const chat = must('[data-k="copilot-chat"]', HTMLDivElement, mount);
  const input = must('[data-k="copilot-input"]', HTMLInputElement, mount);
  const send = must('[data-k="copilot-send"]', HTMLButtonElement, mount);
  const mic = must('[data-k="copilot-mic"]', HTMLButtonElement, mount);

  let active: CopilotRun | null = null;
  let activityBlock: HTMLDivElement | null = null;
  const rows = new Map<number, { dot: HTMLDivElement; label: HTMLDivElement; detail: HTMLDivElement }>();

  /** Every thought box of the task in flight, so they can all be folded at the end. */
  let thoughts: Thought[] = [];
  /** The one still being written to; null once a call has interrupted it. */
  let openThought: Thought | null = null;
  /** Tool names in the order the loop actually executed them - for the chips. */
  let called: string[] = [];

  let pendingRow: { root: HTMLDivElement; dot: HTMLDivElement; label: HTMLDivElement; clock: HTMLDivElement } | null = null;
  let pendingSince = 0;
  let pendingLabel = "";
  let ticker: number | null = null;
  /** The answer of the task in flight, created when its text starts arriving. */
  let reply: Reply | null = null;
  let summarySoFar = "";

  const atBottom = (): boolean => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  const follow = (wasAtBottom: boolean): void => {
    if (wasAtBottom) chat.scrollTop = chat.scrollHeight;
  };

  const appendUser = (content: string): void => {
    const stick = atBottom();
    const row = document.createElement("div");
    row.className = "flex justify-end";
    const bubble = document.createElement("div");
    bubble.className =
      "max-w-[82%] rounded-[3px] border border-[rgba(91,200,245,.32)] bg-[rgba(91,200,245,.14)] px-[12px] py-[9px] text-[12.5px] leading-[1.6] text-[#DCEFFA]";
    bubble.textContent = content;
    row.append(bubble);
    chat.append(row);
    follow(stick);
  };

  /**
   * The answer. Its chips live inside it, and the whole working - every
   * thought box and every tool row - is folded away underneath, revealed by
   * clicking the answer. The transcript is worth keeping and worth hiding: it
   * is how a flight is reconstructed afterwards, and it is not what anyone
   * wants filling the panel once the drone has finished doing the thing.
   */
  const openReply = (): Reply => {
    const stick = atBottom();
    const row = document.createElement("div");
    row.className = "flex w-full flex-col items-start gap-[4px]";
    row.innerHTML = `
      <button type="button" data-k="bubble" class="max-w-[82%] cursor-default rounded-[3px] border border-[#212832] bg-tile px-[12px] py-[9px] text-left">
        <span data-k="text" class="block whitespace-pre-wrap text-[12.5px] leading-[1.6] text-dim"></span>
        <span data-k="chips" class="mt-[6px] flex flex-wrap items-center gap-[4px]" hidden></span>
      </button>
      <div data-k="detail" class="w-full" hidden></div>`;
    chat.append(row);
    follow(stick);
    return {
      bubble: must("[data-k=bubble]", HTMLButtonElement, row),
      text: must("[data-k=text]", HTMLSpanElement, row),
      chips: must("[data-k=chips]", HTMLSpanElement, row),
      detail: must("[data-k=detail]", HTMLDivElement, row),
    };
  };

  const openActivity = (): HTMLDivElement => {
    const block = document.createElement("div");
    block.className =
      "flex flex-col rounded-[3px] border border-[#1C232C] border-l-2 border-l-accent/50 bg-sunken px-[11px] py-[8px] font-mono";
    chat.append(block);
    return block;
  };

  const stopTicker = (): void => {
    if (ticker === null) return;
    window.clearInterval(ticker);
    ticker = null;
  };

  const paintClock = (): void => {
    if (pendingRow === null) return;
    const seconds = Math.floor((Date.now() - pendingSince) / 1000);
    text(pendingRow.clock, `${seconds}초`);
    text(status, `${pendingLabel} ${seconds}초`);
  };

  /** Folds a thought to its first line. Clicking the header opens it again. */
  const foldThought = (thought: Thought, folded: boolean): void => {
    thought.body.hidden = folded;
    text(thought.caret, folded ? "▸" : "▾");
  };

  /**
   * A new box per burst, never a reused one. Reasoning that resumes after a
   * tool call is a different thought about a changed world, and merging the
   * two would put the model's reaction to a result above the result itself.
   */
  const openThoughtBox = (): Thought => {
    const root = document.createElement("div");
    root.className = "my-[3px] rounded-[2px] border border-line2 bg-key/40";
    root.innerHTML = `
      <button type="button" data-k="head" class="flex w-full items-baseline gap-[6px] px-[7px] py-[4px] text-left cursor-pointer hover:bg-btn/40">
        <span data-k="caret" class="flex-none text-[9px] text-dim3">▾</span>
        <span class="flex-none text-[9.5px] tracking-[.12em] text-dim2">THINKING</span>
        <span data-k="title" class="min-w-0 flex-1 truncate text-[10px] text-dim3"></span>
      </button>
      <div data-k="body" class="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words px-[9px] pb-[6px] text-[10px] leading-[1.55] text-dim3"></div>`;
    const thought: Thought = {
      root,
      head: must("[data-k=head]", HTMLButtonElement, root),
      caret: must("[data-k=caret]", HTMLSpanElement, root),
      title: must("[data-k=title]", HTMLSpanElement, root),
      body: must("[data-k=body]", HTMLDivElement, root),
      text: "",
    };
    // The provider sends no title for a reasoning block - the delta carries
    // only `reasoning_content` - so the fold shows its opening clause, which
    // is the closest honest thing to a heading.
    thought.head.addEventListener("click", () => foldThought(thought, !thought.body.hidden));
    activityBlock?.append(thought.root);
    thoughts.push(thought);
    return thought;
  };

  /**
   * Ends the current burst and folds it immediately. A finished thought is
   * reference material; leaving it open pushes the thing that is actually
   * happening off the bottom of the panel.
   */
  const closeThought = (): void => {
    if (openThought !== null) foldThought(openThought, true);
    openThought = null;
  };

  const showPending = (label: string, tone: string): void => {
    const stick = atBottom();
    if (activityBlock === null) return;
    if (pendingRow === null) {
      const root = document.createElement("div");
      root.className = ROW;
      root.innerHTML = `
        <div data-k="dot" class="${DOT}"></div>
        <div data-k="label" class="flex-none text-[11px] text-accent2"></div>
        <div data-k="clock" class="min-w-0 flex-1 text-[10px] text-dim2"></div>`;
      pendingRow = {
        root,
        dot: must("[data-k=dot]", HTMLDivElement, root),
        label: must("[data-k=label]", HTMLDivElement, root),
        clock: must("[data-k=clock]", HTMLDivElement, root),
      };
    }
    if (pendingLabel !== label) {
      pendingLabel = label;
      pendingSince = Date.now();
    }
    cls(pendingRow.dot, `${DOT} ${tone}`);
    text(pendingRow.label, label);
    activityBlock.append(pendingRow.root); // always last
    paintClock();
    if (ticker === null) ticker = window.setInterval(paintClock, 1000);
    follow(stick);
  };

  const hidePending = (): void => {
    stopTicker();
    pendingRow?.root.remove();
    pendingRow = null;
    pendingLabel = "";
  };

  const paintStep = (step: AgentStep): void => {
    if (activityBlock === null) return;
    const stick = atBottom();
    // A settled call ends the reasoning that produced it.
    closeThought();
    let row = rows.get(step.index);
    if (row === undefined) {
      const line = document.createElement("div");
      line.className = ROW;
      line.innerHTML = `
        <div data-k="dot" class="${DOT}"></div>
        <div data-k="label" class="flex-none text-[11px]"></div>
        <div data-k="detail" class="min-w-0 flex-1 truncate text-[10px] text-dim2"></div>`;
      row = {
        dot: must("[data-k=dot]", HTMLDivElement, line),
        label: must("[data-k=label]", HTMLDivElement, line),
        detail: must("[data-k=detail]", HTMLDivElement, line),
      };
      rows.set(step.index, row);
      activityBlock.append(line);
      if (pendingRow !== null) activityBlock.append(pendingRow.root);
    }
    if (step.state === "ok" && step.call !== null && step.call.tool !== "done") called.push(step.call.tool);
    const tone = STEP_TONE[step.state];
    cls(row.dot, `${DOT} ${tone.dot}`);
    cls(row.label, `flex-none text-[11px] ${tone.text}`);
    text(row.label, step.label);
    text(row.detail, step.detail ?? "");
    follow(stick);
  };

  const paintActivity = (activity: AgentActivity): void => {
    switch (activity.kind) {
      case "thinking":
        showPending(activity.attempt === 1 ? "생각 중" : `다시 요청 중 ${activity.attempt}/${activity.of}`, "bg-accent animate-beat-fast");
        return;
      case "waiting":
        showPending("잠시 후 재시도", "bg-dim animate-beat");
        return;
      case "running":
        hidePending();
        text(status, "실행 중");
    }
  };

  const setBusy = (busy: boolean): void => {
    if (!busy) hidePending();
    cls(dot, `h-[6px] w-[6px] rounded-full ${busy ? "bg-accent animate-beat-fast" : "bg-dim3"}`);
    if (!busy) text(status, "대기");
    text(send, busy ? "중단" : "전송");
    cls(send, busy ? SEND_BUSY : SEND_IDLE);
    input.disabled = busy;
  };

  const paintNotice = (notice: TurnNotice): void => {
    switch (notice.kind) {
      case "waiting":
        pendingLabel = "";
        showPending("쿼터 대기", "bg-alert animate-beat");
        if (pendingRow !== null) text(pendingRow.clock, `약 ${Math.ceil(notice.seconds)}초 남음`);
        return;
      case "thinking": {
        const stick = atBottom();
        openThought ??= openThoughtBox();
        openThought.text += notice.chunk;
        text(openThought.body, openThought.text.trimStart());
        // First clause as the fold's heading; there is no API-supplied title.
        text(openThought.title, openThought.text.replace(/\s+/g, " ").trim().slice(0, 90));
        // The box is short and the reasoning is long, so without this the
        // operator watches the first sentence while the model writes the
        // twentieth.
        openThought.body.scrollTop = openThought.body.scrollHeight;
        if (pendingRow !== null) activityBlock?.append(pendingRow.root);
        follow(stick);
        return;
      }
      case "calling":
        // The model has stopped reasoning and started acting.
        closeThought();
        summarySoFar = "";
        showPending(notice.name === "done" ? "정리 중" : `${notice.name} 준비 중`, "bg-accent animate-beat-fast");
        return;
      case "summary": {
        summarySoFar += notice.chunk;
        // Fragments are raw JSON on the way to `{"summary": "..."}`, so only
        // the part inside the quotes is an answer worth showing as it grows.
        const opened = summarySoFar.indexOf('"summary"');
        const quote = opened < 0 ? -1 : summarySoFar.indexOf('"', summarySoFar.indexOf(":", opened) + 1);
        if (quote < 0) return;
        const shown = summarySoFar.slice(quote + 1).replace(/"[^"]*$/, "");
        if (shown === "") return;
        const target = (reply ??= openReply());
        text(target.text, shown.replace(/\\n/g, "\n").replace(/\\"/g, '"'));
        follow(atBottom());
        return;
      }
      case "model":
        if (notice.fellBack) text(status, `폴백 · ${notice.model}`);
    }
  };

  const start = (instruction: string): void => {
    const runner = deps.run;
    if (runner === undefined) {
      text(openReply().text, "실행기가 연결되지 않았습니다.");
      return;
    }
    if (deps.ready?.() === false) {
      text(openReply().text, "세션이 없습니다. 먼저 드론에 연결하세요.");
      return;
    }

    appendUser(instruction);
    rows.clear();
    thoughts = [];
    called = [];
    openThought = null;
    reply = null;
    summarySoFar = "";
    activityBlock = openActivity();
    setBusy(true);
    // Something has to be on screen before the first round trip returns, or
    // the panel looks identical to one that ignored the button.
    showPending("생각 중", "bg-accent animate-beat-fast");

    const block = activityBlock;
    const boxes = thoughts;
    /**
     * The streamed preview is overwritten, never appended to: the loop's
     * summary is the decoded one, and a half-parsed fragment left beside it
     * would be two versions of the same sentence. The chips come from the
     * steps that actually ran, not from what the model announced.
     */
    const settleReply = (content: string): void => {
      const target = (reply ??= openReply());
      text(target.text, content);
      for (const tool of called) {
        const chip = document.createElement("span");
        chip.className = CHIP;
        chip.textContent = tool;
        target.chips.append(chip);
      }
      target.chips.hidden = called.length === 0;
      for (const thought of boxes) foldThought(thought, true);

      // The working moves inside the answer and disappears. Clicking the
      // answer brings it back, which is the only way to audit a flight after
      // the fact without keeping it on screen for every flight.
      if (block.childElementCount > 0) {
        target.detail.append(block);
        target.detail.hidden = true;
        cls(
          target.bubble,
          "max-w-[82%] cursor-pointer rounded-[3px] border border-[#212832] bg-tile px-[12px] py-[9px] text-left hover:border-line4",
        );
        target.bubble.title = "실행 과정 보기";
        target.bubble.addEventListener("click", () => {
          target.detail.hidden = !target.detail.hidden;
          follow(true);
        });
      }
      follow(true);
    };

    const run = runner(instruction, { onStep: paintStep, onActivity: paintActivity, onNotice: paintNotice });
    active = run;
    void run.done
      .then((outcome) => {
        settleReply(outcome.summary);
      })
      .catch((err: unknown) => {
        settleReply(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        active = null;
        reply = null;
        setBusy(false);
        // A task that never got a single call leaves an empty frame behind.
        if (block.childElementCount === 0) block.remove();
        activityBlock = null;
      });
  };

  const onSend = (): void => {
    if (active !== null) {
      active.cancel();
      return;
    }
    const instruction = input.value.trim();
    if (instruction === "") return;
    input.value = "";
    start(instruction);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || active !== null) return;
    event.preventDefault();
    onSend();
  };

  /**
   * Push to talk, and the transcript goes into the box rather than onto the
   * wire. There is no confirmation step downstream - the copilot flies what it
   * is given - so the operator reading what was heard IS the confirmation.
   */
  let listening = false;
  const setMic = (state: "off" | "idle" | "live", why: string): void => {
    cls(mic, state === "off" ? MIC_OFF : state === "live" ? MIC_LIVE : MIC_IDLE);
    mic.disabled = state === "off";
    mic.title = why;
  };

  const onMic = (): void => {
    if (listening) {
      listening = false;
      setMic("idle", "음성 입력");
      text(status, "받아쓰는 중");
      void dictateStop()
        .then((said) => {
          if (said === "") return;
          // Appended, not replaced: dictating twice should add to a sentence
          // rather than silently discard the first half.
          input.value = input.value === "" ? said : `${input.value} ${said}`;
          input.focus();
        })
        .catch((err: unknown) => {
          setMic("idle", err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (active === null) text(status, "대기");
        });
      return;
    }
    listening = true;
    setMic("live", "말한 뒤 다시 누르세요");
    text(status, "듣는 중");
    void dictateStart().catch((err: unknown) => {
      listening = false;
      setMic("idle", err instanceof Error ? err.message : String(err));
      text(status, "대기");
    });
  };

  // Asked once at install: whether there is a microphone and a model on disk
  // is a property of the machine, and the button should say which is missing
  // rather than failing on the first press.
  setMic("off", "음성 입력 확인 중");
  void dictateReady()
    .then((device) => setMic("idle", `음성 입력 · ${device}`))
    .catch((err: unknown) => setMic("off", err instanceof Error ? err.message : String(err)));

  mic.addEventListener("click", onMic);
  send.addEventListener("click", onSend);
  input.addEventListener("keydown", onKey);
  text(openReply().text, "지시를 입력하면 바로 실행합니다. 실행 중에는 전송 버튼이 중단으로 바뀝니다.");

  return {
    abort(): void {
      active?.cancel();
    },
    dispose(): void {
      active?.cancel();
      stopTicker();
      if (listening) void dictateStop().catch(() => {});
      mic.removeEventListener("click", onMic);
      send.removeEventListener("click", onSend);
      input.removeEventListener("keydown", onKey);
    },
  };
}
