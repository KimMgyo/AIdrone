// -----------------------------------------------------------------------------
// video.rs - the Tello H.264 stream, reassembled off UDP:11111.
//
// One thread owns the socket, glues datagrams back into Annex-B frames and hands
// each finished frame to a sink. Nothing here decodes and nothing here knows
// about Tauri; the WebView does the decoding.
//
// Measured load (README): 25 fps, ~5.6 KB per frame, 1.16 Mb/s, ~131 datagrams a
// second, on a link whose loss-free ceiling is 4.86 Mb/s. At 4x headroom one
// Vec<u8> allocation per frame is free, so the reassembly buffer is a plain Vec
// and there is no arena.
// -----------------------------------------------------------------------------

use std::io::{self, ErrorKind};
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The Tello chunks every frame into 1460-byte datagrams and terminates it with
/// one short datagram (desktop/rx.ts:262), which is how frame boundaries - and
/// therefore fps - are known without decoding anything.
///
/// The test is strictly "less than": a datagram of EXACTLY 1460 continues the
/// frame. Treating 1460 as terminal ends most frames a datagram early, which
/// reports roughly double the frame rate at half the frame size and emits
/// nothing but truncated fragments - the failure is silent, because the counters
/// still look plausible.
const DATAGRAM_FULL: usize = 1460;

/// 1460 is the largest payload the Tello sends, so this can never truncate - and
/// it must not: a UDP recv with too small a buffer discards the overflow (and on
/// Windows fails the call with WSAEMSGSIZE) rather than returning a short read.
const RECV_BUF: usize = 2048;

/// Only ever the size of the FIRST frame's allocation: each completed frame's
/// capacity is carried into its successor, so the buffer settles at the largest
/// frame seen and stops reallocating. 8 KB covers the measured ~5.6 KB typical
/// frame; a 720p IDR is 20-40 KB (README) and grows the carried capacity once.
const FRAME_CAP_HINT: usize = 8 * 1024;

/// Bounds how long stop() waits. The loop can only observe the stop flag between
/// receives, so without a timeout a silent stream - exactly the case worth
/// aborting - would pin the thread in recv_from forever.
const READ_TIMEOUT: Duration = Duration::from_millis(200);

/// One transport-delimited Annex-B H.264 byte batch.
///
/// A short UDP datagram is useful for bounding this buffer but does not prove a
/// picture or NAL boundary. The vision branch must reframe `data` before giving
/// it to FFmpeg; the WebView has its own incremental Annex-B reassembler.
///
/// Deliberately not Serialize: these bytes cross to the WebView as a binary
/// payload. Rendering 5.6 KB as a JSON array of integers every 40 ms would cost
/// more than the decode it feeds.
pub struct Frame {
    pub data: Vec<u8>,
    /// Wall-clock microseconds since the UNIX epoch, stamped when the LAST
    /// datagram of this batch arrived.
    ///
    /// Epoch time and not an Instant because the consumer is the WebView, which
    /// can only subtract this from its own clock to get end-to-end latency. A
    /// monotonic stamp is meaningless once it leaves this process.
    pub recv_epoch_us: u64,
}

/// Cumulative since start(). Rates are the reader's job: sample twice and
/// divide, the way rx.ts printed a line a second.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct VideoStats {
    pub frames: u64,
    pub pkts: u64,
    pub bytes: u64,
    /// Largest completed frame in bytes - the IDR size, in practice.
    pub frame_max: usize,
    /// Largest gap between consecutive datagram arrivals. This is the jitter
    /// indicator the bench used: the link fills its 64 KB ring before it drops
    /// anything, so standing queue shows up here ~11 s before loss does.
    pub gap_max_ms: u64,
    pub last_frame_epoch_us: u64,
}

/// Written only by the receive thread, read by anyone. Relaxed throughout: these
/// are diagnostics, not synchronisation, and nothing downstream orders anything
/// against them.
#[derive(Default)]
struct Counters {
    /// Its own Arc so link.rs can hold the counter directly instead of polling
    /// through stats(); everything else here is private to this module.
    frames: Arc<AtomicU64>,
    pkts: AtomicU64,
    bytes: AtomicU64,
    frame_max: AtomicU64,
    gap_max_ms: AtomicU64,
    last_frame_epoch_us: AtomicU64,
}

pub struct VideoReceiver {
    counters: Arc<Counters>,
    running: Arc<AtomicBool>,
    /// Taken by the first stop(); a second stop(), or the Drop that follows one,
    /// finds None and joins nothing.
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl VideoReceiver {
    /// Binds 0.0.0.0:`bind_port` (11111 for the Tello) and starts receiving.
    ///
    /// `sink` is called on the receive thread, once per completed frame.
    pub fn start<F: Fn(Frame) + Send + 'static>(
        bind_port: u16,
        sink: F,
    ) -> io::Result<VideoReceiver> {
        let sock = UdpSocket::bind(("0.0.0.0", bind_port))?;
        sock.set_read_timeout(Some(READ_TIMEOUT))?;

        let counters = Arc::new(Counters::default());
        let running = Arc::new(AtomicBool::new(true));

        let worker = {
            let counters = Arc::clone(&counters);
            let running = Arc::clone(&running);
            // Named so a panic inside the sink names the guilty thread.
            thread::Builder::new()
                .name("video-rx".into())
                .spawn(move || recv_loop(sock, counters, running, sink))?
        };

        Ok(VideoReceiver {
            counters,
            running,
            worker: Mutex::new(Some(worker)),
        })
    }

    /// A snapshot, not a transaction: the six counters are loaded one at a time
    /// and can disagree by a datagram. On a 25 fps stream that is cheaper than
    /// being exactly right, and never blocks the receive loop.
    pub fn stats(&self) -> VideoStats {
        let c = &self.counters;
        VideoStats {
            frames: c.frames.load(Ordering::Relaxed),
            pkts: c.pkts.load(Ordering::Relaxed),
            bytes: c.bytes.load(Ordering::Relaxed),
            frame_max: c.frame_max.load(Ordering::Relaxed) as usize,
            gap_max_ms: c.gap_max_ms.load(Ordering::Relaxed),
            last_frame_epoch_us: c.last_frame_epoch_us.load(Ordering::Relaxed),
        }
    }

    /// The live frame counter, for link.rs: "frames were arriving and then
    /// stopped" is the whole dead-datapath verdict, and watching one atomic
    /// beats rebuilding a VideoStats once a second.
    pub fn frame_counter(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.counters.frames)
    }

    /// Idempotent. Blocks up to one READ_TIMEOUT while the thread notices the
    /// flag, then joins it - so once this returns the sink provably cannot be
    /// called again, which is what lets the caller drop what the sink captured.
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        // Poison-tolerant: stop() must survive being called twice and then again
        // from Drop, and a poisoned lock here would only mean stop() itself
        // panicked - the handle is still the thing that needs joining.
        let handle = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(h) = handle {
            // Err only says the sink panicked; the thread is gone either way.
            let _ = h.join();
        }
    }
}

impl Drop for VideoReceiver {
    fn drop(&mut self) {
        self.stop();
    }
}

fn recv_loop<F: Fn(Frame)>(
    sock: UdpSocket,
    counters: Arc<Counters>,
    running: Arc<AtomicBool>,
    sink: F,
) {
    // One buffer for the life of the thread: the hot path allocates per frame
    // (~25/s), never per datagram (~131/s).
    let mut buf = [0u8; RECV_BUF];
    let mut frame: Vec<u8> = Vec::with_capacity(FRAME_CAP_HINT);
    let mut last_rx: Option<Instant> = None;

    while running.load(Ordering::Relaxed) {
        let n = match sock.recv_from(&mut buf) {
            Ok((n, _)) => n,
            Err(e) => match e.kind() {
                // The read timeout expiring is the normal idle case - it is what
                // lets this loop see the stop flag at all. Unix reports it as
                // WouldBlock, Windows as TimedOut; EINTR is the same non-event.
                ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted => continue,
                // Windows delivers WSAECONNRESET to a UDP recv when an earlier
                // datagram from this socket drew an ICMP port-unreachable. The
                // socket is fine; quitting here would kill the stream over an
                // ICMP from something we do not even talk to.
                ErrorKind::ConnectionReset => continue,
                // Anything else means the socket is gone and no amount of
                // looping brings it back. Leave; the counters simply stop
                // advancing, which is precisely what link.rs is watching for.
                _ => break,
            },
        };

        let now = Instant::now();
        if let Some(prev) = last_rx {
            let gap = now.saturating_duration_since(prev).as_millis() as u64;
            counters.gap_max_ms.fetch_max(gap, Ordering::Relaxed);
        }
        last_rx = Some(now);

        counters.pkts.fetch_add(1, Ordering::Relaxed);
        counters.bytes.fetch_add(n as u64, Ordering::Relaxed);
        frame.extend_from_slice(&buf[..n]);

        // A full-size datagram is mid-frame. See DATAGRAM_FULL: `>=`, not `>`.
        if n >= DATAGRAM_FULL {
            continue;
        }
        // A zero-length datagram on an empty buffer terminates nothing, and an
        // empty chunk is something the decoder cannot be handed.
        if frame.is_empty() {
            continue;
        }

        // Stamp the end of this bounded transport batch. An Annex-B parser
        // downstream decides when its bytes form a decodable access unit.
        let recv_epoch_us = epoch_us();

        // Hand the batch away and keep its capacity for the next one.
        let cap = frame.capacity();
        let data = std::mem::replace(&mut frame, Vec::with_capacity(cap));

        counters
            .frame_max
            .fetch_max(data.len() as u64, Ordering::Relaxed);
        counters
            .last_frame_epoch_us
            .store(recv_epoch_us, Ordering::Relaxed);
        // Before the sink, so a slow consumer cannot make link.rs think the
        // datapath died.
        counters.frames.fetch_add(1, Ordering::Relaxed);

        // Runs on this thread: a sink that blocks stops the receiver. The socket
        // buffer absorbs ~450 ms at the measured 1.16 Mb/s, past which a slow
        // sink shows up as loss rather than as backpressure.
        sink(Frame {
            data,
            recv_epoch_us,
        });
    }
}

/// Microseconds since the UNIX epoch. A clock set before 1970 yields 0 rather
/// than an error nobody could act on.
fn epoch_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}
