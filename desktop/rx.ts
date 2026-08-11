#!/usr/bin/env bun
// -----------------------------------------------------------------------------
// AIdrone measurement receiver - the host half of the USB-NCM experiment.
//
//   bun rx.ts bench                 measure the USB link in isolation
//   bun rx.ts video [--ip A.B.C.D]  measure the real Tello stream end to end
//   bun rx.ts probe                 no traffic; just prove the NIC is alive
//
// Runs unmodified on Windows 11 and Ubuntu with either Bun or Node (it uses
// node:dgram, not Bun.udpSocket). No dependencies.
//
// Prerequisite on both OSes: give the "AIdrone NCM" adapter a STATIC address
// of 192.168.4.50/24 with NO gateway. The ESP32's DHCP server lives on the
// Wi-Fi side and serves the Tello; the L2 shuttle deliberately does not feed
// host frames into the ESP32's own IP stack, because the zero-copy lwIP input
// path would alias a TinyUSB buffer that is recycled the moment the callback
// returns.
// -----------------------------------------------------------------------------

import dgram from "node:dgram";
import { appendFileSync } from "node:fs";

const BENCH_PORT = 9999;
const VIDEO_PORT = 11111;
const TELLO_CMD_PORT = 8889;
const MAGIC = 0x52444941; // "AIDR" little-endian

type Mode = "bench" | "video" | "probe";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const mode = (process.argv[2] as Mode) ?? "bench";
const csvPath = arg("csv");
const durationS = Number(arg("for", "0"));

function csv(line: string) {
  if (csvPath) appendFileSync(csvPath, line + "\n");
}

const fmtRate = (bytes: number, ms: number) =>
  ms > 0 ? `${((bytes * 8) / ms / 1000).toFixed(2)}Mb/s` : "0.00Mb/s";

const finishers: Array<() => void> = [];
const onDone = (fn: () => void) => finishers.push(fn);
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  for (const f of finishers) f();
  setTimeout(() => process.exit(0), 250).unref?.();
}
process.on("SIGINT", finish);

// The device cannot see a dead host NCM datapath on its own (see ncm.h: the host
// keeps accepting frames at full rate while the adapter reads Disconnected, and
// "no host frames" cannot be told apart from an idle host). We can. Every
// measuring mode sends one small datagram a second at the ESP32 -- nothing
// listens on the far side and nothing needs to; the point is that WE are
// provably alive and transmitting, so if nothing comes back for this long while
// the device console still shows frames leaving, the host datapath is the
// failure and not the drone.
const DEVICE_IP = arg("dev", "192.168.4.1")!;
const HEARTBEAT_PORT = 9998;

// Above the measured transient. Windows swallows short bursts of NCM traffic and
// recovers on its own: during a clean 90 s video run the host saw zero packets
// for exactly 6 s (t=42..47) while the device console showed 132 frames/s
// arriving and 132/s leaving over USB, no ring drops -- then it resumed at full
// rate with nothing intervening. A verdict at 6 s would cry wolf at that, and a
// device-side watchdog would have turned a self-healing 6 s hiccup into a 3 s
// forced outage on top. 10 s means "this is not the hiccup".
const SILENT_VERDICT_S = 10;

// `received` returns a monotonic count of datagrams this mode has taken in.
function startHeartbeat(received: () => number): void {
  const hb = dgram.createSocket("udp4");
  hb.unref(); // never hold the process open
  let mark = received();
  let silent = 0;
  let sawTraffic = false;
  let verdictGiven = false;
  const beat = () => {
    hb.send(Buffer.from("AIDR-HB"), HEARTBEAT_PORT, DEVICE_IP, () => {});
    const now = received();
    if (now !== mark) {
      mark = now;
      silent = 0;
      sawTraffic = true;
      verdictGiven = false;
      return;
    }
    // Before the first packet, silence only means the far end has not started -
    // the generator is idle, or the Tello has not begun streaming. Only a stream
    // that WAS arriving and stopped is evidence of the failure.
    if (!sawTraffic || ++silent < SILENT_VERDICT_S || verdictGiven) return;
    verdictGiven = true;
    console.log(
      `\n[!] ${silent}s with zero packets after a live stream, while still heartbeating ${DEVICE_IP}.` +
        `\n    If the ESP32 console still shows "usb tx=" climbing, the host NIC is the dead end:` +
        `\n    confirm with  powershell -File nicstate.ps1  (Status=Disconnected / 0 bps), then cure it` +
        `\n    with  x  on the ESP32 console (3 s USB bounce) or  nic-restart.ps1.\n`,
    );
  };
  const timer = setInterval(beat, 1000);
  timer.unref?.();
  beat();
  onDone(() => {
    clearInterval(timer);
    hb.close();
  });
}

// -----------------------------------------------------------------------------
// bench: synthetic stream with sequence numbers and a device timestamp.
//
// The device clock's offset from ours is unknown and irrelevant. What matters
// is its VARIATION: the smallest (host_recv - device_send) seen over the run is
// the best case the link ever achieved, so every packet's excess over that
// minimum is queueing delay actually suffered. That number, not the raw offset,
// is what a control loop feels.
// -----------------------------------------------------------------------------
function runBench() {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  let pkts = 0, bytes = 0, bad = 0;
  let lost = 0, reordered = 0, dupes = 0;
  let expect = -1, highest = -1;
  let offsetMin = Infinity;
  let delayMax = 0, delaySum = 0, delayN = 0;
  let gapMax = 0, lastRx = 0;
  let totPkts = 0, totLost = 0, totBytes = 0;
  const t0 = Date.now();

  // Genuine reordering on a single UDP path across a USB link is a handful of
  // packets at most. A seq this far below expect means the device-side generator
  // restarted its counter -- every `b <rate>` command does -- not that anything
  // arrived out of order.
  const kSeqRestartWindow = 64;

  sock.on("message", (buf) => {
    const now = Date.now();
    if (lastRx) gapMax = Math.max(gapMax, now - lastRx);
    lastRx = now;

    bytes += buf.length;
    if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC) {
      bad++;
      return;
    }
    pkts++;
    const seq = buf.readUInt32LE(4);
    const devMs = buf.readUInt32LE(8);

    const offset = now - devMs;
    if (offset < offsetMin) offsetMin = offset;
    const delay = offset - offsetMin;
    if (delay > delayMax) delayMax = delay;
    delaySum += delay;
    delayN++;

    if (expect < 0) {
      expect = seq + 1;
      highest = seq;
      return;
    }
    if (seq + kSeqRestartWindow < expect) {
      // New generator run: re-baseline instead of filing ~10 s worth of packets
      // as "reordered", which also silently cancelled real loss below.
      expect = seq + 1;
      highest = seq;
      return;
    }
    if (seq === expect) {
      expect = seq + 1;
      if (seq > highest) highest = seq;
    } else if (seq > expect) {
      lost += seq - expect; // provisional: a later arrival un-counts it
      expect = seq + 1;
      highest = seq;
    } else {
      if (seq === highest) dupes++;
      else {
        reordered++;
        if (lost > 0) lost--;
      }
    }
  });

  sock.on("listening", () => {
    sock.setBroadcast(true);
    console.log(`[bench] listening 0.0.0.0:${BENCH_PORT} - start the generator with "b 5000" on the ESP32 console`);
    csv("t_s,pkts,lost,loss_pct,mbps,delay_avg_ms,delay_max_ms,gap_max_ms,reorder,dup,bad");
  });

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    const sent = pkts + lost;
    const lossPct = sent > 0 ? (lost / sent) * 100 : 0;
    const avg = delayN > 0 ? delaySum / delayN : 0;
    const t = ((now - t0) / 1000).toFixed(0);

    console.log(
      `[${t.padStart(4)}s] rx=${String(pkts).padStart(5)}p ${fmtRate(bytes, dt).padStart(9)}` +
        ` loss=${lossPct.toFixed(2).padStart(5)}% (${lost})` +
        ` delay avg=${avg.toFixed(1)}ms max=${delayMax.toFixed(0)}ms` +
        ` gap=${gapMax}ms reorder=${reordered} dup=${dupes}${bad ? ` bad=${bad}` : ""}`,
    );
    csv(`${t},${pkts},${lost},${lossPct.toFixed(3)},${((bytes * 8) / dt / 1000).toFixed(3)},${avg.toFixed(2)},${delayMax},${gapMax},${reordered},${dupes},${bad}`);

    totPkts += pkts;
    totLost += lost;
    totBytes += bytes;
    pkts = 0; bytes = 0; lost = 0; reordered = 0; dupes = 0; bad = 0;
    delayMax = 0; delaySum = 0; delayN = 0; gapMax = 0;
  }, 1000);

  onDone(() => {
    const secs = (Date.now() - t0) / 1000;
    const sent = totPkts + totLost;
    console.log(
      `\n[total] ${secs.toFixed(0)}s  rx=${totPkts}p  lost=${totLost}` +
        ` (${sent ? ((totLost / sent) * 100).toFixed(3) : "0"}%)  avg=${fmtRate(totBytes, secs * 1000)}`,
    );
  });

  startHeartbeat(() => totPkts + pkts);
  sock.bind(BENCH_PORT);
}

// -----------------------------------------------------------------------------
// video: the real thing. Drives the Tello over UDP:8889 and measures the
// H.264 stream landing on :11111.
//
// The Tello chunks each frame into 1460-byte datagrams and terminates it with a
// short one, so frame boundaries - and therefore fps and per-frame size - are
// directly observable without decoding anything.
// -----------------------------------------------------------------------------
function runVideo() {
  const telloIp = arg("ip", "192.168.4.2")!;
  const video = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const cmd = dgram.createSocket({ type: "udp4", reuseAddr: true });

  let pkts = 0, bytes = 0, frames = 0, frameBytes = 0, cur = 0;
  let gapMax = 0, lastRx = 0, frameMax = 0;
  let totFrames = 0, totBytes = 0;
  const t0 = Date.now();

  video.on("message", (buf) => {
    const now = Date.now();
    if (lastRx) gapMax = Math.max(gapMax, now - lastRx);
    lastRx = now;
    pkts++;
    bytes += buf.length;
    cur += buf.length;
    if (buf.length < 1460) {
      frames++;
      frameBytes += cur;
      if (cur > frameMax) frameMax = cur;
      cur = 0;
    }
  });

  cmd.on("message", (buf, rinfo) => {
    console.log(`[tello] ${rinfo.address}: ${buf.toString().trim()}`);
  });

  const send = (s: string) => {
    cmd.send(s, TELLO_CMD_PORT, telloIp, (e) => {
      if (e) console.error(`[tello] send "${s}" failed:`, e.message);
    });
    console.log(`[tello] -> ${s}`);
  };

  cmd.bind(TELLO_CMD_PORT, () => {
    console.log(`[video] driving Tello at ${telloIp}`);
    // streamoff first, always. A Tello that still believes it is streaming from a
    // previous run answers "ok" to streamon and then sends nothing -- measured:
    // two seconds of frames, then a dead 118 s while the drone reported battery
    // 74% and the USB link stayed clean. Clearing the state costs 700 ms and
    // makes every run start from the same place.
    send("command");
    setTimeout(() => send("streamoff"), 700);
    setTimeout(() => send("streamon"), 1400);
    if (has("bitrate")) setTimeout(() => send(`setbitrate ${arg("bitrate", "0")}`), 2100);
  });

  video.on("listening", () => {
    console.log(`[video] listening 0.0.0.0:${VIDEO_PORT}`);
    csv("t_s,pkts,frames,mbps,fps,avg_frame_b,max_frame_b,gap_max_ms");
  });

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    const fps = (frames * 1000) / dt;
    const avgFrame = frames > 0 ? frameBytes / frames : 0;
    const t = ((now - t0) / 1000).toFixed(0);

    console.log(
      `[${t.padStart(4)}s] rx=${String(pkts).padStart(5)}p ${fmtRate(bytes, dt).padStart(9)}` +
        ` fps=${fps.toFixed(1).padStart(5)} frame avg=${(avgFrame / 1024).toFixed(1)}k max=${(frameMax / 1024).toFixed(1)}k` +
        ` gap=${gapMax}ms`,
    );
    csv(`${t},${pkts},${frames},${((bytes * 8) / dt / 1000).toFixed(3)},${fps.toFixed(2)},${avgFrame.toFixed(0)},${frameMax},${gapMax}`);

    totFrames += frames;
    totBytes += bytes;
    pkts = 0; bytes = 0; frames = 0; frameBytes = 0; frameMax = 0; gapMax = 0;
  }, 1000);

  onDone(() => {
    const secs = (Date.now() - t0) / 1000;
    console.log(`\n[total] ${secs.toFixed(0)}s  frames=${totFrames} (${(totFrames / secs).toFixed(1)} fps avg)  ${fmtRate(totBytes, secs * 1000)}`);
    send("streamoff");
  });

  startHeartbeat(() => totBytes + bytes); // monotonic: any datagram moves it
  video.bind(VIDEO_PORT);
}

// -----------------------------------------------------------------------------
// probe: no drone, no generator - just confirm the NIC carries frames at all.
// It broadcasts a ping every second and reports anything that comes back, which
// is enough to tell a dead adapter from a misconfigured address.
// -----------------------------------------------------------------------------
function runProbe() {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("message", (buf, r) => console.log(`[probe] ${r.address}:${r.port} ${buf.length}B`));
  sock.on("listening", () => {
    sock.setBroadcast(true);
    console.log(`[probe] bound :${BENCH_PORT}; broadcasting to 192.168.4.255 every 1s`);
    setInterval(() => sock.send("AIdrone probe", BENCH_PORT, "192.168.4.255"), 1000);
  });
  sock.bind(BENCH_PORT);
}

// Windows has no real signals: `process.kill(self, "SIGINT")` terminates
// outright instead of raising a handler, so a --for run would never print its
// summary. Route both the timer and a genuine console Ctrl-C (which Node does
// map to a SIGINT event on Windows) through the same finisher instead.
if (durationS > 0) setTimeout(finish, durationS * 1000);

switch (mode) {
  case "bench": runBench(); break;
  case "video": runVideo(); break;
  case "probe": runProbe(); break;
  default:
    console.error(`unknown mode "${mode}" - use bench | video | probe`);
    process.exit(1);
}
