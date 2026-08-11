import { test, expect, describe } from "bun:test";
import { H264Stream, nalFromBatchTail, splitAnnexBNals, spsToCodecString, type AnnexBNal } from "./h264decode.ts";

/**
 * Unit tests for the pure Annex-B NAL-unit splitter and SPS codec-string
 * derivation, plus `H264Stream`'s recovery from a dead decoder - the last of
 * which is driven against a stand-in `VideoDecoder`, because the real one
 * needs a browser and the behaviour under test is precisely what happens
 * after WebCodecs closes it.
 */

const SC3 = [0x00, 0x00, 0x01]; // 3-byte start code
const SC4 = [0x00, 0x00, 0x00, 0x01]; // 4-byte start code

/** Builds a fake NAL: header byte encodes nal_ref_idc=3, type=`type`. */
function nalHeader(type: number): number {
  return (3 << 5) | type; // forbidden_zero_bit=0, nal_ref_idc=3
}

describe("splitAnnexBNals", () => {
  test("single complete NAL (3-byte start code) in one chunk -> withheld until a next start code arrives", () => {
    // Annex-B has no length prefix -- a trailing NAL is never "complete"
    // until the NEXT start code is seen, so a lone NAL yields zero NALs and
    // everything held in `rest`.
    const chunk = new Uint8Array([...SC3, nalHeader(1), 0xaa, 0xbb, 0xcc]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(0);
    expect(Array.from(rest)).toEqual(Array.from(chunk));
  });

  test("two complete NALs (4-byte start codes) in one chunk -> first NAL returned, second withheld", () => {
    const nal1 = [nalHeader(7), 0x11, 0x22];
    const nal2 = [nalHeader(1), 0x33, 0x44, 0x55];
    const chunk = new Uint8Array([...SC4, ...nal1, ...SC4, ...nal2]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(1);
    expect(nals[0]!.type).toBe(7);
    expect(Array.from(nals[0]!.data)).toEqual(nal1);
    expect(Array.from(rest)).toEqual([...SC4, ...nal2]);
  });

  test("three NALs, mixed 3-byte and 4-byte start codes, all in one chunk -> first two returned in order", () => {
    const sps = [nalHeader(7), 0x01];
    const pps = [nalHeader(8), 0x02];
    const slice = [nalHeader(5), 0x03, 0x04];
    const chunk = new Uint8Array([...SC4, ...sps, ...SC3, ...pps, ...SC3, ...slice]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(2);
    expect(nals[0]!.type).toBe(7);
    expect(Array.from(nals[0]!.data)).toEqual(sps);
    expect(nals[1]!.type).toBe(8);
    expect(Array.from(nals[1]!.data)).toEqual(pps);
    expect(Array.from(rest)).toEqual([...SC3, ...slice]);
  });

  test("NAL payload split across two chunks -> first call withholds it, second call completes it", () => {
    const nal1 = [nalHeader(1), 0xaa, 0xbb, 0xcc, 0xdd];
    const nal2 = [nalHeader(1), 0xee];
    const full = new Uint8Array([...SC3, ...nal1, ...SC3, ...nal2]);
    const chunk1 = full.slice(0, 5); // start code + partial nal1 payload
    const chunk2 = full.slice(5); // rest of nal1 + start code + nal2

    const first = splitAnnexBNals(new Uint8Array(0), chunk1);
    expect(first.nals.length).toBe(0);
    expect(Array.from(first.rest)).toEqual(Array.from(chunk1));

    const second = splitAnnexBNals(first.rest, chunk2);
    expect(second.nals.length).toBe(1);
    expect(second.nals[0]!.type).toBe(1);
    expect(Array.from(second.nals[0]!.data)).toEqual(nal1);
    expect(Array.from(second.rest)).toEqual([...SC3, ...nal2]);
  });

  test("3-byte start code split across chunk boundary (1 byte in, 2 out) -> reassembled, not dropped or duplicated", () => {
    const nal1 = [nalHeader(1), 0x01];
    const nal2 = [nalHeader(1), 0x02];
    const full = new Uint8Array([...SC3, ...nal1, ...SC3, ...nal2]);
    // Split the SECOND start code (index 4..6) right after its first byte.
    const splitAt = 3 + nal1.length + 1;
    const chunk1 = full.slice(0, splitAt);
    const chunk2 = full.slice(splitAt);

    const first = splitAnnexBNals(new Uint8Array(0), chunk1);
    expect(first.nals.length).toBe(0); // nal1 not complete yet -- its terminating start code hasn't fully arrived

    const second = splitAnnexBNals(first.rest, chunk2);
    expect(second.nals.length).toBe(1);
    expect(Array.from(second.nals[0]!.data)).toEqual(nal1);
    expect(Array.from(second.rest)).toEqual([...SC3, ...nal2]);
  });

  test("4-byte start code split byte-by-byte across four chunks -> still reassembled correctly", () => {
    const nal1 = [nalHeader(5), 0x01, 0x02];
    const nal2 = [nalHeader(1), 0x03];
    const full = new Uint8Array([...SC4, ...nal1, ...SC4, ...nal2]);

    let pending: Uint8Array = new Uint8Array(0);
    let nalsFound: AnnexBNal[] = [];
    // Feed one byte at a time through the whole buffer.
    for (let i = 0; i < full.length; i++) {
      const { nals, rest } = splitAnnexBNals(pending, full.slice(i, i + 1));
      nalsFound = nalsFound.concat(nals);
      pending = rest;
    }
    expect(nalsFound.length).toBe(1);
    expect(Array.from(nalsFound[0]!.data)).toEqual(nal1);
    expect(Array.from(pending)).toEqual([...SC4, ...nal2]);
  });

  test("garbage bytes before the first start code are dropped, never surfaced as a NAL", () => {
    const nal1 = [nalHeader(1), 0x9];
    const chunk = new Uint8Array([0xde, 0xad, 0xbe, 0xef, ...SC3, ...nal1, ...SC3]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(1);
    expect(Array.from(nals[0]!.data)).toEqual(nal1);
    expect(Array.from(rest)).toEqual(SC3);
  });

  test("no start code anywhere -> no NALs, non-zero-prefixed garbage fully dropped", () => {
    const chunk = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(0);
    expect(rest.length).toBe(0);
  });

  test("trailing zero bytes with no start code yet -> kept as a potential start-code prefix", () => {
    const chunk = new Uint8Array([0xaa, 0xbb, 0x00, 0x00]);
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(0);
    expect(Array.from(rest)).toEqual([0x00, 0x00]);
  });

  test("empty chunk -> no NALs, rest unchanged from pending", () => {
    const { nals, rest } = splitAnnexBNals(new Uint8Array(0), new Uint8Array(0));
    expect(nals.length).toBe(0);
    expect(rest.length).toBe(0);
  });

  test("empty (zero-length) NAL between two adjacent start codes is silently skipped, not emitted", () => {
    const nal2 = [nalHeader(1), 0x7];
    const chunk = new Uint8Array([...SC3, ...SC3, ...nal2, ...SC3]);
    const { nals } = splitAnnexBNals(new Uint8Array(0), chunk);
    expect(nals.length).toBe(1);
    expect(Array.from(nals[0]!.data)).toEqual(nal2);
  });
});

describe("spsToCodecString", () => {
  test("no-escaping-needed SPS -> avc1.PPCCLL directly from profile/constraint/level bytes", () => {
    const sps = new Uint8Array([nalHeader(7), 0x42, 0xc0, 0x1e]);
    expect(spsToCodecString(sps)).toBe("avc1.42c01e");
  });

  test("SPS requiring emulation-prevention removal -> reads the DE-ESCAPED bytes, not the raw ones", () => {
    // Semantic RBSP (post-header): profile=0x00, constraint=0x00, level=0x01
    // -- "00 00 01" must be escaped in the real Annex-B byte stream to
    // "00 00 03 01" per H.264 7.4.1.1, or it would be indistinguishable
    // from a start code. Reading the wrong (still-escaped) bytes would
    // yield "avc1.000003" instead of the correct "avc1.000001".
    const escapedSps = new Uint8Array([nalHeader(7), 0x00, 0x00, 0x03, 0x01]);
    expect(spsToCodecString(escapedSps)).toBe("avc1.000001");
  });

  test("throws on an SPS too short to contain profile/constraint/level", () => {
    expect(() => spsToCodecString(new Uint8Array([nalHeader(7), 0x42]))).toThrow();
  });
});

type FakeDecoder = {
  state: "unconfigured" | "configured" | "closed";
  chunks: { type: string; timestamp: number }[];
  fail: () => void;
};

/** Installs a stand-in WebCodecs pair and returns every decoder it builds. */
function stubWebCodecs(): { built: FakeDecoder[]; restore: () => void } {
  const built: FakeDecoder[] = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  const priorDecoder = globals.VideoDecoder;
  const priorChunk = globals.EncodedVideoChunk;

  globals.EncodedVideoChunk = class {
    readonly type: string;
    readonly timestamp: number;
    constructor(init: { type: string; timestamp: number }) {
      this.type = init.type;
      this.timestamp = init.timestamp;
    }
  };
  globals.VideoDecoder = class {
    state: FakeDecoder["state"] = "unconfigured";
    chunks: { type: string; timestamp: number }[] = [];
    private readonly onError: (e: Error) => void;
    constructor(init: { output: (frame: unknown) => void; error: (e: Error) => void }) {
      this.onError = init.error;
      built.push(this as unknown as FakeDecoder);
    }
    configure(): void {
      this.state = "configured";
    }
    decode(chunk: { type: string; timestamp: number }): void {
      if (this.state !== "configured") throw new Error("decode on a closed decoder");
      this.chunks.push(chunk);
    }
    close(): void {
      this.state = "closed";
    }
    /** What WebCodecs does to itself on a decode error. */
    fail(): void {
      this.state = "closed";
      this.onError(new Error("simulated decode failure"));
    }
  };

  return {
    built,
    restore(): void {
      globals.VideoDecoder = priorDecoder;
      globals.EncodedVideoChunk = priorChunk;
    },
  };
}

const SPS = [nalHeader(7), 0x42, 0xc0, 0x1e];
const PPS = [nalHeader(8), 0x01];

/** One access unit, terminated by the start code of whatever follows it. */
function accessUnit(keyframe: boolean): number[] {
  const slice = [nalHeader(keyframe ? 5 : 1), 0x11, 0x22];
  return keyframe ? [...SC4, ...SPS, ...SC4, ...PPS, ...SC4, ...slice] : [...SC4, ...slice];
}

describe("H264Stream decoder recovery", () => {
  test("rebuilds the decoder at the next keyframe after WebCodecs closes it", () => {
    const codecs = stubWebCodecs();
    const errors: Error[] = [];
    try {
      const stream = new H264Stream({ onFrame: () => {}, onError: (e) => errors.push(e) });

      // A keyframe configures the first decoder; the delta that follows
      // terminates it and is decoded in turn.
      stream.push(new Uint8Array([...accessUnit(true), ...accessUnit(false)]));
      stream.push(new Uint8Array(accessUnit(false)));
      expect(codecs.built.length).toBe(1);
      expect(codecs.built[0]?.chunks.length).toBeGreaterThan(0);

      // WebCodecs errors and closes itself, as it does on a corrupt packet.
      codecs.built[0]?.fail();
      expect(errors.length).toBe(1);

      // Deltas alone must NOT rebuild: decoding them against a reference the
      // new decoder never saw is how a freeze turns into green blocks.
      stream.push(new Uint8Array(accessUnit(false)));
      stream.push(new Uint8Array(accessUnit(false)));
      expect(codecs.built.length).toBe(1);

      // The next IDR does rebuild, and the picture comes back.
      stream.push(new Uint8Array([...accessUnit(true), ...accessUnit(false)]));
      expect(codecs.built.length).toBe(2);
      expect(codecs.built[1]?.state).toBe("configured");
      expect(codecs.built[1]?.chunks.length).toBeGreaterThan(0);
      expect(codecs.built[1]?.chunks[0]?.type).toBe("key");
    } finally {
      codecs.restore();
    }
  });
});

describe("end-of-batch flush", () => {
  test("the NAL a batch ends on is complete, and its own arrival stamps it", () => {
    const codecs = stubWebCodecs();
    try {
      const stream = new H264Stream({ onFrame: () => {}, onError: () => {} });

      // Exactly the drone's shape: one picture per transport batch, and the
      // slice is the last NAL in it. Without the boundary, picture N waits for
      // picture N+1 to arrive - a whole frame of latency, and then N is
      // stamped with N+1's arrival so no measurement can see the wait.
      stream.push(new Uint8Array(accessUnit(true)), 1_000, true);
      stream.push(new Uint8Array(accessUnit(false)), 34_000, true);

      const chunks = codecs.built[0]?.chunks ?? [];
      expect(chunks.length).toBe(2);
      expect(chunks[0]?.type).toBe("key");
      expect(chunks[0]?.timestamp).toBe(1_000);
      expect(chunks[1]?.type).toBe("delta");
      expect(chunks[1]?.timestamp).toBe(34_000);
    } finally {
      codecs.restore();
    }
  });

  test("without the boundary a trailing slice still waits for the next start code", () => {
    const codecs = stubWebCodecs();
    try {
      const stream = new H264Stream({ onFrame: () => {}, onError: () => {} });
      stream.push(new Uint8Array(accessUnit(true)), 1_000);
      // The IDR is the batch's last NAL, so nothing is decodable yet.
      expect(codecs.built.length).toBe(0);
    } finally {
      codecs.restore();
    }
  });
});

describe("nalFromBatchTail", () => {
  test("reads the NAL type and strips either start code", () => {
    expect(nalFromBatchTail(new Uint8Array([...SC4, nalHeader(5), 0x11]))?.type).toBe(5);
    expect(nalFromBatchTail(new Uint8Array([...SC3, nalHeader(1), 0x11]))?.type).toBe(1);
  });

  test("refuses anything that is not a whole NAL", () => {
    // A partial start code, a start code with no payload, and stream garbage:
    // handing any of these to a decoder is worse than waiting.
    expect(nalFromBatchTail(new Uint8Array([0x00, 0x00]))).toBeNull();
    expect(nalFromBatchTail(new Uint8Array(SC4))).toBeNull();
    expect(nalFromBatchTail(new Uint8Array([0xaa, 0xbb]))).toBeNull();
    expect(nalFromBatchTail(new Uint8Array(0))).toBeNull();
  });
});
