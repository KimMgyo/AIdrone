/**
 * How big each marker actually is, in centimetres, keyed by its id.
 *
 * The follow loop steers on apparent size, so it cannot hold a distance
 * without knowing the real one: a 4 cm tag and a 20 cm tag that both measure
 * 42 px across are five times apart in space. Marker ids are printed on
 * physical objects that outlive a session, so the table is persisted; a tag
 * measured once stays measured.
 *
 * A marker with no entry is deliberately **not** followable. Guessing a size
 * would fly the drone to a distance nobody chose, and the failure mode of
 * guessing too small is flying too close.
 */

/**
 * Pixels of apparent edge per centimetre of real edge, at the distance the
 * drone holds.
 *
 * Measured on the bench: a 4 cm marker sat at 42 px across at the standoff
 * that reads as "following, not looming". Since apparent size goes as
 * `f · S / d`, fixing this ratio fixes the distance `d` for every marker size
 * at once - which is the whole point of asking for `S`.
 */
export const PX_PER_CM = 42 / 4;

/** Sizes outside this are a typo, not a tag: mm entered as cm, or a stray 0. */
export const MARKER_SIZE_CM = { min: 1, max: 100 } as const;

/** The apparent edge, in pixels, that holds the standard distance for `sizeCm`. */
export function markerTargetPx(sizeCm: number): number {
  return PX_PER_CM * sizeCm;
}

/** Null for anything that is not a usable measurement, so callers cannot half-check. */
export function parseMarkerSize(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cm = Number(trimmed);
  if (!Number.isFinite(cm) || cm < MARKER_SIZE_CM.min || cm > MARKER_SIZE_CM.max) return null;
  // One decimal is finer than anyone measures a printed tag, and it keeps the
  // stored value identical to what the operator typed.
  return Math.round(cm * 10) / 10;
}

export interface MarkerSizes {
  /** Centimetres, or null when this id has never been measured. */
  get(id: number): number | null;
  /** `null` forgets the id. Invalid sizes are refused rather than stored. */
  set(id: number, sizeCm: number | null): void;
  /** Every measured id, ascending - for a panel that lists what is known. */
  entries(): readonly (readonly [number, number])[];
  subscribe(listener: () => void): () => void;
}

const STORAGE_KEY = "aidrone.marker-size-cm";

/**
 * Reads the table without trusting it. Anything the parser rejects is dropped
 * rather than repaired: a corrupted entry that silently becomes 1 cm would fly
 * the drone straight at the wall.
 */
function load(store: Storage | null): Map<number, number> {
  const sizes = new Map<number, number>();
  if (store === null) return sizes;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return sizes;
  }
  if (raw === null) return sizes;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sizes;
  }
  if (typeof parsed !== "object" || parsed === null) return sizes;
  for (const [key, value] of Object.entries(parsed)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (typeof value !== "number") continue;
    const cm = parseMarkerSize(String(value));
    if (cm !== null) sizes.set(id, cm);
  }
  return sizes;
}

/**
 * `store` is injected so the table can be exercised without a browser, and so
 * a WebView that denies storage degrades to an in-memory table rather than
 * throwing on the first measurement.
 */
export function createMarkerSizes(store: Storage | null = globalThis.localStorage ?? null): MarkerSizes {
  const sizes = load(store);
  const listeners = new Set<() => void>();

  const persist = (): void => {
    if (store === null) return;
    const flat: Record<string, number> = {};
    for (const [id, cm] of sizes) flat[String(id)] = cm;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(flat));
    } catch {
      // A full or blocked store must not take the flight down with it; the
      // table still works for this session.
    }
  };

  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("marker-size: subscriber threw", err);
      }
    }
  };

  return {
    get(id): number | null {
      return sizes.get(id) ?? null;
    },
    set(id, sizeCm): void {
      if (!Number.isSafeInteger(id) || id < 0) return;
      if (sizeCm === null) {
        if (!sizes.delete(id)) return;
      } else {
        const cm = parseMarkerSize(String(sizeCm));
        if (cm === null || sizes.get(id) === cm) return;
        sizes.set(id, cm);
      }
      persist();
      announce();
    },
    entries(): readonly (readonly [number, number])[] {
      return [...sizes.entries()].sort((a, b) => a[0] - b[0]);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
