//! Tello state telemetry, off UDP:8890.
//!
//! Once `command` has been accepted the drone broadcasts one ASCII line at
//! ~10 Hz, `key:value;` pairs terminated by CRLF:
//!
//! ```text
//! pitch:0;roll:0;yaw:0;vgx:0;vgy:0;vgz:0;templ:40;temph:42;tof:10;h:0;bat:87;baro:404.71;time:0;agx:-3.00;agy:0.00;agz:-999.00;
//! ```
//!
//! One thread owns the socket and hands each line to a sink as a JSON object -
//! the same arrangement `video.rs` uses for frames, for the same reason:
//! nothing here knows about Tauri, and the sink is the only thing that does.
//!
//! The socket is bound, never connected. The drone sends state from its own
//! command port, so a `connect` would have to name that exact source address -
//! which is not the address anything else here talks to, and is not the
//! simulator's either. A plain bound socket is what every Tello client uses.

use std::io::{self, ErrorKind};
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// The documented line is ~150 bytes and a firmware that adds fields only
/// grows it. Sized well past that because Windows fails a `recv` outright
/// (WSAEMSGSIZE) when a datagram does not fit, rather than returning a short
/// read - the same hazard `tello.rs::REPLY_BUF` is sized against.
const RECV_BUF: usize = 2048;

/// Bounds how long `stop()` waits. The loop can only observe the stop flag
/// between receives, so without a timeout a drone that stopped broadcasting -
/// exactly the case worth abandoning - would pin the thread in `recv_from`
/// forever. Half a second is five missed datagrams at 10 Hz, which nothing
/// downstream can act on anyway.
const READ_TIMEOUT: Duration = Duration::from_millis(500);

pub struct StateReceiver {
    datagrams: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
    /// Taken by the first stop(); a second stop(), or the Drop that follows
    /// one, finds None and joins nothing.
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl StateReceiver {
    /// Binds 0.0.0.0:`bind_port` (8890 for the Tello) and starts receiving.
    ///
    /// `sink` is called on the receive thread, once per parsed line. Lines
    /// that carry no usable field never reach it.
    pub fn start<F: Fn(Value) + Send + 'static>(
        bind_port: u16,
        sink: F,
    ) -> io::Result<StateReceiver> {
        let sock = UdpSocket::bind(("0.0.0.0", bind_port))?;
        sock.set_read_timeout(Some(READ_TIMEOUT))?;

        let datagrams = Arc::new(AtomicU64::new(0));
        let running = Arc::new(AtomicBool::new(true));

        let worker = {
            let datagrams = Arc::clone(&datagrams);
            let running = Arc::clone(&running);
            // Named so a panic inside the sink names the guilty thread.
            thread::Builder::new()
                .name("state-rx".into())
                .spawn(move || recv_loop(sock, datagrams, running, sink))?
        };

        Ok(StateReceiver {
            datagrams,
            running,
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Datagrams seen since start(), parsed or not.
    ///
    /// Nothing reads it yet - the 1 Hz telemetry frame is the video receiver's
    /// and its shape is fixed on the webview side. It is here because it is the
    /// only evidence distinguishing "8890 bound, drone silent" from "8890 bound,
    /// drone sending fields we drop", and the counter has to exist before
    /// anyone can ask the question.
    #[allow(dead_code)]
    pub fn datagrams(&self) -> u64 {
        self.datagrams.load(Ordering::Relaxed)
    }

    /// Idempotent. Blocks up to one READ_TIMEOUT while the thread notices the
    /// flag, then joins it - so once this returns the sink provably cannot be
    /// called again, which is what lets the caller drop what the sink captured.
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        // Poison-tolerant: stop() must survive being called twice and then
        // again from Drop, and a poisoned lock here would only mean stop()
        // itself panicked - the handle is still the thing that needs joining.
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

impl Drop for StateReceiver {
    fn drop(&mut self) {
        self.stop();
    }
}

fn recv_loop<F: Fn(Value)>(
    sock: UdpSocket,
    datagrams: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
    sink: F,
) {
    // One buffer for the life of the thread. Everything past it allocates -
    // a Map and a short String per field - but sixteen of those ten times a
    // second is nothing beside the video path in the same process.
    let mut buf = [0u8; RECV_BUF];

    while running.load(Ordering::Relaxed) {
        let n = match sock.recv_from(&mut buf) {
            Ok((n, _)) => n,
            Err(e) => match e.kind() {
                // The read timeout expiring is the normal idle case - it is
                // what lets this loop see the stop flag at all. Unix reports it
                // as WouldBlock, Windows as TimedOut; EINTR is the same
                // non-event.
                ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted => continue,
                // Windows delivers WSAECONNRESET to a UDP recv when an earlier
                // datagram from this socket drew an ICMP port-unreachable. The
                // socket is fine, and this one never sends, so the ICMP was
                // provoked by something else on the host entirely.
                ErrorKind::ConnectionReset => continue,
                // Anything else means the socket is gone and no amount of
                // looping brings it back.
                _ => break,
            },
        };

        datagrams.fetch_add(1, Ordering::Relaxed);

        // Stamped before the parse, so the age the UI greys the panel out on is
        // the age of the measurement rather than of the work done with it.
        let recv_epoch_us = epoch_us();

        // Lossy rather than strict: the payload is ASCII, and a byte that is
        // not should cost its own field, not the fifteen good ones beside it.
        if let Some(value) = parse(&String::from_utf8_lossy(&buf[..n]), recv_epoch_us) {
            // Runs on this thread, as in video.rs: a sink that blocks stops
            // the receiver. A default 64 KB socket buffer holds ~430 of these
            // ~150-byte lines, so a stall has ~40 s before it costs anything.
            sink(value);
        }
    }
}

/// One state line into a JSON object, or None if nothing in it parsed.
///
/// Keys pass through as they arrive instead of being matched against the 16
/// documented fields: firmware revisions add fields, and a parser that admits
/// only what it already knows about is how the new one goes missing with
/// nobody noticing. Malformed pairs are skipped rather than fatal - a
/// truncated datagram should cost its own fields and no others.
fn parse(line: &str, recv_epoch_us: u64) -> Option<Value> {
    let mut obj = Map::new();

    for pair in line.split(';') {
        // Split on the FIRST colon: the key is everything before it, whatever
        // the value turns out to contain. A value with a colon of its own then
        // fails the number parse below and costs only itself.
        let Some((key, raw)) = pair.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let Ok(n) = raw.trim().parse::<f64>() else {
            continue;
        };
        // Integral values go out as integers. The SDK is inconsistent about
        // it - `bat:87` sits beside `agx:-3.00` - and a UI that has to strip a
        // trailing `.0` per cell is a UI that will forget to somewhere.
        let value = if n.fract() == 0.0 {
            Value::from(n as i64)
        } else {
            // from_f64 refuses NaN and infinity, which JSON cannot hold. It is
            // also the only place they can be caught: `fract()` on either is
            // NaN, so neither reaches the integer branch.
            match serde_json::Number::from_f64(n) {
                Some(num) => Value::Number(num),
                None => continue,
            }
        };
        obj.insert(key.to_string(), value);
    }

    // Garbage in: an object holding nothing but a timestamp reads downstream as
    // a fresh, complete state, which is worse than no update at all.
    if obj.is_empty() {
        return None;
    }

    obj.insert("recvEpochUs".into(), Value::from(recv_epoch_us));
    Some(Value::Object(obj))
}

/// Microseconds since the UNIX epoch, stamped the way `video.rs` stamps a
/// frame: the consumer is the WebView, which can only subtract this from its
/// own clock. A clock set before 1970 yields 0 rather than an error nobody
/// could act on.
fn epoch_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}
