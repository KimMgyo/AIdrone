import { describe, expect, test } from "bun:test";
import { createNativeVisionAdapter } from "./aruco.ts";
import type { VisionArucoEvent, VisionArucoMarker } from "../transport.ts";

function marker(id: number, decisionMargin?: number): VisionArucoMarker {
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

function observation(markers: readonly VisionArucoMarker[]): VisionArucoEvent {
  return {
    kind: "aruco",
    recvEpochUs: 42,
    width: 960,
    height: 720,
    family: "ARUCO_MIP_36h12",
    state: "ready",
    analysisMs: 1,
    markers,
  };
}

describe("NativeVisionStateAdapter ArUco observations", () => {
  test("only a marker in the current frame is selectable, and geometry never outlives it", () => {
    const vision = createNativeVisionAdapter();
    vision.setSessionLive(true);
    vision.setMode("aruco");
    vision.accept(observation([marker(7, 36.5)]));

    let snapshot = vision.arucoSnapshot();
    expect(snapshot.markers.map((candidate) => candidate.id)).toEqual([7]);
    expect(snapshot.markers[0]?.decisionMargin).toBe(36.5);

    // A marker this frame does not carry cannot be locked.
    vision.setArucoTarget(8);
    expect(vision.arucoSnapshot().target.id).toBeNull();

    vision.setArucoTarget(7);
    snapshot = vision.arucoSnapshot();
    expect(snapshot.target.id).toBe(7);
    expect(snapshot.target.marker?.id).toBe(7);

    // A later frame without that marker must not retain the old geometry. The
    // lock survives; the position does not.
    vision.accept(observation([]));
    snapshot = vision.arucoSnapshot();
    expect(snapshot.markers).toEqual([]);
    expect(snapshot.target.marker).toBeNull();
    expect(snapshot.target.state).toBe("searching");
  });

  test("projects a detector error as an empty current result", () => {
    const vision = createNativeVisionAdapter();
    vision.setSessionLive(true);
    vision.setMode("aruco");
    vision.accept({
      kind: "aruco",
      recvEpochUs: 99,
      width: 960,
      height: 720,
      family: "ARUCO_MIP_36h12",
      state: "error",
      analysisMs: 3,
      detail: "AprilTag failed",
      markers: [],
    });

    const snapshot = vision.arucoSnapshot();
    expect(snapshot.markers).toEqual([]);
    expect(snapshot.analysisMs).toBeNull();
    expect(snapshot.target.state).toBe("error");
    expect(snapshot.observation?.detail).toBe("AprilTag failed");
  });
});
