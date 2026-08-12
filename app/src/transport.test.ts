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

function arucoFrame(): Record<string, unknown> {
  return {
    kind: "aruco",
    recvEpochUs: 42,
    width: 960,
    height: 720,
    family: "ARUCO_MIP_36h12",
    state: "ready",
    analysisMs: 1.25,
    markers: [marker(7, 37.75)],
  };
}

describe("decodeVisionEvent ArUco frames", () => {
  test("accepts a well-formed marker observation", () => {
    const event = decodeVisionEvent(arucoFrame());
    if (event?.kind !== "aruco") throw new Error("expected an ArUco event");

    expect(event.state).toBe("ready");
    expect(event.analysisMs).toBe(1.25);
    expect(event.markers.map((candidate) => candidate.id)).toEqual([7]);
    expect(event.markers[0]?.decisionMargin).toBe(37.75);
  });

  test("refuses the whole frame rather than a plausible-looking marker", () => {
    // An error result carrying markers, and a healthy one carrying a stale
    // detail, both mean the producer is not the one this decoder was written
    // against - and a marker id here can lock a follow loop.
    const errorWithMarker = arucoFrame();
    errorWithMarker.state = "error";
    errorWithMarker.detail = "detector failed";
    expect(decodeVisionEvent(errorWithMarker)).toBeNull();

    const readyWithDetail = arucoFrame();
    readyWithDetail.detail = "previous-frame failure";
    expect(decodeVisionEvent(readyWithDetail)).toBeNull();

    const duplicateIds = arucoFrame();
    duplicateIds.markers = [marker(7, 1), marker(7, 2)];
    expect(decodeVisionEvent(duplicateIds)).toBeNull();

    const wrongFamily = arucoFrame();
    wrongFamily.family = "ARUCO_ORIGINAL";
    expect(decodeVisionEvent(wrongFamily)).toBeNull();
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