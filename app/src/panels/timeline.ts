/**
 * Action timeline - the right column's record of what the station did.
 *
 * The UDP console below the video is the wire; this is the story. One entry per
 * decision worth remembering (link came up, a command went out, an autonomous
 * step ran, a stop fired), stamped and threaded on a rail so the order reads at
 * a glance. Nothing here observes anything: the caller pushes, in Korean,
 * because only the caller knows what the event meant.
 */
import { appendCapped } from "./console.ts";
import { cls, hms, must, text } from "../ui.ts";

/** The supplied timeline retains its latest sixty visible actions. */
const MAX_ENTRIES = 60;

export type ActionTag = "LINK" | "CMD" | "EXEC" | "STOP";

/** Red is stop and nothing else; green is an autonomous step that ran. */
const DOT: Record<ActionTag, string> = {
  STOP: "bg-alert",
  EXEC: "bg-ok",
  LINK: "bg-accent",
  CMD: "bg-accent",
};

const LABEL: Record<ActionTag, string> = {
  STOP: "text-alert2",
  EXEC: "text-ok2",
  LINK: "text-accent2",
  CMD: "text-accent2",
};

const RAIL = "absolute left-[5px] top-[14px] bottom-0 w-px bg-[#1F252D]";
const RAIL_TAIL = "absolute left-[5px] top-[14px] bottom-0 w-px bg-transparent";

export interface TimelinePanel {
  push(tag: ActionTag, textLine: string): void;
  clear(): void;
}

export function installTimeline(mount: HTMLElement): TimelinePanel {
  mount.innerHTML = `
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex h-[36px] flex-none items-center justify-between px-[15px]">
        <div class="font-mono text-[10.5px] tracking-[.16em] text-dim2">ACTION TIMELINE</div>
        <div data-k="count" class="font-mono text-[10px] text-dim2">0 actions</div>
      </div>
      <div data-k="list" class="min-h-0 flex-1 overflow-y-auto px-[15px] pb-[12px]"></div>
    </div>
  `;

  const count = must('[data-k="count"]', HTMLElement, mount);
  const list = must('[data-k="list"]', HTMLElement, mount);

  /**
   * The rail of the entry currently at the bottom, held so the next push can
   * give it back. A rail on the last entry dangles into empty space, so the
   * tail is always transparent - which means the flip has to happen on both
   * entries, not just the new one.
   */
  let tail: HTMLElement | null = null;

  return {
    push(tag, textLine) {
      // Built node by node, never `innerHTML`: `textLine` is caller prose and
      // must not be parsed as markup.
      const entry = document.createElement("div");
      entry.className = "relative pb-[13px] pl-[20px]";

      const dot = document.createElement("div");
      dot.className = `absolute left-[2px] top-[5px] h-[7px] w-[7px] rounded-full ${DOT[tag]}`;

      const rail = document.createElement("div");
      rail.className = RAIL_TAIL;

      const head = document.createElement("div");
      head.className = "flex items-baseline gap-[9px]";

      const stamp = document.createElement("div");
      stamp.className = "flex-none font-mono text-[10.5px] text-dim3";
      stamp.textContent = hms();

      const label = document.createElement("div");
      label.className = `font-mono text-[10px] tracking-[.1em] ${LABEL[tag]}`;
      label.textContent = tag;

      head.append(stamp, label);

      const body = document.createElement("div");
      body.className = "pt-[3px] text-[11.5px] leading-[1.5] text-dim";
      body.textContent = textLine;

      entry.append(dot, rail, head, body);

      if (tail) cls(tail, RAIL);
      tail = rail;

      appendCapped(list, entry, MAX_ENTRIES);
      // Entries listed, not actions ever taken - the cap drops the oldest, and
      // a counter that outran the list would be claiming to show what it threw
      // away.
      text(count, `${list.childElementCount} actions`);
    },

    clear() {
      list.replaceChildren();
      tail = null;
      text(count, "0 actions");
    },
  };
}
