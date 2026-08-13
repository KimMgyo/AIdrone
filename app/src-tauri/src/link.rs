//! Video-silence watchdog for the USB bulk datapath.

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SILENT_VERDICT_S: u64 = 10;
const TICK: Duration = Duration::from_secs(1);
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
    /// Only video progress is meaningful: USB itself has no UDP heartbeat and
    /// the command path must not manufacture traffic just to diagnose silence.
    pub fn start<F: Fn(LinkEvent) + Send + 'static>(
        frames_received: Arc<AtomicU64>,
        on_event: F,
    ) -> io::Result<LinkMonitor> {
        let running = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&running);
        let worker = thread::spawn(move || {
            let mut mark = frames_received.load(Ordering::Relaxed);
            let mut silent = 0;
            let mut saw_traffic = false;
            let mut verdict_given = false;
            while flag.load(Ordering::Relaxed) {
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
                    silent += 1;
                    if silent >= SILENT_VERDICT_S && !verdict_given {
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
        Ok(LinkMonitor { running, worker: Mutex::new(Some(worker)) })
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(worker) = self.worker.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = worker.join();
        }
    }
}

impl Drop for LinkMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}
