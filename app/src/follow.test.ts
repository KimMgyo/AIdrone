import { describe, expect, test } from "bun:test";
import {
  createFollowController,
  followCommand,
  FOLLOW_DEFAULTS,
  FOLLOW_NEUTRAL,
  LOSS_NEUTRAL_MS,
  markerFollow,
  personFollow,
  toSdk,
  type FollowCommand,
  type FollowState,
  type FollowTarget,
} from "./follow.ts";

const FRAME = { frameWidth: 960, frameHeight: 720 };

function at(centerX: number, size: number, sizeReliable = true): FollowTarget {
  return { centerX, centerY: 360, size, sizeReliable, ...FRAME };
}

/** Runs the law to convergence so the slew limiter is not the thing measured. */
function settled(target: FollowTarget, desiredSize = FOLLOW_DEFAULTS.desiredSize): FollowCommand {
  let command = FOLLOW_NEUTRAL;
  for (let i = 0; i < 20; i++) command = followCommand(target, { ...FOLLOW_DEFAULTS, desiredSize }, command);
  return command;
}

describe("followCommand", () => {
  test("turns toward the target and never drives roll or throttle", () => {
    const right = settled(at(860, 150));
    const left = settled(at(100, 150));
    expect(right.yaw).toBeGreaterThan(0);
    expect(left.yaw).toBeLessThan(0);
    for (const command of [right, left]) {
      expect(command.lr).toBe(0);
      expect(command.ud).toBe(0);
    }
  });

  test("moves toward a target that is too far and backs off one that is too close", () => {
    expect(settled(at(480, 60)).fb).toBeGreaterThan(0);
    expect(settled(at(480, 400)).fb).toBeLessThan(0);
  });

  test("holds still inside both deadbands", () => {
    // 4% off centre horizontally and 5% off the desired size: both inside.
    const command = settled(at(480 + 0.04 * 480, 150 * 1.05));
    expect(command).toEqual(FOLLOW_NEUTRAL);
  });

  test("never exceeds maxRc on either live channel", () => {
    for (const target of [at(959, 1), at(0, 4000), at(480, 1)]) {
      const command = settled(target);
      expect(Math.abs(command.yaw)).toBeLessThanOrEqual(FOLLOW_DEFAULTS.maxRc);
      expect(Math.abs(command.fb)).toBeLessThanOrEqual(FOLLOW_DEFAULTS.maxRc);
    }
  });

  test("ramps through the slew limit instead of stepping to full deflection", () => {
    const hard = at(960, 20);
    const first = followCommand(hard, FOLLOW_DEFAULTS, FOLLOW_NEUTRAL);
    expect(Math.abs(first.yaw)).toBeLessThanOrEqual(FOLLOW_DEFAULTS.slewPerTick);
    expect(Math.abs(first.fb)).toBeLessThanOrEqual(FOLLOW_DEFAULTS.slewPerTick);
    expect(Math.abs(settled(hard).yaw)).toBe(FOLLOW_DEFAULTS.maxRc);
  });

  test("refuses degenerate geometry rather than emitting a guess", () => {
    expect(followCommand({ ...at(480, 150), frameWidth: 0 }, FOLLOW_DEFAULTS)).toEqual(FOLLOW_NEUTRAL);
    expect(followCommand(at(480, 0), FOLLOW_DEFAULTS)).toEqual(FOLLOW_NEUTRAL);
    expect(followCommand(at(Number.NaN, 150), FOLLOW_DEFAULTS)).toEqual(FOLLOW_NEUTRAL);
  });

  test("serializes in the SDK's channel order", () => {
    expect(toSdk({ lr: 0, fb: 7, ud: 0, yaw: -3 })).toBe("rc 0 7 0 -3");
  });

  test("a real error never leaves as a deflection the airframe ignores", () => {
    // 12% off centre and 18% undersized: just outside both deadbands, and the
    // proportional term alone would be 7 and 8 - below what a Tello's own
    // position hold reacts to, which is why the first flight sat still.
    const command = settled(at(480 + 0.12 * 480, 150 * 0.82));
    expect(Math.abs(command.yaw)).toBeGreaterThanOrEqual(FOLLOW_DEFAULTS.minRc);
    expect(Math.abs(command.fb)).toBeGreaterThanOrEqual(FOLLOW_DEFAULTS.minRc);
  });

  test("the floor never overrides the deadband", () => {
    expect(settled(at(480 + 0.04 * 480, 150 * 1.05))).toEqual(FOLLOW_NEUTRAL);
  });

  test("holds its distance when the box is clipped by the frame edge", () => {
    // A clipped person measures narrow, which reads as "far" - the one case
    // where obeying the distance term flies at whatever is filling the frame.
    const clipped = settled(at(860, 40, false));
    expect(clipped.fb).toBe(0);
    expect(Math.abs(clipped.yaw)).toBeGreaterThan(0);
  });

  test("approach and retreat are equally strong at the same distance ratio", () => {
    // Apparent width goes as 1/d, so half the distance is double the width.
    // In relative-pixel error these were -1.0 against +0.5 - the drone backed
    // off hard and crept forward. In log distance they are mirror images.
    const twiceAsFar = settled(at(480, 150 / 2));
    const halfAsFar = settled(at(480, 150 * 2));
    expect(twiceAsFar.fb).toBeGreaterThan(0);
    expect(halfAsFar.fb).toBeLessThan(0);
    expect(twiceAsFar.fb).toBe(-halfAsFar.fb);

    // ...and so are smaller, more typical errors.
    const quarterFar = settled(at(480, 150 / 1.25));
    const quarterNear = settled(at(480, 150 * 1.25));
    expect(quarterFar.fb).toBe(-quarterNear.fb);
  });

  test("the distance deadband means the same percentage in both directions", () => {
    // 5% either way is inside the 0.08 log deadband; 15% either way is outside.
    expect(settled(at(480, 150 / 1.05)).fb).toBe(0);
    expect(settled(at(480, 150 * 1.05)).fb).toBe(0);
    expect(settled(at(480, 150 / 1.15)).fb).toBeGreaterThan(0);
    expect(settled(at(480, 150 * 1.15)).fb).toBeLessThan(0);
  });
});

/** A hand-cranked clock and loop, so every timing rule is asserted exactly. */
function harness() {
  const sent: string[] = [];
  const changes: { state: FollowState; reason: string | null }[] = [];
  let clock = 1_000;
  let tick: (() => void) | null = null;
  const controller = createFollowController({
    sendRc: (cmd) => sent.push(cmd),
    now: () => clock,
    setInterval: (handler) => {
      tick = handler;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  controller.subscribe((state, reason) => changes.push({ state, reason }));
  return {
    controller,
    sent,
    changes,
    last: () => sent[sent.length - 1] ?? null,
    lastReason: () => changes[changes.length - 1]?.reason ?? null,
    /** Reasons are events; the live ticks that follow one report `null`. */
    reasons: () => changes.map((c) => c.reason).filter((r) => r !== null),
    advance(ms: number): void {
      clock += ms;
    },
    pump(): void {
      tick?.();
    },
    running: () => tick !== null,
  };
}
describe("createFollowController", () => {
  test("does nothing at all until a target is locked", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.controller.update(false, at(860, 100), 150);
      h.advance(100);
      h.pump();
    }
    expect(h.sent).toEqual([]);
    expect(h.controller.state().phase).toBe("idle");
  });

  test("steers as soon as the lock appears, with no arming step", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    expect(h.controller.state().phase).toBe("following");
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.controller.state().command.yaw).toBeGreaterThan(0);
    expect(h.reasons()).toContain("locked");
  });

  test("keeps the lock and waits when the target leaves the frame", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    h.sent.length = 0;

    h.controller.update(true, null, 150);
    h.advance(LOSS_NEUTRAL_MS);
    h.pump();
    expect(h.sent).toEqual(["rc 0 0 0 0"]);
    expect(h.controller.state().phase).toBe("searching");

    // Still locked minutes later: no self-disarm, because the operator asked
    // for the lock to hold until they release it.
    h.advance(120_000);
    h.pump();
    expect(h.controller.state().phase).toBe("searching");
    expect(h.running()).toBe(true);
  });

  test("resumes by itself when the target comes back", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    h.controller.update(true, null, 150);
    h.advance(LOSS_NEUTRAL_MS);
    h.pump();

    h.controller.update(true, at(860, 100), 150);
    expect(h.controller.state().phase).toBe("following");
    expect(h.last()).not.toBe("rc 0 0 0 0");
  });

  test("releasing the lock centres the sticks and stops the loop", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    h.sent.length = 0;

    h.controller.update(false, null, 150);

    expect(h.sent).toEqual(["rc 0 0 0 0"]);
    expect(h.controller.state().phase).toBe("idle");
    expect(h.running()).toBe(false);
    expect(h.lastReason()).toBe("released");
  });

  test("an emergency stop stays stopped while the lock is still held", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    h.sent.length = 0;

    h.controller.stop("emergency");
    expect(h.sent).toEqual(["rc 0 0 0 0"]);
    expect(h.controller.state().phase).toBe("halted");
    expect(h.running()).toBe(false);

    // The vision events keep coming with the same lock; none may restart it.
    for (let i = 0; i < 5; i++) {
      h.controller.update(true, at(860, 100), 150);
      h.advance(100);
      h.pump();
    }
    expect(h.sent).toEqual(["rc 0 0 0 0"]);
    expect(h.controller.state().phase).toBe("halted");

    // Releasing and re-locking is the way back, and it is a human act.
    h.controller.update(false, null, 150);
    h.controller.update(true, at(860, 100), 150);
    expect(h.controller.state().phase).toBe("following");
  });

  test("a mode change stops it the same way", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    h.sent.length = 0;
    h.controller.stop("mode");
    expect(h.sent).toEqual(["rc 0 0 0 0"]);
    expect(h.lastReason()).toBe("mode");
  });

  test("a pause centres the sticks and resume puts the same lock back to work", () => {
    const h = harness();
    h.controller.update(true, at(860, 100), 150);
    h.sent.length = 0;

    h.controller.stop("paused");
    expect(h.sent).toEqual(["rc 0 0 0 0"]);
    expect(h.controller.state().phase).toBe("halted");
    expect(h.running()).toBe(false);
    expect(h.lastReason()).toBe("paused");

    // A pause holds against the observation stream exactly like any other
    // halt: frames keep arriving with the lock intact and none may restart it.
    for (let i = 0; i < 5; i++) {
      h.controller.update(true, at(860, 100), 150);
      h.advance(100);
      h.pump();
    }
    expect(h.sent).toEqual(["rc 0 0 0 0"]);

    // Unlike an emergency stop, this one the operator can undo without giving
    // up the lock - and it starts flying again on the target it still holds.
    h.controller.resume();
    expect(h.controller.state().phase).toBe("following");
    expect(h.running()).toBe(true);
    expect(h.lastReason()).toBe("resumed");
    expect(h.sent.length).toBeGreaterThan(1);
  });

  test("resume is a no-op with nothing halted and nothing locked", () => {
    const h = harness();
    h.controller.resume();
    expect(h.controller.state().phase).toBe("idle");
    expect(h.sent).toEqual([]);

    // Running, not halted: resuming must not double-start the loop or put a
    // second command on the wire for one tick.
    h.controller.update(true, at(860, 100), 150);
    const before = h.sent.length;
    h.controller.resume();
    expect(h.sent.length).toBe(before);
    expect(h.controller.state().phase).toBe("following");
  });

  test("the output ceiling is fixed and nothing in flight can raise it", () => {
    const h = harness();
    // The real app re-observes every frame; without that the loop correctly
    // decides the target is stale and centres.
    const hold = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        h.advance(100);
        h.controller.update(true, at(960, 20), 150);
      }
    };

    // Hard over: the target is pinned to the frame edge, so the yaw channel
    // saturates and the command IS the ceiling.
    h.controller.update(true, at(960, 20), 150);
    hold(20);
    expect(FOLLOW_DEFAULTS.maxRc).toBe(50);
    expect(h.controller.state().maxRc).toBe(50);
    expect(Math.abs(h.controller.state().command.yaw)).toBe(50);

    // Still 50 after a stop and a fresh lock: there is no path that changes it.
    h.controller.stop("mode");
    h.controller.update(false, null, 150);
    hold(20);
    expect(h.controller.state().maxRc).toBe(50);
  });

  test("the setpoint is whatever the mode passes in, and nothing can move it", () => {
    const h = harness();
    // Dead centre, so only the distance channel can produce anything.
    h.controller.update(true, at(480, 240), 180);
    expect(h.controller.state().desiredSize).toBe(180);
    expect(h.controller.state().command.fb).toBeLessThan(0); // 240 > 180: backs off

    // Ticking does not drift it, and neither does the target settling: a
    // fixed setpoint is the whole point of dropping distance capture.
    for (let i = 0; i < 20; i++) {
      h.advance(100);
      h.controller.update(true, at(480, 240), 180);
    }
    expect(h.controller.state().desiredSize).toBe(180);
    expect(h.controller.state().command.fb).toBeLessThan(0);

    // The mode switching its own setpoint is the only thing that changes it.
    // The command follows through the slew limiter, so let it settle.
    for (let i = 0; i < 20; i++) {
      h.advance(100);
      h.controller.update(true, at(480, 240), 360);
    }
    expect(h.controller.state().desiredSize).toBe(360);
    expect(h.controller.state().command.fb).toBeGreaterThan(0); // 240 < 360: closes in
  });

  test("a mode's setpoint reaches subscribers even while nothing is locked", () => {
    const h = harness();
    const seen: number[] = [];
    h.controller.subscribe((state) => seen.push(state.desiredSize));
    seen.length = 0;

    // Exactly what a mode switch with an empty frame does. Without a
    // notification here the panel keeps printing the previous mode's target.
    h.controller.update(false, null, 360);
    expect(h.controller.state().desiredSize).toBe(360);
    expect(seen).toContain(360);

    // Same setpoint again is not news; idle ticks must not spam subscribers.
    seen.length = 0;
    h.controller.update(false, null, 360);
    expect(seen).toEqual([]);
  });
});

describe("personFollow", () => {
  const frame = { width: 960, height: 720 };
  const box = (x: number, width: number) => ({ x, y: 100, width, height: 400 });

  test("follows the moment somebody is in frame, with no lock to click", () => {
    const { following, target } = personFollow({ active: true, frameSize: frame, target: { detection: box(300, 200) } });
    expect(following).toBe(true);
    expect(target?.centerX).toBe(400);
    // Width, not height: a close person is clipped top and bottom first.
    expect(target?.size).toBe(200);
    expect(target?.sizeReliable).toBe(true);
  });

  test("does not fly on an empty frame, a missing frame, or an inactive mode", () => {
    expect(personFollow({ active: true, frameSize: frame, target: { detection: null } }).following).toBe(false);
    expect(personFollow({ active: true, frameSize: null, target: { detection: box(300, 200) } }).following).toBe(false);
    // The mode has been left; a snapshot left over from it must never re-arm.
    expect(personFollow({ active: false, frameSize: frame, target: { detection: box(300, 200) } }).following).toBe(false);
  });

  test("distrusts a width that is clipped by the frame edge", () => {
    // Touching the left edge.
    expect(personFollow({ active: true, frameSize: frame, target: { detection: box(0, 200) } }).target?.sizeReliable).toBe(false);
    // Touching the right edge: 760 + 200 = 960.
    expect(personFollow({ active: true, frameSize: frame, target: { detection: box(760, 200) } }).target?.sizeReliable).toBe(false);
    // Still following either way - a clipped person is a person; only the
    // distance channel is muted, so the drone keeps turning toward them.
    expect(personFollow({ active: true, frameSize: frame, target: { detection: box(0, 200) } }).following).toBe(true);
  });
});

describe("markerFollow", () => {
  const frame = { width: 960, height: 720 };
  const metrics = { centerX: 480, centerY: 172, edge: 43 };
  const base = { active: true, locked: true, frameSize: frame, metrics, sizeCm: 4 };

  test("holds the same distance whatever the tag measures", () => {
    // The bench reference: 4 cm at 42 px. A 20 cm tag is the SAME distance
    // away at 210 px, and holding it at 42 px instead would be five times
    // too close - which is the entire reason the size is asked for.
    expect(markerFollow({ ...base, sizeCm: 4 }).desiredSize).toBeCloseTo(42, 10);
    expect(markerFollow({ ...base, sizeCm: 20 }).desiredSize).toBeCloseTo(210, 10);
    expect(markerFollow({ ...base, sizeCm: 4 }).following).toBe(true);
  });

  test("an unmeasured marker is never followed, however good the detection", () => {
    const unmeasured = markerFollow({ ...base, sizeCm: null });
    expect(unmeasured.following).toBe(false);
    expect(unmeasured.target).toBeNull();
  });

  test("still needs the operator's lock, and a marker in this frame", () => {
    expect(markerFollow({ ...base, locked: false }).following).toBe(false);
    expect(markerFollow({ ...base, metrics: null }).following).toBe(false);
    expect(markerFollow({ ...base, frameSize: null }).following).toBe(false);
    // A snapshot from a mode that has been left must never re-arm the loop.
    expect(markerFollow({ ...base, active: false }).following).toBe(false);
  });

  test("passes the marker's geometry through unchanged", () => {
    const { target } = markerFollow(base);
    expect(target).toEqual({
      centerX: 480,
      centerY: 172,
      size: 43,
      // A marker that runs off frame stops decoding, so any marker is whole.
      sizeReliable: true,
      frameWidth: 960,
      frameHeight: 720,
    });
  });
});
