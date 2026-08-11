#!/usr/bin/env bun
// -----------------------------------------------------------------------------
// AIdrone Tello simulator - the drone's half of the link, on loopback.
//
//   bun fake-tello.ts                     answer SDK commands; stream on streamon
//   bun fake-tello.ts --fps 30 --bundle 2 pace it, and bundle arrivals like NCM
//   bun fake-tello.ts --state-port 8890   where the 10 Hz state line goes
//
// Why this exists: every latency number in this project cost drone battery,
// and a 502 ms receive-to-paint p50 went unexplained for a session because
// the pack it came off died before it could be re-run. Having a control that
// costs nothing settled it - the simulator read 4 ms where the drone read
// 502, which is what proved the app was innocent and the stream was not (the
// drone's SPS asks for a 12-frame DPB; see README, *Solved: the 502 ms
// reading was the decoder's DPB*). It also serves the smaller purpose: the
// budget can be re-measured against timing we control, with no drone, no
// cable, and no NIC setup.
//
// Point the app at it. The app's command socket binds 8889 on every interface,
// so the simulator cannot also own 8889 and `127.0.0.1:8889` would loop the app
// back into itself - hence the separate port (see tello.rs::connect):
//
//   AIDRONE_TELLO_ADDR=127.0.0.1:8899 AIDRONE_DEVICE_IP=127.0.0.1 <run the app>
//
// State telemetry is separate from video and behaves that way here: the first
// accepted `command` starts a 10 Hz `key:value;` line to udp/8890 and nothing
// ever stops it, because on a real drone `streamoff` takes the video and
// leaves the state broadcast running. The numbers move (see stateLine), so a
// panel wired to them can be told apart from a panel that is merely not
// crashing.
//
// The payload is a real H.264 elementary stream; nothing here synthesizes video.
// Make one shaped like the Tello's - baseline, no B-frames, ONE slice per
// picture - and this file will find it by default:
//
//   ffmpeg -f lavfi -i testsrc2=size=960x720:rate=30 -t 20 -c:v libx264 \
//     -profile:v baseline -pix_fmt yuv420p -tune zerolatency -b:v 1200k \
//     -x264-params bframes=0:keyint=60:min-keyint=60:scenecut=0:repeat-headers=1:sliced-threads=0:slices=1 \
//     -f h264 sample.h264
//
// `slices=1` is not cosmetic. With x264's default sliced threading one picture
// arrives as several slice NALs, the access-unit split below puts each on the
// wire as its own frame, and the decoder is handed partial pictures - which
// measures as a 4x frame rate at a quarter of the resolution's worth of data.
//
// Runs on Bun or Node: node:dgram and node:fs only, no dependencies.
// -----------------------------------------------------------------------------

import dgram from "node:dgram";
import { readFileSync } from "node:fs";

/// The Tello's own datagram size, and the receiver's frame delimiter: anything
/// short ends the frame. video.rs uses `>=`, so a frame whose length is an exact
/// multiple of this needs an explicit empty datagram to terminate - see send().
const CHUNK = 1460;

/// Where the app's LinkMonitor points its 1 Hz "I am alive" datagram. Nothing
/// needs to answer it; binding it only keeps the host from returning ICMP
/// port-unreachable, and lets the report line prove the app is still running.
const HEARTBEAT_PORT = 9998;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const file = arg("file", "sample.h264");
const host = arg("host", "127.0.0.1");
const cmdPort = Number(arg("cmd-port", "8899"));
const videoPort = Number(arg("video-port", "11111"));
const statePort = Number(arg("state-port", "8890"));
const fps = Number(arg("fps", "30"));
/// Frames released per tick. The USB-NCM path was measured delivering two video
/// frames inside one USB transfer, sub-millisecond apart, and the renderer used
/// to throw away 43% of the stream on exactly that pattern. 1 is a clean drone;
/// raise it to re-run that case on demand.
const bundle = Number(arg("bundle", "1"));
let battery = Number(arg("battery", "87"));

// --- the stream -------------------------------------------------------------

let bytes: Uint8Array;
try {
  bytes = new Uint8Array(readFileSync(file));
} catch {
  console.error(`no such stream: ${file}\ngenerate one with the ffmpeg recipe at the top of this file`);
  process.exit(1);
}

/** Byte offsets of every Annex-B start code: where it begins, and the NAL after it. */
function startCodes(bs: Uint8Array): Array<{ sc: number; nal: number }> {
  const out: Array<{ sc: number; nal: number }> = [];
  for (let i = 0; i + 2 < bs.length; ) {
    if (bs[i] === 0 && bs[i + 1] === 0 && bs[i + 2] === 1) {
      // A 4-byte code is a 3-byte code with one more leading zero; keep it with
      // the NAL so concatenating access units reproduces the file exactly.
      out.push({ sc: i > 0 && bs[i - 1] === 0 ? i - 1 : i, nal: i + 3 });
      i += 3;
    } else i++;
  }
  return out;
}

/**
 * Split into access units - one picture each, the unit the drone puts on the
 * wire and the unit the decoder wants. A new AU starts at a VCL NAL (types 1-5)
 * when the current one already holds one, which keeps each picture's SPS/PPS/SEI
 * attached to the picture they configure. Every AU is a view into the file, not
 * a copy.
 */
function accessUnits(bs: Uint8Array): Uint8Array[] {
  const codes = startCodes(bs);
  const out: Uint8Array[] = [];
  let start = codes.length > 0 ? codes[0]!.sc : 0;
  let hasVcl = false;

  for (let k = 0; k < codes.length; k++) {
    const type = bs[codes[k]!.nal]! & 0x1f;
    const vcl = type >= 1 && type <= 5;
    if (vcl && hasVcl) {
      out.push(bs.subarray(start, codes[k]!.sc));
      start = codes[k]!.sc;
      hasVcl = false;
    }
    hasVcl ||= vcl;
  }
  if (start < bs.length) out.push(bs.subarray(start));
  return out;
}

const frames = accessUnits(bytes);
if (frames.length === 0) {
  console.error(`${file}: no Annex-B start codes - not an H.264 elementary stream`);
  process.exit(1);
}

// --- sockets ----------------------------------------------------------------

const video = dgram.createSocket("udp4");
const cmd = dgram.createSocket("udp4");
const hb = dgram.createSocket("udp4");

const EMPTY = new Uint8Array(0);
let sentFrames = 0;
let sentBytes = 0;
let heartbeats = 0;
let streaming = false;
let timer: NodeJS.Timeout | undefined;
let cursor = 0;
const started = Date.now();

/** One access unit, fragmented the way the drone fragments it. */
function send(au: Uint8Array): void {
  for (let off = 0; off < au.length; off += CHUNK) {
    video.send(au.subarray(off, Math.min(off + CHUNK, au.length)), videoPort, host);
  }
  // An exact multiple of CHUNK ends on a full datagram, which the receiver reads
  // as "more to come". The drone's own frames end short; ours must too.
  if (au.length % CHUNK === 0) video.send(EMPTY, videoPort, host);
  sentFrames++;
  sentBytes += au.length;
}

/** Absolute-deadline pacing: setTimeout drift would otherwise compound into the fps. */
function pace(): void {
  const period = (1000 / fps) * bundle;
  let next = performance.now() + period;
  const tick = () => {
    if (!streaming) return;
    for (let i = 0; i < bundle; i++) send(frames[cursor++ % frames.length]!);
    next += period;
    timer = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  timer = setTimeout(tick, period);
}

function startStream(): void {
  if (streaming) return;
  streaming = true;
  pace();
}

function stopStream(): void {
  streaming = false;
  clearTimeout(timer);
  timer = undefined;
}

// --- state telemetry --------------------------------------------------------

/// The rate the drone broadcasts at, and the integration step below - one
/// number sets both, so they cannot drift apart.
const STATE_HZ = 10;

/// Where `takeoff` settles. A real Tello climbs to about a metre.
const CRUISE_CM = 120;

/// The SDK's own example line reads `tof:10` with the drone on the floor: the
/// downward sensor sees the gap under the hull, not zero.
const TOF_FLOOR_CM = 10;

/// `baro` is an absolute barometric altitude in cm, so it tracks h with an
/// offset rather than starting at zero. 404.71 is the value in that same line.
const BARO_BASE = 404.71;

const state = dgram.createSocket("udp4");
// Once the app disconnects, udp/8890 is closed and Windows answers the next
// send with an ICMP port-unreachable, which node raises as an 'error' event -
// unhandled, that is a crash. A drone keeps broadcasting into the void, so
// this does too.
state.on("error", () => {});

let stateTimer: NodeJS.Timeout | undefined;
let stateSent = 0;
let flying = false;
let motorTicks = 0;
let height = 0;
let climb = 0;

/// One integration step, deliberately not a flight model: 12% of the remaining
/// distance per tick, snapped once inside the last centimetre. That is ~3.8 s
/// floor to cruise and the same back, close enough to a real takeoff, and the
/// snap is what makes `land` reach h:0 exactly instead of approaching it for
/// another eight seconds. h, tof, baro and vgz are all read off this one
/// number, so they cannot contradict each other.
function step(): void {
  if (flying) motorTicks++;
  const prev = height;
  const target = flying ? CRUISE_CM : 0;
  height = Math.abs(target - height) < 1 ? target : height + (target - height) * 0.12;
  climb = (height - prev) * STATE_HZ;
}

/// The real SDK line: all 16 documented fields, in the documented order,
/// `;`-separated and CRLF-terminated. Attitude oscillates even on the ground -
/// a resting airframe still reports its tilt, and a panel of frozen zeros
/// cannot be told from a broken one - but velocity is zero until something is
/// flying.
function stateLine(): string {
  const t = (Date.now() - started) / 1000;
  const h = Math.round(height);
  const moving = flying ? 1 : 0;
  const f2 = (n: number) => n.toFixed(2);
  const board = 40 + Math.round(Math.sin(t * 0.2));
  return (
    `pitch:${Math.round(3 * Math.sin(t * 0.7))};` +
    `roll:${Math.round(2 * Math.cos(t * 0.5))};` +
    `yaw:${Math.round(((t * 12) % 360) - 180)};` +
    `vgx:${moving * Math.round(4 * Math.sin(t * 0.7))};` +
    `vgy:${moving * Math.round(3 * Math.cos(t * 0.5))};` +
    `vgz:${Math.round(climb)};` +
    `templ:${board};` +
    `temph:${board + 2};` +
    `tof:${h + TOF_FLOOR_CM};` +
    `h:${h};` +
    `bat:${battery};` +
    `baro:${f2(BARO_BASE + height)};` +
    `time:${Math.floor(motorTicks / STATE_HZ)};` +
    `agx:${f2(12 * Math.sin(t * 3.1))};` +
    `agy:${f2(12 * Math.cos(t * 2.7))};` +
    `agz:${f2(-1000 + 8 * Math.sin(t * 4.3))};` +
    "\r\n"
  );
}

/// Starts on the first accepted `command` and never stops. Paced off an
/// absolute deadline like the video sender: setTimeout drift would otherwise
/// land in the app's own staleness readout, which is measured against this.
function startState(): void {
  if (stateTimer) return;
  const period = 1000 / STATE_HZ;
  let next = performance.now() + period;
  const tick = () => {
    step();
    state.send(stateLine(), statePort, host);
    stateSent++;
    next += period;
    stateTimer = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  stateTimer = setTimeout(tick, period);
  console.log(`[sim] state on udp/${statePort} at ${STATE_HZ} Hz`);
}

/** cm, and degrees. The real SDK answers `error` outside these, and a fixture
 *  that answered `ok` to everything could not prove a UI clamps its inputs. */
const RANGE: Record<string, [number, number]> = {
  up: [20, 500], down: [20, 500], left: [20, 500], right: [20, 500],
  forward: [20, 500], back: [20, 500],
  cw: [1, 360], ccw: [1, 360],
};

/** The SDK surface the app actually drives, plus enough to answer a human probing it. */
function reply(text: string): string | null {
  const [verb] = text.split(" ");
  switch (verb) {
    case "command":
      // State starts on the first accepted `command`, as on the drone.
      startState();
      return "ok";
    case "streamon":
      startStream();
      return "ok";
    case "streamoff":
      stopStream();
      return "ok";
    case "battery?":
      return String(battery);
    case "time?":
      return String(Math.floor((Date.now() - started) / 1000));
    case "sdk?":
      return "20";
    case "wifi?":
      return "90";
    // Stick control is fire-and-forget on a real Tello - no reply, ever. A
    // simulator that answers would hide a client that waits for one.
    case "rc":
      return null;
    case "takeoff":
      flying = true;
      return "ok";
    case "land":
      flying = false;
      return "ok";
    case "emergency":
      // Motors cut: the airframe is on the floor, not easing down to it.
      flying = false;
      height = 0;
      climb = 0;
      return "ok";
    // One-argument motion. Answering these is what lets a control panel be
    // driven end to end without a drone on the bench.
    case "up": case "down": case "left": case "right":
    case "forward": case "back": case "cw": case "ccw": {
      const [lo, hi] = RANGE[verb];
      const n = Number(text.split(" ")[1]);
      return Number.isInteger(n) && n >= lo && n <= hi ? "ok" : "error";
    }
    default:
      return `unknown command: ${text}`;
  }
}

cmd.on("message", (msg, from) => {
  const text = msg.toString().trim();
  const out = reply(text);
  console.log(`  <- ${text}${out === null ? "  (no reply, as on the drone)" : `  -> ${out}`}`);
  if (out !== null) cmd.send(out, from.port, from.address);
});

hb.on("message", () => void heartbeats++);

cmd.bind(cmdPort, () => console.log(`[sim] SDK on udp/${cmdPort}`));
hb.bind(HEARTBEAT_PORT, () => console.log(`[sim] heartbeat sink on udp/${HEARTBEAT_PORT}`));

const totalBytes = frames.reduce((n, f) => n + f.length, 0);
console.log(
  `[sim] ${file}: ${frames.length} frames, ${(totalBytes / 1024).toFixed(0)} KB, ` +
    `${(totalBytes / frames.length).toFixed(0)} B/frame avg -> ${host}:${videoPort} ` +
    `at ${fps} fps${bundle > 1 ? ` in bundles of ${bundle}` : ""}`,
);
console.log(`[sim] state -> ${host}:${statePort} at ${STATE_HZ} Hz once \`command\` lands`);
console.log(`[sim] waiting for streamon`);

// 1 Hz, the same shape as rx.ts and the ESP32 console so three logs can be read
// side by side.
let lastFrames = 0;
let lastBytes = 0;
let lastState = 0;
let lastAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const ms = now - lastAt;
  const f = sentFrames - lastFrames;
  const b = sentBytes - lastBytes;
  const s = stateSent - lastState;
  lastFrames = sentFrames;
  lastBytes = sentBytes;
  lastState = stateSent;
  lastAt = now;
  // Drains a percent every 30 s: it makes a long run look like a real one, and
  // gives the low-battery case a way to be replayed. The state line's `bat`
  // reads this same variable, so `battery?` and the telemetry can never
  // disagree the way two independent counters eventually would.
  if (Math.floor((now - started) / 30_000) > Math.floor((now - started - ms) / 30_000)) battery = Math.max(0, battery - 1);
  console.log(
    `[sim] ${streaming ? "stream" : "idle  "} ` +
      `tx=${f}f ${((b * 8) / ms / 1000).toFixed(2)}Mb/s  state=${s}/s  ` +
      `hb=${heartbeats}  bat=${battery}%`,
  );
}, 1000).unref?.();

process.on("SIGINT", () => {
  stopStream();
  // The only thing that ever stops the state broadcast - the simulator's
  // equivalent of pulling the battery.
  clearTimeout(stateTimer);
  console.log(
    `\n[sim] ${sentFrames} frames, ${(sentBytes / 1024).toFixed(0)} KB, ` +
      `${stateSent} state lines, ${heartbeats} heartbeats`,
  );
  process.exit(0);
});
