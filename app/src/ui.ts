/**
 * The whole UI runtime: five functions.
 *
 * This is what stands in for a component framework. The station's reactive
 * surface is a few dozen scalars that map 1:1 onto text nodes and bar widths -
 * no keyed lists that reorder, no coordinated subtree updates - so the parts a
 * framework earns its keep on never come up. What does come up is rewriting the
 * same cells at 10 Hz, which is why `text`, `cls` and `style` all check first:
 * an unconditional write to `textContent` dirties layout even when the string
 * is identical, and there are ~40 such cells on screen.
 *
 * Everything visual is a Tailwind class in the markup. Nothing here renders.
 */

/**
 * Resolves a selector to a node of the expected type, or throws naming it.
 * A missing node is a build mistake, not a runtime condition, and it should
 * fail at startup rather than as a null dereference ten minutes into a flight.
 *
 * `root` scopes the lookup to a panel's own subtree, so two panels may both
 * use `[data-k="bat"]` without colliding.
 */
export function must<T extends Element>(
  selector: string,
  ctor: new () => T,
  root: ParentNode = document,
): T {
  const el = root.querySelector(selector);
  if (!(el instanceof ctor)) throw new Error(`ui: ${selector} missing or wrong type`);
  return el;
}

/** Same, for the many-of-a-kind case (key cells, telemetry tiles). Throws if
 *  the count is not what the caller wired its indices against. */
export function all<T extends Element>(
  selector: string,
  ctor: new () => T,
  root: ParentNode,
  expect: number,
): T[] {
  const found = [...root.querySelectorAll(selector)];
  if (found.length !== expect) {
    throw new Error(`ui: ${selector} matched ${found.length}, expected ${expect}`);
  }
  for (const el of found) {
    if (!(el instanceof ctor)) throw new Error(`ui: ${selector} wrong type`);
  }
  return found as T[];
}

/** Writes `value` only when it differs from what is already there. */
export function text(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

/** Same guard for the class attribute - used by every threshold colour. */
export function cls(el: HTMLElement, value: string): void {
  if (el.className !== value) el.className = value;
}

/**
 * Same guard for one inline style property. Bar widths and needle offsets are
 * the only geometry the layout cannot express as a class, because they are
 * continuous; everything else stays in Tailwind.
 */
export function style(el: HTMLElement, prop: string, value: string): void {
  if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
}

/** `HH:MM:SS`, the stamp every log line in this app carries. */
export function hms(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `M:SS` elapsed, for flight time. Seconds come straight off the drone. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
