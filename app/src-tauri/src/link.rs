//! USB-NCM datapath watchdog.
//!
//! The device cannot see a dead host datapath on its own: the host keeps
//! accepting NCM frames at full rate while the adapter reads Disconnected, and
//! "no host frames" is indistinguishable from an idle host. We can see it, from
//! this side, by pairing two facts - that this host is provably transmitting,
//! and that nothing is coming back. Port of `startHeartbeat` in `desktop/rx.ts`.

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const HEARTBEAT_PORT: u16 = 9998;
const HEARTBEAT: &[u8] = b"AIDR-HB";

/// 10 s, not 3, and never lower. During a clean 90 s video run the host saw zero
/// packets for exactly 6 s (t=42..47) while the device console showed 132
/// frames/s arriving and 132/s leaving over USB with no ring drops, then resumed
/// at full rate with nothing intervening. A verdict at 6 s cries wolf at a
/// transient Windows heals by itself.
const SILENT_VERDICT_S: u64 = 10;

const TICK: Duration = Duration::from_secs(1);

/// The tick is slept in slices so `stop` is answered in ~100 ms instead of
/// holding app shutdown for a whole beat.
const SLICE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkEvent {
    Silent { seconds: u64 },
    Recovered,
}

pub struct LinkMonitor {
    running: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl LinkMonitor {
    /// `frames_received` is any monotonic counter of arrivals; only its movement
    /// between ticks is read, never its value, so the video receiver's own frame
    /// count serves without coordination.
    pub fn start<F: Fn(LinkEvent) + Send + 'static>(
        device_ip: Ipv4Addr,
        frames_received: Arc<AtomicU64>,
        on_event: F,
    ) -> io::Result<LinkMonitor> {
        // Bound here rather than in the thread so a bind failure reaches the
        // caller instead of quietly killing the watchdog.
        let sock = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))?;
        let target = SocketAddrV4::new(device_ip, HEARTBEAT_PORT);

        let running = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&running);

        let worker = thread::spawn(move || {
            let mut mark = frames_received.load(Ordering::Relaxed);
            let mut silent: u64 = 0;
            let mut saw_traffic = false;
            let mut verdict_given = false;

            while flag.load(Ordering::Relaxed) {
                // Deliberately not `connect`ed: nothing listens on 9998 and
                // nothing needs to, but a connected socket would surface the
                // resulting ICMP port-unreachable as an error on the next send.
                // A send failure is also the very condition being reported here,
                // so it must never end the loop.
                let _ = sock.send_to(HEARTBEAT, target);

                let now = frames_received.load(Ordering::Relaxed);
                if now != mark {
                    mark = now;
                    silent = 0;
                    saw_traffic = true;
                    if verdict_given {
                        verdict_given = false;
                        on_event(LinkEvent::Recovered);
                    }
                } else if saw_traffic {
                    // Before the first frame, silence only means the far end has
                    // not started - the drone has not begun streaming. Only a
                    // stream that WAS arriving and stopped is evidence of failure.
                    silent += 1;
                    if silent >= SILENT_VERDICT_S && !verdict_given {
                        // Once per episode, not once per tick: the condition is
                        // continuous but the news is not.
                        verdict_given = true;
                        on_event(LinkEvent::Silent { seconds: silent });
                    }
                }

                let mut slept = Duration::ZERO;
                while slept < TICK && flag.load(Ordering::Relaxed) {
                    thread::sleep(SLICE);
                    slept += SLICE;
                }
            }
        });

        Ok(LinkMonitor {
            running,
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Idempotent: the join handle is taken on the first call, so a `Drop` after
    /// an explicit stop finds nothing left to wait for.
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        let worker = self.worker.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = worker {
            let _ = handle.join();
        }
    }
}

impl Drop for LinkMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}
