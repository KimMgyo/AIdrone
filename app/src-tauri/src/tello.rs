//! Tello command link.
//!
//! One UDP socket bound to `0.0.0.0:8889` and pointed at the drone on the *same*
//! port. The Tello replies to the source port it was addressed from, so binding
//! 8889 locally is what makes replies land here at all; a socket on an ephemeral
//! port sends fine and never hears back. This is the arrangement the bench
//! instrument proved (`desktop/rx.ts:281`) and the reason the port appears twice.

use std::io::{self, ErrorKind};
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Public so the preflight in `lib.rs` binds the very port a session will
/// need, instead of a second copy of the number that could drift from this one.
pub const CMD_PORT: u16 = 8889;

/// The drone auto-lands after 15 s without a command, so idle chatter every 5 s
/// leaves room for two lost datagrams before that deadline instead of none.
const KEEPALIVE_MS: u64 = 5_000;

/// `streamoff` then `streamon`, 700 ms apart. Measured: a Tello that still
/// believes it is streaming from a previous run answers `ok` to `streamon` and
/// then sends nothing - 2 s of frames, then 118 dead seconds while the drone
/// happily reported `battery? 74`. Clearing the state costs 700 ms per step and
/// makes every run start from the same place. Neither step is optional.
const HANDSHAKE_GAP: Duration = Duration::from_millis(700);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

/// Shutdown and keepalive are not worth a long block: the outbound datagram is
/// the point, and `Drop` joins the worker through whichever of these is in
/// flight.
const SHORT_TIMEOUT: Duration = Duration::from_secs(1);

/// Worker wake interval. Finer than `KEEPALIVE_MS` so `Drop` is not held for a
/// whole keepalive period waiting to join.
const TICK: Duration = Duration::from_millis(250);

/// An MTU-sized reply buffer. Windows fails a `recv` outright (WSAEMSGSIZE) when
/// a datagram does not fit, so size it past anything the link can legally carry
/// rather than past the longest reply we happen to know about.
const REPLY_BUF: usize = 1500;

struct Inner {
    sock: UdpSocket,
    /// Guards nothing but exclusion: it exists so two callers cannot interleave
    /// a command with another's reply on a protocol with no request ids.
    io: Mutex<()>,
    last_sent_ms: AtomicU64,
    keepalive: AtomicBool,
    running: AtomicBool,
}

pub struct Tello {
    inner: Arc<Inner>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Tello {
    /// The peer carries a port because the local bind holds `CMD_PORT` on every
    /// interface: a simulator on this same host therefore cannot also own 8889,
    /// and sending to `127.0.0.1:8889` would just loop back into this socket.
    pub fn connect(peer: SocketAddrV4) -> io::Result<Tello> {
        let sock = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, CMD_PORT))?;
        // Connected, so the kernel drops datagrams from anything that is not the
        // drone and a plain `recv` is enough.
        sock.connect(peer)?;

        let inner = Arc::new(Inner {
            sock,
            io: Mutex::new(()),
            // Seeded to now: connecting is not a reason to fire a keepalive.
            last_sent_ms: AtomicU64::new(now_ms()),
            keepalive: AtomicBool::new(false),
            running: AtomicBool::new(true),
        });

        let worker = spawn_keepalive(Arc::clone(&inner));
        Ok(Tello {
            inner,
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Send `cmd` and block for the drone's reply, trimmed. On timeout the error
    /// names the command: a silent timeout is the most common failure on this
    /// link and an anonymous one is unreadable in a log.
    pub fn send(&self, cmd: &str, timeout: Duration) -> io::Result<String> {
        let _serialised = self.inner.lock_io();
        self.inner.exchange(cmd, timeout)
    }

    /// Send and return immediately: no `io` lock, no reply awaited.
    ///
    /// This exists for `rc a b c d`, the stick control, which the UI sends at
    /// 10 Hz and which a real Tello never answers - see `desktop/fake-tello.ts`,
    /// where `rc` deliberately replies with nothing. Routed through `send()`
    /// every stick update would block for the full CMD_TIMEOUT waiting for a
    /// reply that is never coming, and the whole control loop would queue
    /// behind whatever exchange happened to be in flight.
    ///
    /// Skipping the mutex is safe precisely because there is no reply:
    /// `UdpSocket::send` takes `&self`, so the write itself needs no
    /// exclusion, and a command that produces no datagram back leaves nothing
    /// for `exchange()`'s reply matching to mistake for its own. Do not reach
    /// for this with a command that answers.
    ///
    /// `last_sent_ms` is updated deliberately: the drone auto-lands after 15 s
    /// of silence and it does not care which command broke the silence, so an
    /// active stick is a keepalive and should suppress the redundant one.
    pub fn send_now(&self, cmd: &str) -> io::Result<()> {
        self.inner.sock.send(cmd.as_bytes())?;
        self.inner.last_sent_ms.store(now_ms(), Ordering::Relaxed);
        Ok(())
    }

    /// The measured 3-step handshake. Blocking, ~1.4 s plus reply latency.
    pub fn start_stream(&self) -> io::Result<()> {
        self.send("command", HANDSHAKE_TIMEOUT)?;
        thread::sleep(HANDSHAKE_GAP);
        self.recycle_stream(HANDSHAKE_GAP)
    }

    /// The off/on half of the handshake, with a caller-chosen settle time.
    /// `HANDSHAKE_GAP` is what a healthy drone needs; a drone whose last
    /// session was killed rather than closed sometimes needs several times
    /// that, so the caller that can see whether frames actually arrived gets
    /// to escalate. Never skip the `streamoff` - see `HANDSHAKE_GAP` for the
    /// 118 dead seconds it buys back.
    pub fn recycle_stream(&self, gap: Duration) -> io::Result<()> {
        self.send("streamoff", HANDSHAKE_TIMEOUT)?;
        thread::sleep(gap);
        self.send("streamon", HANDSHAKE_TIMEOUT)?;
        Ok(())
    }

    /// Best effort: the datagram leaving the host is what stops the stream, so a
    /// missing ack is not a failure worth reporting to a caller that is shutting down.
    pub fn stop_stream(&self) -> io::Result<()> {
        match self.send("streamoff", SHORT_TIMEOUT) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == ErrorKind::TimedOut => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn set_keepalive(&self, on: bool) {
        self.inner.keepalive.store(on, Ordering::Relaxed);
    }
}

impl Inner {
    /// A poisoned lock is still usable because it guards no data, and a panic
    /// somewhere else must not ground a drone that is currently in the air.
    fn lock_io(&self) -> MutexGuard<'_, ()> {
        self.io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Caller must hold `io`: a reply is matched to its command only by the fact
    /// that nothing else is allowed to be in flight.
    fn exchange(&self, cmd: &str, timeout: Duration) -> io::Result<String> {
        // Discard the late reply to a command that already timed out, which would
        // otherwise be handed to this caller as if it were theirs and skew every
        // exchange after it by one.
        self.drain();

        self.sock.send(cmd.as_bytes())?;
        self.last_sent_ms.store(now_ms(), Ordering::Relaxed);

        let deadline = Instant::now() + timeout;
        let mut buf = [0u8; REPLY_BUF];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(timed_out(cmd));
            }
            self.sock.set_read_timeout(Some(left))?;
            match self.sock.recv(&mut buf) {
                Ok(n) => return Ok(String::from_utf8_lossy(&buf[..n]).trim().to_string()),
                Err(e) => match e.kind() {
                    // The deadline: unix reports WouldBlock, windows TimedOut.
                    ErrorKind::WouldBlock | ErrorKind::TimedOut => return Err(timed_out(cmd)),
                    // Windows surfaces an earlier ICMP port-unreachable on the NEXT
                    // recv of a connected UDP socket. That only means the drone was
                    // not listening yet, so keep waiting out the caller's timeout.
                    ErrorKind::ConnectionReset => continue,
                    _ => return Err(e),
                },
            }
        }
    }

    fn drain(&self) {
        if self
            .sock
            .set_read_timeout(Some(Duration::from_millis(1)))
            .is_err()
        {
            return;
        }
        let mut scratch = [0u8; REPLY_BUF];
        // Bounded: a backlog longer than this is a flood, not a stale reply, and
        // draining it is not worth stalling the command that is waiting.
        for _ in 0..8 {
            if self.sock.recv(&mut scratch).is_err() {
                break;
            }
        }
    }
}

fn spawn_keepalive(inner: Arc<Inner>) -> JoinHandle<()> {
    thread::spawn(move || {
        while inner.running.load(Ordering::Relaxed) {
            thread::sleep(TICK);
            if !inner.keepalive.load(Ordering::Relaxed) {
                continue;
            }

            let now = now_ms();
            let last = inner.last_sent_ms.load(Ordering::Relaxed);
            // A backwards clock step must err toward sending: 15 s of real silence
            // auto-lands the drone, an extra `battery?` costs nothing.
            if !(now < last || now - last >= KEEPALIVE_MS) {
                continue;
            }

            let _serialised = inner.lock_io();
            // This thread is a safety mechanism, so a failed send is a reason to
            // try again in 5 s, never a reason to stop keeping the drone alive.
            let _ = inner.exchange("battery?", SHORT_TIMEOUT);
        }
    })
}

fn timed_out(cmd: &str) -> io::Error {
    io::Error::new(ErrorKind::TimedOut, format!("tello: no reply to \"{cmd}\""))
}

/// Epoch millis. A clock that will not read is reported as 0, which makes the
/// next keepalive check fire rather than skip - the safe direction.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Drop for Tello {
    fn drop(&mut self) {
        self.inner.running.store(false, Ordering::Relaxed);
        // Join before the final `streamoff` so the keepalive cannot slip a
        // command in behind it and leave the drone talking to nobody.
        let worker = self.worker.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = worker {
            let _ = handle.join();
        }
        let _ = self.stop_stream();
    }
}
