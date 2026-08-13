//! Serialized Tello command exchange over the USB bulk record stream.

use std::io::{self, ErrorKind};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

use crate::bulk::{BulkTransport, CMD_PORT as BULK_CMD_PORT};

pub const CMD_PORT: u16 = BULK_CMD_PORT;
const KEEPALIVE_MS: u64 = 5_000;
const HANDSHAKE_GAP: Duration = Duration::from_millis(700);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const SHORT_TIMEOUT: Duration = Duration::from_secs(1);
const TICK: Duration = Duration::from_millis(250);

struct Inner {
    transport: Arc<BulkTransport>,
    /// The Tello protocol has no request id, so only one reply-bearing command
    /// may wait at a time. `send_now` intentionally bypasses this for `rc`.
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
    pub fn connect(transport: Arc<BulkTransport>) -> Tello {
        let inner = Arc::new(Inner {
            transport,
            io: Mutex::new(()),
            last_sent_ms: AtomicU64::new(now_ms()),
            keepalive: AtomicBool::new(false),
            running: AtomicBool::new(true),
        });
        let worker = spawn_keepalive(Arc::clone(&inner));
        Tello { inner, worker: Mutex::new(Some(worker)) }
    }

    pub fn send(&self, cmd: &str, timeout: Duration) -> io::Result<String> {
        let _serialised = self.inner.io.lock();
        self.inner.exchange(cmd, timeout)
    }

    pub fn send_now(&self, cmd: &str) -> io::Result<()> {
        self.inner.transport.send(CMD_PORT, cmd.as_bytes())?;
        self.inner.last_sent_ms.store(now_ms(), Ordering::Relaxed);
        Ok(())
    }

    pub fn start_stream(&self) -> io::Result<()> {
        self.send("command", HANDSHAKE_TIMEOUT)?;
        thread::sleep(HANDSHAKE_GAP);
        self.recycle_stream(HANDSHAKE_GAP)
    }

    pub fn recycle_stream(&self, gap: Duration) -> io::Result<()> {
        self.send("streamoff", HANDSHAKE_TIMEOUT)?;
        thread::sleep(gap);
        self.send("streamon", HANDSHAKE_TIMEOUT)?;
        Ok(())
    }

    pub fn stop_stream(&self) -> io::Result<()> {
        match self.send("streamoff", SHORT_TIMEOUT) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == ErrorKind::TimedOut => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn set_keepalive(&self, on: bool) {
        self.inner.keepalive.store(on, Ordering::Relaxed);
    }
}

impl Inner {
    fn exchange(&self, cmd: &str, timeout: Duration) -> io::Result<String> {
        // A reply that arrived after a timed-out exchange must not be attributed
        // to the next command. The serialization lock makes this safe.
        self.transport.discard_replies();
        self.transport.send(CMD_PORT, cmd.as_bytes())?;
        self.last_sent_ms.store(now_ms(), Ordering::Relaxed);
        let reply = self.transport.recv_reply(timeout).map_err(|error| {
            if error.kind() == ErrorKind::TimedOut {
                timed_out(cmd)
            } else {
                error
            }
        })?;
        Ok(String::from_utf8_lossy(&reply).trim().to_string())
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
            if now < last || now - last >= KEEPALIVE_MS {
                let _serialised = inner.io.lock();
                let _ = inner.exchange("battery?", SHORT_TIMEOUT);
            }
        }
    })
}

fn timed_out(cmd: &str) -> io::Error {
    io::Error::new(ErrorKind::TimedOut, format!("tello: no reply to \"{cmd}\""))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

impl Drop for Tello {
    fn drop(&mut self) {
        self.inner.running.store(false, Ordering::Relaxed);
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
        let _ = self.stop_stream();
    }
}
