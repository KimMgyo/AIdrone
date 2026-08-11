import { describe, expect, test } from "bun:test";
import { createNativeVisionAdapter, type NativeVisionAdapter } from "./aruco.ts";
import { decodeVisionEvent, type VisionPersonDetection, type VisionPersonEvent } from "../transport.ts";

function detection(trackId: number, x: number, y: number, width = 80): VisionPersonDetection {
  return { trackId, confidence: 0.9, x, y, width, height: 200 };
}

function personEvent(detections: readonly VisionPersonDetection[]): VisionPersonEvent {
  return {
    kind: "person",
    recvEpochUs: 42,
    width: 960,
    height: 720,
    analysisMs: 12.5,
    detections,
  };
}

function livePersonAdapter(): NativeVisionAdapter {
  const vision = createNativeVisionAdapter();
  vision.setSessionLive(true);
  vision.setMode("person");
  return vision;
}

describe("NativeVisionStateAdapter person target", () => {
  test("follows whoever is nearest, by box area, with no selection", () => {
    const vision = livePersonAdapter();
    vision.accept(personEvent([detection(3, 100, 50, 80), detection(4, 400, 60, 200)]));

    const snapshot = vision.personSnapshot();
    expect(snapshot.target.id).toBe(4);
    expect(snapshot.target.state).toBe("detected");
    expect(snapshot.target.detection?.width).toBe(200);
  });

  test("hands the target over the moment someone else is nearer", () => {
    const vision = livePersonAdapter();
    vision.accept(personEvent([detection(3, 100, 50, 200), detection(4, 400, 60, 80)]));
    expect(vision.personSnapshot().target.id).toBe(3);

    // 4 walks closer. Nothing is "held": the nearest person is the target, and
    // that is the whole rule.
    vision.accept(personEvent([detection(3, 100, 50, 80), detection(4, 400, 60, 260)]));
    expect(vision.personSnapshot().target.id).toBe(4);
  });

  test("an empty frame is a search, not a stale box", () => {
    const vision = livePersonAdapter();
    vision.accept(personEvent([detection(3, 100, 50)]));
    expect(vision.personSnapshot().target.state).toBe("detected");

    vision.accept(personEvent([]));
    const snapshot = vision.personSnapshot();
    expect(snapshot.target.id).toBeNull();
    expect(snapshot.target.detection).toBeNull();
    expect(snapshot.target.state).toBe("searching");
  });

  test("a mode change, a session end and a non-ready status all drop the target", () => {
    const vision = livePersonAdapter();
    vision.accept(personEvent([detection(3, 100, 50)]));
    vision.setMode("aruco");
    vision.setMode("person");
    expect(vision.personSnapshot().target.id).toBeNull();
    expect(vision.personSnapshot().target.state).toBe("waitingFrame");

    vision.accept(personEvent([detection(3, 100, 50)]));
    vision.setSessionLive(false);
    expect(vision.personSnapshot().target.id).toBeNull();
    expect(vision.personSnapshot().target.state).toBe("inactive");

    vision.setSessionLive(true);
    vision.accept(personEvent([detection(3, 100, 50)]));
    vision.accept({ kind: "status", mode: "person", state: "waitingFrame" });
    const snapshot = vision.personSnapshot();
    expect(snapshot.target.id).toBeNull();
    expect(snapshot.detections).toEqual([]);
    expect(snapshot.target.state).toBe("waitingFrame");
  });

  test("reports the native error status through the target state", () => {
    const vision = livePersonAdapter();
    vision.accept({ kind: "status", mode: "person", state: "error", detail: "ort session failed" });
    expect(vision.personSnapshot().target.state).toBe("error");
  });
});

describe("decodeVisionEvent person track ids", () => {
  test("accepts a well-formed detection and exposes its track id", () => {
    const decoded = decodeVisionEvent({
      kind: "person",
      recvEpochUs: 42,
      width: 960,
      height: 720,
      analysisMs: 12.5,
      detections: [{ trackId: 11, confidence: 0.87, x: 10, y: 20, width: 30, height: 40 }],
    });
    expect(decoded).toEqual(personEvent([{ trackId: 11, confidence: 0.87, x: 10, y: 20, width: 30, height: 40 }]));
  });

  test("rejects the whole event when two detections repeat a track id", () => {
    expect(
      decodeVisionEvent({
        kind: "person",
        recvEpochUs: 42,
        width: 960,
        height: 720,
        analysisMs: 12.5,
        detections: [
          { trackId: 5, confidence: 0.9, x: 10, y: 20, width: 30, height: 40 },
          { trackId: 5, confidence: 0.5, x: 90, y: 20, width: 30, height: 40 },
        ],
      }),
    ).toBeNull();
  });

  test("rejects a detection whose track id is missing or not a nonnegative integer", () => {
    for (const trackId of [undefined, -1, 1.5, "3", Number.NaN]) {
      expect(
        decodeVisionEvent({
          kind: "person",
          recvEpochUs: 42,
          width: 960,
          height: 720,
          analysisMs: 12.5,
          detections: [{ ...(trackId === undefined ? {} : { trackId }), confidence: 0.9, x: 1, y: 2, width: 3, height: 4 }],
        }),
      ).toBeNull();
    }
  });

  /**
   * The seam neither side can check alone. This object is the literal serde
   * output pinned by `vision::tests::person_detection_serializes_with_a_track_id`
   * in `src-tauri/src/vision.rs`; if either half renames a field, exactly one
   * of the two tests goes red instead of the app silently dropping every
   * person event at runtime.
   */
  test("decodes the exact object serde emits for one Rust PersonDetection", () => {
    const decoded = decodeVisionEvent({
      kind: "person",
      recvEpochUs: 42,
      width: 960,
      height: 720,
      analysisMs: 12.5,
      detections: [{ trackId: 7, confidence: 0.5, x: 1.0, y: 2.0, width: 3.0, height: 4.0 }],
    });
    expect(decoded).toEqual(personEvent([{ trackId: 7, confidence: 0.5, x: 1, y: 2, width: 3, height: 4 }]));
  });
});
