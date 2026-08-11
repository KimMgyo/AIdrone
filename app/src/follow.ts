import { PX_PER_CM } from "./marker-size.ts";

/**
 * Target-follow: the only autonomous producer of `rc` in this app.
 *
 * **The lock is the switch.** There is no separate arm step: while a target is
 * locked the drone follows it, and releasing the lock stops it. That is what
 * the operator asked for, and it is defensible because the lock is already a
 * deliberate act on a specific, named target - a marker id or a native track
 * id - rather than an ambient state.
 *
 * Three limits shape the rest.
 *
 * 1. **It lives here, not in Rust.** `vision.rs` holds no Tello handle, so a
 *    detector still cannot command the airframe. Autonomy is assembled in the
 *    composition root out of two things the operator can already see: a locked
 *    target, and the same `sendRc` the keyboard uses.
 *
 * 2. **Two channels, not four.** Roll and throttle are hardcoded to 0. The
 *    sibling tellovoice project shipped four live channels, could not verify
 *    the sign of every gain against a real airframe, and ended up zeroing
 *    exactly these two. Yaw and forward/back are enough to hold a target, and
 *    a wrong sign on them is a turn or a nudge - not an unplanned climb.
 *
 * 3. **It never acts on a remembered target.** A lock whose target is not in
 *    the current frame centres the sticks and waits. Nothing extrapolates a
 *    position, and the loop stays engaged so the drone resumes the moment the
 *    target is seen again.
 */

/** SDK channel order in `rc <lr> <fb> <ud> <yaw>`, matching `panels/keymap.ts`. */
export type FollowCommand = Readonly<{ lr: 0; fb: number; ud: 0; yaw: number }>;
/** One observation, in the decoded frame's own pixels. */
export type FollowTarget = Readonly<{
  centerX: number;
  centerY: number;
  /**
   * The dimension the distance law reads: a marker's edge, or a person's box
   * **width**. Height is the obvious choice and the wrong one - a person who
   * comes close is clipped at the top and bottom of the frame long before they
   * are clipped at the sides, so their box height collapses while they are
   * still fully measurable across.
   */
  size: number;
  /**
   * False when the box touches a side of the frame, which makes `size` a
   * lower bound rather than a measurement. The loop keeps steering yaw - it
   * still knows which way the target is - and holds its distance.
   */
  sizeReliable: boolean;
  frameWidth: number;
  frameHeight: number;
}>;

export type FollowConfig = Readonly<{
  /** `size` the loop holds. Error is relative, so this also sets the scale. */
  desiredSize: number;
  yawGain: number;
  distanceGain: number;
  /** Fraction of half-frame below which yaw stays centred. */
  yawDeadband: number;
  /**
   * Below this the drone holds its distance, in **natural-log distance
   * ratio**: 0.08 is about 8% nearer or farther than the held distance, and
   * it means the same thing in both directions - which the old
   * fraction-of-pixels deadband did not.
   */
  distanceDeadband: number;
  /**
   * Smallest deflection worth sending once an error clears the deadband.
   *
   * A Tello holds position with its own VPS loop, and a stick input below
   * roughly a tenth of full scale is inside what that loop absorbs: the first
   * flight of this controller commanded 8-15 and the airframe simply sat
   * there. Below this floor the command is not "gentle", it is discarded by
   * the drone - so the law jumps straight to it rather than ramping through a
   * range that does nothing.
   */
  minRc: number;
  maxRc: number;
  /** Cap on how far one channel may move in a single 10 Hz tick. */
  slewPerTick: number;
}>;

/**
 * Tuned after the first real flight, where `maxRc: 15` produced visible rc on
 * the wire and no visible motion. The keyboard path flies this airframe at a
 * deflection of 60 (`panels/keymap.ts`), so these remain well under manual
 * authority while clearing the drone's own hold.
 */
export const FOLLOW_DEFAULTS: FollowConfig = {
  desiredSize: 150,
  yawGain: 60,
  // Log units: full output at `ln 2` - twice or half the held distance - the
  // floor at about 25% off, and nothing at all inside 8%.
  distanceGain: 50,
  yawDeadband: 0.1,
  distanceDeadband: 0.08,
  minRc: 12,
  // Fixed, not selectable. 60 is manual full deflection; 50 is the setting
  // the airframe was actually tuned and flown at, and an in-flight selector
  // was one more thing to get wrong mid-chase.
  maxRc: 50,
  slewPerTick: 8,
};

/** A marker's target size is computed from its real size; see `marker-size.ts`. */
export const ARUCO_DESIRED_SIZE = 150;
/**
 * How wide a person should look when the drone is holding station: measured
 * on the bench at the distance that reads as "following, not looming". Fixed
 * on purpose - person mode has no setpoint to capture, because it has no
 * particular person to capture it from.
 */
export const PERSON_DESIRED_SIZE = 360;


/**
 * When person mode flies the drone, and at what.
 *
 * Extracted from the composition root and named because it is the one
 * autonomous decision with no operator gesture behind it: there is no lock to
 * click, so this expression alone decides that a drone starts chasing
 * somebody. It follows whoever the detector reports as nearest, and only while
 * the mode is genuinely live - a stale snapshot from a mode that has been left
 * must never re-arm the loop.
 */
export function personFollow(state: {
  readonly active: boolean;
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly target: { readonly detection: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null };
}): { readonly following: boolean; readonly target: FollowTarget | null } {
  const detection = state.target.detection;
  if (!state.active || detection === null || state.frameSize === null) {
    return { following: false, target: null };
  }
  // A box touching a frame edge is clipped, so its width understates the
  // person and would read as "too far" exactly when they are nearest.
  const edgeMargin = 2;
  return {
    following: true,
    target: {
      centerX: detection.x + detection.width / 2,
      centerY: detection.y + detection.height / 2,
      // Width, not height: someone who comes close is clipped top and bottom
      // long before they are clipped at the sides.
      size: detection.width,
      sizeReliable: detection.x > edgeMargin && detection.x + detection.width < state.frameSize.width - edgeMargin,
      frameWidth: state.frameSize.width,
      frameHeight: state.frameSize.height,
    },
  };
}

/**
 * When marker mode flies the drone, at what, and to what setpoint.
 *
 * Two gates, both of which must pass. The operator has to lock an id - that
 * part is unchanged - and the marker has to have a **registered physical
 * size**. Without the size the loop cannot turn apparent pixels into a
 * distance, and a default would hold the drone at whatever range a 4 cm tag
 * happens to imply. On a 20 cm tag that is five times too close.
 */
export function markerFollow(input: {
  readonly active: boolean;
  readonly locked: boolean;
  readonly frameSize: { readonly width: number; readonly height: number } | null;
  readonly metrics: { readonly centerX: number; readonly centerY: number; readonly edge: number } | null;
  /** Centimetres from the size registry, or null when this id was never measured. */
  readonly sizeCm: number | null;
}): { readonly following: boolean; readonly target: FollowTarget | null; readonly desiredSize: number } {
  const setpoint = input.sizeCm === null ? ARUCO_DESIRED_SIZE : PX_PER_CM * input.sizeCm;
  if (!input.active || !input.locked || input.sizeCm === null) {
    return { following: false, target: null, desiredSize: setpoint };
  }
  if (input.metrics === null || input.frameSize === null) {
    return { following: false, target: null, desiredSize: setpoint };
  }
  return {
    following: true,
    target: {
      centerX: input.metrics.centerX,
      centerY: input.metrics.centerY,
      size: input.metrics.edge,
      // A marker that runs off the frame stops decoding entirely, so any
      // marker we have is a whole one.
      sizeReliable: true,
      frameWidth: input.frameSize.width,
      frameHeight: input.frameSize.height,
    },
    desiredSize: setpoint,
  };
}

export const FOLLOW_NEUTRAL: FollowCommand = { lr: 0, fb: 0, ud: 0, yaw: 0 };

/** Milliseconds without a detected target before the sticks are centred. */
export const LOSS_NEUTRAL_MS = 400;

/** 10 Hz, the same hold the keyboard path uses. See `keymap.ts`. */
const RC_SEND_INTERVAL_MS = 100;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/** Moves `next` toward its target by at most `slew`, so a re-acquire ramps. */
function slew(previous: number, next: number, limit: number): number {
  return previous + clamp(next - previous, limit);
}

/**
 * One channel: dead inside the deadband, and never weaker than `minRc` once
 * outside it. The floor matters more than the gain here - a proportional law
 * spends most of its range below what the airframe reacts to at all.
 */
function channel(error: number, deadband: number, gain: number, config: FollowConfig): number {
  if (Math.abs(error) < deadband) return 0;
  const magnitude = Math.min(Math.max(Math.abs(gain * error), config.minRc), config.maxRc);
  return error < 0 ? -magnitude : magnitude;
}

/**
 * The control law, pure so it can be tested without a drone or a clock.
 *
 * Signs, stated once because they are the part that flies into a wall:
 * a target right of centre yields **positive yaw** (the SDK turns clockwise,
 * i.e. toward it), and a target smaller than `desiredSize` - meaning too far -
 * yields **positive fb** (forward).
 */
export function followCommand(
  target: FollowTarget,
  config: FollowConfig,
  previous: FollowCommand = FOLLOW_NEUTRAL,
): FollowCommand {
  if (
    !Number.isFinite(target.centerX) ||
    !Number.isFinite(target.size) ||
    target.frameWidth <= 0 ||
    target.size <= 0 ||
    config.desiredSize <= 0
  ) {
    return FOLLOW_NEUTRAL;
  }

  const halfWidth = target.frameWidth / 2;
  const horizontal = clamp((target.centerX - halfWidth) / halfWidth, 1);
  // Log distance ratio, not relative pixels. Apparent width goes as 1/d, so
  // `(w0 - w) / w0` is 1 - d0/d: it saturates at -1 the moment the target is
  // twice too close, but only reaches +0.5 when it is twice too far and never
  // passes +1 however far it goes. That asymmetry is felt directly - a drone
  // that backs off smartly and creeps forward. `ln(w0 / w) = ln(d / d0)` is
  // symmetric: half the distance and double the distance are equal and
  // opposite, and the deadband then means the same percentage either way.
  const distance = clamp(Math.log(config.desiredSize / target.size), 1);

  const yawRaw = channel(horizontal, config.yawDeadband, config.yawGain, config);
  // A clipped box measures narrower than the target really is, which reads as
  // "too far" and would drive the drone forward into the very thing that is
  // already filling the frame.
  const fbRaw = target.sizeReliable ? channel(distance, config.distanceDeadband, config.distanceGain, config) : 0;

  return {
    lr: 0,
    ud: 0,
    yaw: Math.round(slew(previous.yaw, yawRaw, config.slewPerTick)),
    fb: Math.round(slew(previous.fb, fbRaw, config.slewPerTick)),
  };
}

export function isNeutral(command: FollowCommand): boolean {
  return command.fb === 0 && command.yaw === 0;
}

export function toSdk(command: FollowCommand): string {
  return `rc ${command.lr} ${command.fb} ${command.ud} ${command.yaw}`;
}

export type FollowPhase =
  /** No lock: the loop is not running and nothing is on the wire. */
  | "idle"
  /** Locked and steering. */
  | "following"
  /** Locked, but the target is not in the current frame: sticks centred. */
  | "searching"
  /** Halted by an explicit stop; stays halted until the lock is released. */
  | "halted";

export type FollowState = Readonly<{
  phase: FollowPhase;
  /** The command last put on the wire; neutral whenever the loop is idle. */
  command: FollowCommand;
  /** Milliseconds since the last detected observation, or null if never. */
  staleMs: number | null;
  /** The output ceiling. Fixed at `FOLLOW_DEFAULTS.maxRc`. */
  maxRc: number;
  /** The target's apparent size right now, in frame pixels. */
  targetSize: number | null;
  /** The fixed setpoint for the current mode, in frame pixels. */
  desiredSize: number;
  /**
   * What the drone's own state datagram says about being off the ground, or
   * null before any has arrived. A Tello ignores `rc` entirely while landed,
   * so a loop that is "steering" a grounded drone has to say so rather than
   * print confident numbers at someone watching a motionless airframe.
   */
  airborne: boolean | null;
}>;

export type FollowStopReason = "mode" | "session" | "emergency";
export type FollowReason = FollowStopReason | "locked" | "released";

export type FollowListener = (state: FollowState, reason: FollowReason | null) => void;

export interface FollowDeps {
  sendRc: (cmd: string) => void;
  now?: () => number;
  setInterval?: (handler: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
}

/**
 * What a panel may do: read and watch. Nothing here changes how the loop
 * flies - the power ceiling and both setpoints are fixed, so the card is a
 * readout, not a cockpit.
 */
export interface FollowPort {
  state(): FollowState;
  subscribe(listener: FollowListener): () => void;
}

export interface FollowController extends FollowPort {
  /**
   * The whole input. `locked` is the switch; `target` is the current-frame
   * observation of that lock, or null when it is not visible right now.
   */
  update(locked: boolean, target: FollowTarget | null, desiredSize: number): void;
  /** From the drone's own state datagram. Display only, never a gate. */
  setAirborne(airborne: boolean | null): void;
  /** Emergency, mode change, teardown. Halts until the lock is released. */
  stop(reason: FollowStopReason): void;
}

export function createFollowController(deps: FollowDeps, config: FollowConfig = FOLLOW_DEFAULTS): FollowController {
  const now = deps.now ?? (() => Date.now());
  const start = deps.setInterval ?? ((handler, ms) => window.setInterval(handler, ms));
  const stopTimer = deps.clearInterval ?? ((handle) => window.clearInterval(handle));
  const listeners = new Set<FollowListener>();

  let locked = false;
  let maxRc = config.maxRc;
  /**
   * Set by `stop`, cleared only when the lock is released. Without it an
   * emergency stop would last exactly one tick: the next vision event still
   * carries the same lock, and the loop would re-engage on its own.
   */
  let halted = false;
  let airborne: boolean | null = null;
  let loop = 0;
  let target: FollowTarget | null = null;
  /** The mode's fixed setpoint: 150 px for a marker, 360 px for a person. */
  let modeSize = config.desiredSize;
  let lastDetectedAt: number | null = null;
  let command: FollowCommand = FOLLOW_NEUTRAL;
  /** True while the last thing on the wire was a live deflection - the reason
   *  one neutral is sent on the way down and then the loop falls silent. */
  let moving = false;

  function phase(): FollowPhase {
    if (!locked) return "idle";
    if (halted) return "halted";
    const stale = lastDetectedAt === null ? Number.POSITIVE_INFINITY : now() - lastDetectedAt;
    return target !== null && stale < LOSS_NEUTRAL_MS ? "following" : "searching";
  }



  function snapshot(): FollowState {
    return {
      phase: phase(),
      command,
      staleMs: lastDetectedAt === null ? null : now() - lastDetectedAt,
      maxRc,
      targetSize: target?.size ?? null,
      desiredSize: modeSize,
      airborne,
    };
  }

  function announce(reason: FollowReason | null): void {
    const state = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(state, reason);
      } catch (err) {
        console.error("follow: subscriber threw", err);
      }
    }
  }

  function send(next: FollowCommand): void {
    command = next;
    if (!isNeutral(next)) {
      deps.sendRc(toSdk(next));
      moving = true;
      return;
    }
    if (moving) {
      deps.sendRc(toSdk(FOLLOW_NEUTRAL));
      moving = false;
    }
  }

  function stopLoop(): void {
    if (loop === 0) return;
    stopTimer(loop);
    loop = 0;
  }

  /** Centres the sticks unconditionally - not `if (moving)`, because every
   *  caller here is a stop and a stop must put a zero on the wire. */
  function forceNeutral(): void {
    command = FOLLOW_NEUTRAL;
    moving = false;
    deps.sendRc(toSdk(FOLLOW_NEUTRAL));
  }

  function tick(): void {
    if (!locked || halted) return;
    const stale = lastDetectedAt === null ? Number.POSITIVE_INFINITY : now() - lastDetectedAt;
    if (target === null || stale >= LOSS_NEUTRAL_MS) {
      // The lock stays. The drone holds position on zeroes and picks the
      // target back up by itself the moment it is detected again.
      send(FOLLOW_NEUTRAL);
      announce(null);
      return;
    }
    send(followCommand(target, { ...config, desiredSize: modeSize, maxRc }, command));
    announce(null);
  }

  return {
    update(nextLocked, nextTarget, size): void {
      const wasLocked = locked;
      const wasSize = modeSize;
      locked = nextLocked;
      target = nextTarget;
      modeSize = size > 0 ? size : config.desiredSize;
      if (nextTarget !== null) lastDetectedAt = now();

      if (!locked) {
        // Idle, but not necessarily unchanged: a mode switch moves the
        // setpoint while nothing is locked, and a panel that is never told
        // keeps showing the previous mode's number.
        if (!wasLocked) {
          if (modeSize !== wasSize) announce(null);
          return;
        }
        // Releasing the lock is the operator's stop, and it also clears a halt
        // so the next lock starts clean.
        halted = false;
        lastDetectedAt = null;
        stopLoop();
        forceNeutral();
        announce("released");
        return;
      }
      if (!wasLocked) {
        command = FOLLOW_NEUTRAL;
        moving = false;
        announce("locked");
      }
      if (loop === 0) loop = start(tick, RC_SEND_INTERVAL_MS);
      tick();
    },

    stop(reason): void {
      // A stop with nothing running is a no-op, not a latch. `setMode` fires
      // one on every mode change including the very first, and latching there
      // left the next lock halted before it had ever moved.
      if (!locked || halted) return;
      halted = true;
      stopLoop();
      forceNeutral();
      announce(reason);
    },

    setAirborne(next): void {
      if (next === airborne) return;
      airborne = next;
      announce(null);
    },

    state: snapshot,

    subscribe(listener): () => void {
      listeners.add(listener);
      listener(snapshot(), null);
      return () => listeners.delete(listener);
    },
  };
}
