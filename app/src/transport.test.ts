import { describe, expect, test } from "bun:test";
import { createChannelEpoch, decodeVisionEvent } from "./transport.ts";

function marker(id: number, decisionMargin?: number): Record<string, unknown> {
  return {
    id,
    hammingDistance: 0,
    ...(decisionMargin === undefined ? {} : { decisionMargin }),
    corners: [
      { x: 10, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 40 },
      { x: 10, y: 40 },
    ],
  };
}

function arucoComparison(): Record<string, unknown> {
  return {
    kind: "aruco",
    recvEpochUs: 42,
    width: 960,
    height: 720,
    engines: [
      {
        engine: "apriltag3",
        family: "ARUCO_MIP_36h12",
        state: "ready",
        analysisMs: 1.25,
        markers: [marker(7, 37.75)],
      },
      {
        engine: "aruco-rs",
        family: "ARUCO_MIP_36h12",
        state: "ready",
        analysisMs: 2.5,
        markers: [marker(8)],
      },
    ],
  };
}

describe("decodeVisionEvent ArUco comparisons", () => {
  test("accepts exactly one ordered, same-frame result from each engine", () => {
    const event = decodeVisionEvent(arucoComparison());
    if (event?.kind !== "aruco") throw new Error("expected an ArUco comparison event");

    expect(event.engines[0].engine).toBe("apriltag3");
    expect(event.engines[0].analysisMs).toBe(1.25);
    expect(event.engines[0].markers.map((candidate) => candidate.id)).toEqual([7]);
    expect(event.engines[0].markers[0]?.decisionMargin).toBe(37.75);
    expect(event.engines[1].engine).toBe("aruco-rs");
    expect(event.engines[1].analysisMs).toBe(2.5);
    expect(event.engines[1].markers.map((candidate) => candidate.id)).toEqual([8]);
    expect(event.engines[1].markers[0]?.decisionMargin).toBeUndefined();
  });

  test("rejects reordered engines and stale-looking error payloads", () => {
    const reordered = arucoComparison();
    const engines = reordered.engines as Record<string, unknown>[];
    [engines[0], engines[1]] = [engines[1]!, engines[0]!];
    expect(decodeVisionEvent(reordered)).toBeNull();

    const errorWithMarker = arucoComparison();
    const errorEngine = (errorWithMarker.engines as Record<string, unknown>[])[0]!;
    errorEngine.state = "error";
    errorEngine.detail = "detector failed";
    expect(decodeVisionEvent(errorWithMarker)).toBeNull();

    const readyWithDetail = arucoComparison();
    const readyEngine = (readyWithDetail.engines as Record<string, unknown>[])[1]!;
    readyEngine.detail = "previous-frame failure";
    expect(decodeVisionEvent(readyWithDetail)).toBeNull();
  });
});


describe("channel epochs", () => {
  test("rejects every callback from a disconnected or superseded session", () => {
    const epoch = createChannelEpoch();
    const first = epoch.begin();
    expect(epoch.accepts(first)).toBe(true);

    const second = epoch.begin();
    expect(epoch.accepts(first)).toBe(false);
    expect(epoch.accepts(second)).toBe(true);

    epoch.invalidate();
    expect(epoch.accepts(second)).toBe(false);
  });
});