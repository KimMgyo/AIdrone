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

function comparison(
  primaryMarkers: readonly VisionArucoMarker[],
  arucoMarkers: readonly VisionArucoMarker[],
): VisionArucoEvent {
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
        analysisMs: 1,
        markers: primaryMarkers,
      },
      {
        engine: "aruco-rs",
        family: "ARUCO_MIP_36h12",
        state: "ready",
        analysisMs: 2,
        markers: arucoMarkers,
      },
    ],
  };
}

describe("NativeVisionStateAdapter ArUco comparisons", () => {
  test("projects only the AprilTag 3 result into selection and overlay state", () => {
    const vision = createNativeVisionAdapter();
    vision.setSessionLive(true);
    vision.setMode("aruco");
    vision.accept(comparison([marker(7, 36.5)], [marker(8)]));

    let snapshot = vision.arucoSnapshot();
    expect(snapshot.markers.map((candidate) => candidate.id)).toEqual([7]);
    expect(snapshot.markers[0]?.decisionMargin).toBe(36.5);
    expect(snapshot.comparison?.engines[1].markers.map((candidate) => candidate.id)).toEqual([8]);

    // A marker only the comparison engine sees is not selectable.
    vision.setArucoTarget(8);
    expect(vision.arucoSnapshot().target.id).toBeNull();

    vision.setArucoTarget(7);
    snapshot = vision.arucoSnapshot();
    expect(snapshot.target.id).toBe(7);
    expect(snapshot.target.marker?.id).toBe(7);

    // A later frame without that marker must not retain the old geometry.
    vision.accept(comparison([], [marker(7)]));
    snapshot = vision.arucoSnapshot();
    expect(snapshot.markers).toEqual([]);
    expect(snapshot.target.marker).toBeNull();
    expect(snapshot.target.state).toBe("searching");
  });

  test("projects a primary-engine error as an empty current result", () => {
    const vision = createNativeVisionAdapter();
    vision.setSessionLive(true);
    vision.setMode("aruco");
    vision.accept({
      kind: "aruco",
      recvEpochUs: 99,
      width: 960,
      height: 720,
      engines: [
        {
          engine: "apriltag3",
          family: "ARUCO_MIP_36h12",
          state: "error",
          analysisMs: 3,
          detail: "AprilTag failed",
          markers: [],
        },
        {
          engine: "aruco-rs",
          family: "ARUCO_MIP_36h12",
          state: "ready",
          analysisMs: 2,
          markers: [marker(7)],
        },
      ],
    });

    const snapshot = vision.arucoSnapshot();
    expect(snapshot.markers).toEqual([]);
    expect(snapshot.analysisMs).toBeNull();
    expect(snapshot.target.state).toBe("error");
    expect(snapshot.comparison?.engines[0].detail).toBe("AprilTag failed");
  });
});
