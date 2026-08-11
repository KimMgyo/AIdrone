import { describe, expect, test } from "bun:test";
import { createMarkerSizes, markerTargetPx, MARKER_SIZE_CM, parseMarkerSize, PX_PER_CM } from "./marker-size.ts";

/** A Storage stand-in, so the table can be exercised without a browser. */
function memoryStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length(): number {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key) as unknown as void,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

const KEY = "aidrone.marker-size-cm";

describe("the distance law", () => {
  test("reproduces the bench measurement it was derived from", () => {
    // 4 cm marker held at 42 px across. Everything else scales from that one
    // observation, so if this drifts the drone's standoff has silently moved.
    expect(markerTargetPx(4)).toBeCloseTo(42, 10);
    expect(PX_PER_CM).toBeCloseTo(10.5, 10);
  });

  test("holds ONE distance across marker sizes, which is the point of asking", () => {
    // Apparent size is f·S/d. Fixing px/cm fixes d, so a tag five times bigger
    // must be held at five times the pixels - not at the same pixels, which
    // would put it five times closer.
    expect(markerTargetPx(20)).toBeCloseTo(markerTargetPx(4) * 5, 10);
    expect(markerTargetPx(10) / 10).toBeCloseTo(markerTargetPx(1), 10);
  });
});

describe("parseMarkerSize", () => {
  test("accepts a real measurement and rounds to the tenth", () => {
    expect(parseMarkerSize("4")).toBe(4);
    expect(parseMarkerSize(" 15.5 ")).toBe(15.5);
    expect(parseMarkerSize("7.04")).toBe(7);
  });

  test("refuses anything that is not a size, rather than guessing one", () => {
    // A blank field is "not measured", not "zero".
    expect(parseMarkerSize("")).toBeNull();
    expect(parseMarkerSize("   ")).toBeNull();
    expect(parseMarkerSize("4cm")).toBeNull();
    expect(parseMarkerSize("abc")).toBeNull();
    expect(parseMarkerSize("NaN")).toBeNull();
    expect(parseMarkerSize("Infinity")).toBeNull();
    // 40 mm typed as mm, and a stray zero: both fly the drone somewhere wrong.
    expect(parseMarkerSize("0")).toBeNull();
    expect(parseMarkerSize("-4")).toBeNull();
    expect(parseMarkerSize(String(MARKER_SIZE_CM.max + 1))).toBeNull();
    expect(parseMarkerSize(String(MARKER_SIZE_CM.min))).toBe(MARKER_SIZE_CM.min);
  });
});

describe("createMarkerSizes", () => {
  test("an unmeasured id reads null, which is what makes it unfollowable", () => {
    const sizes = createMarkerSizes(memoryStore());
    expect(sizes.get(0)).toBeNull();
    sizes.set(0, 4);
    expect(sizes.get(0)).toBe(4);
    sizes.set(0, null);
    expect(sizes.get(0)).toBeNull();
  });

  test("refuses to store a size it would not accept from the keyboard", () => {
    const sizes = createMarkerSizes(memoryStore());
    sizes.set(3, 0);
    sizes.set(3, -1);
    sizes.set(3, Number.NaN);
    sizes.set(3, MARKER_SIZE_CM.max + 1);
    expect(sizes.get(3)).toBeNull();
  });

  test("survives a restart, because tags outlive a session", () => {
    const store = memoryStore();
    createMarkerSizes(store).set(7, 12.5);
    expect(createMarkerSizes(store).get(7)).toBe(12.5);
  });

  test("drops a corrupted entry instead of repairing it into a wrong distance", () => {
    // A 0 that becomes 1 cm would hold the drone at a fraction of the intended
    // distance; refusing to fly is the only safe reading of a broken table.
    const store = memoryStore({ [KEY]: JSON.stringify({ "1": 4, "2": 0, "3": "nope", bad: 5 }) });
    const sizes = createMarkerSizes(store);
    expect(sizes.get(1)).toBe(4);
    expect(sizes.get(2)).toBeNull();
    expect(sizes.get(3)).toBeNull();
    expect(sizes.entries()).toEqual([[1, 4]]);
  });

  test("junk in storage is not fatal", () => {
    expect(createMarkerSizes(memoryStore({ [KEY]: "{{{" })).entries()).toEqual([]);
    expect(createMarkerSizes(memoryStore({ [KEY]: "[]" })).entries()).toEqual([]);
    expect(createMarkerSizes(null).get(0)).toBeNull();
  });

  test("notifies subscribers only when something actually changed", () => {
    const sizes = createMarkerSizes(memoryStore());
    let changes = 0;
    const off = sizes.subscribe(() => {
      changes += 1;
    });

    sizes.set(1, 4);
    expect(changes).toBe(1);
    sizes.set(1, 4); // same value: not news, and a repaint mid-typing is costly
    expect(changes).toBe(1);
    sizes.set(1, 5);
    expect(changes).toBe(2);
    sizes.set(2, null); // never measured, so nothing to forget
    expect(changes).toBe(2);

    off();
    sizes.set(1, 9);
    expect(changes).toBe(2);
  });

  test("lists what is known, ascending, so a panel can render it", () => {
    const sizes = createMarkerSizes(memoryStore());
    sizes.set(9, 4);
    sizes.set(2, 20);
    sizes.set(5, 7.5);
    expect(sizes.entries()).toEqual([
      [2, 20],
      [5, 7.5],
      [9, 4],
    ]);
  });
});
