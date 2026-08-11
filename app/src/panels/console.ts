/**
 * UDP console - the raw Tello command line under the video.
 *
 * The panel is deliberately ignorant of the protocol: it never sends and it
 * never logs on its own. Typing a line, clicking a quick command and pressing
 * a flight key all funnel into the shell's single send path, which calls back
 * with `push("tx", …)` and then `push("rx", …)` when the reply lands. Logging
 * locally would mean two places decide what a transmitted line looks like, and
 * the keyboard's commands - the ones a pilot actually flies with - would never
 * appear here at all.
 */
import { all, hms, must, text } from "../ui.ts";

/**
 * The prototype's four quick actions. They remain raw SDK commands and travel
 * through the sole command path, so their replies are the real wire replies.
 * Deliberately no `rc` preset: a held RC vector belongs to the 10 Hz keymap,
 * not to a click that could leave a stick latched.
 */
const QUICK = ["command", "battery?", "streamon", "land"] as const;

/** The prototype keeps the most recent minute-scale conversation visible. */
const MAX_LINES = 60;

/**
 * px of slack in the bottom-pin test. One line here is 11.5px x 1.85 ~= 21px,
 * so 24 means a reader who has nudged up by a single line still counts as
 * pinned - which is what you want, since a mouse wheel notch is never exact.
 */
const PIN_SLACK = 24;

/**
 * Appends `row` to a scrolling log box, trims the head back to `cap` entries
 * and keeps the view at the bottom only if it was already there.
 *
 * Both halves are load-bearing. The cap, because this is a live view over a
 * 10 Hz link and an unbounded list is a memory leak with a scrollbar on it.
 * The pin test, because a reader who scrolled up to study an error must not be
 * yanked back by the next packet - and it has to be measured BEFORE the
 * append, since once the row is in the flow `scrollHeight` has already grown
 * and every box looks scrolled up.
 *
 * Exported because the action timeline needs exactly the same two rules and
 * `ui.ts` is not the place for something that knows what a log is.
 */
export function appendCapped(box: HTMLElement, row: HTMLElement, cap: number): void {
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < PIN_SLACK;
  box.append(row);
  // Counted down rather than looping on the live count: `remove()` on a null
  // first child would spin forever if the two ever disagreed.
  for (let extra = box.childElementCount - cap; extra > 0; extra--) {
    box.firstElementChild?.remove();
  }
  if (pinned) box.scrollTop = box.scrollHeight;
}

/** Who said it. Drives the line colour and nothing else. */
export type ConsoleKind = "tx" | "rx" | "err" | "info";

/**
 * `break-all` on every kind: a Tello reply is an arbitrary token with no
 * spaces in it, and `wifi?` answers can run past the panel width.
 */
const KIND: Record<ConsoleKind, string> = {
  tx: "break-all text-ink2",
  rx: "break-all text-accent",
  err: "break-all text-alert2",
  info: "break-all text-dim",
};

export interface ConsolePanel {
  push(kind: ConsoleKind, textLine: string): void;
  clear(): void;
  setEnabled(on: boolean): void;
  /** Peer address shown in the header, once endpoints() resolves. */
  setPeer(addr: string): void;
}

export function installConsole(
  mount: HTMLElement,
  deps: { send: (cmd: string) => void },
): ConsolePanel {
  // `enabled:` on the hover variants so a greyed-out control does not light up
  // under the cursor while it is refusing clicks.
  const quickMarkup = QUICK.map(
    (cmd) =>
      `<button type="button" data-quick class="h-[34px] flex-none rounded-[2px] border border-line3 bg-chip px-[10px] font-mono text-[11px] text-dim enabled:cursor-pointer enabled:hover:bg-btn enabled:hover:text-ink2 disabled:opacity-40">${cmd}</button>`,
  ).join("");

  mount.innerHTML = `
    <div class="flex h-full min-h-0 flex-col bg-sunken">
      <div class="flex h-[38px] flex-none items-center justify-between border-b border-[#1A1F26] px-[15px]">
        <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">UDP CONSOLE</div>
        <div class="flex items-center gap-[10px]">
          <div data-k="peer" class="font-mono text-[10px] text-dim2">&rarr; --</div>
          <button type="button" data-k="clear" class="h-[22px] cursor-pointer rounded-[2px] border border-line3 bg-transparent px-[9px] text-[10.5px] text-dim hover:border-line4 hover:text-ink2">clear</button>
        </div>
      </div>

      <div data-k="log" class="min-h-0 flex-1 select-text overflow-y-auto px-[15px] py-[9px] font-mono text-[11.5px] leading-[1.85]"></div>

      <form data-k="form" class="flex flex-none items-center gap-[8px] px-[15px] pb-[12px]">
        <div class="flex h-[34px] min-w-0 flex-1 items-center gap-[8px] rounded-[3px] border border-line3 bg-[#0D1116] px-[11px]">
          <div class="flex-none font-mono text-[12px] text-accent">&rsaquo;</div>
          <input data-k="input" type="text" autocomplete="off" spellcheck="false"
            placeholder="command / takeoff / rc 0 30 0 0 / battery?"
            class="h-full min-w-0 flex-1 border-none bg-transparent font-mono text-[12px] text-ink disabled:text-dim2" />
        </div>
        ${quickMarkup}
        <button type="submit" data-k="send" class="h-[34px] flex-none rounded-[3px] border border-line4 bg-btn px-[15px] text-[12px] text-ink enabled:cursor-pointer enabled:hover:bg-[#28303A] disabled:opacity-40">send</button>
      </form>
    </div>
  `;

  const peer = must('[data-k="peer"]', HTMLElement, mount);
  const log = must('[data-k="log"]', HTMLElement, mount);
  const form = must('[data-k="form"]', HTMLFormElement, mount);
  const input = must('[data-k="input"]', HTMLInputElement, mount);
  const send = must('[data-k="send"]', HTMLButtonElement, mount);
  const quick = all("[data-quick]", HTMLButtonElement, mount, QUICK.length);

  function clear(): void {
    log.replaceChildren();
  }

  // The submit event, not a keydown: Enter in a single-input form is the
  // browser's own behaviour, and re-implementing it loses IME composition -
  // the KR layout commits a candidate with the same key.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = "";
    deps.send(cmd);
  });

  quick.forEach((btn, i) => btn.addEventListener("click", () => deps.send(QUICK[i])));
  must('[data-k="clear"]', HTMLButtonElement, mount).addEventListener("click", clear);

  return {
    push(kind, textLine) {
      // Built node by node, never `innerHTML`: this string is a verbatim drone
      // reply off the wire and must not be parsed as markup.
      const row = document.createElement("div");
      row.className = "flex gap-[10px]";

      const stamp = document.createElement("div");
      stamp.className = "flex-none text-dim3";
      stamp.textContent = hms();

      const body = document.createElement("div");
      body.className = KIND[kind];
      body.textContent = textLine;

      row.append(stamp, body);
      appendCapped(log, row, MAX_LINES);
    },

    clear,

    // `clear` stays live: reading and clearing a log needs no drone.
    setEnabled(on) {
      input.disabled = !on;
      send.disabled = !on;
      for (const btn of quick) btn.disabled = !on;
    },

    setPeer(addr) {
      text(peer, `\u2192 ${addr}`);
    },
  };
}
