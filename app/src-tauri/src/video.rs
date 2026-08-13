//! Tello H.264 transport batches received from the USB bulk worker.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

/// The Tello terminates a transport batch with a datagram shorter than this.
const DATAGRAM_FULL: usize = 1460;
const FRAME_CAP_HINT: usize = 8 * 1024;

/// One transport-delimited Annex-B H.264 byte batch. These fields and their
/// raw Tauri wire use are intentionally unchanged from the UDP implementation.
pub struct Frame {
    pub data: Vec<u8>,
    pub recv_epoch_us: u64,
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct VideoStats {
    pub frames: u64,
    pub pkts: u64,
    pub bytes: u64,
    pub frame_max: usize,
    pub gap_max_ms: u64,
    pub last_frame_epoch_us: u64,
}

#[derive(Default)]
struct Counters {
    frames: Arc<AtomicU64>,
    pkts: AtomicU64,
    bytes: AtomicU64,
    frame_max: AtomicU64,
    gap_max_ms: AtomicU64,
    last_frame_epoch_us: AtomicU64,
}

struct Reassembler {
    frame: Vec<u8>,
    last_rx: Option<Instant>,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self { frame: Vec::with_capacity(FRAME_CAP_HINT), last_rx: None }
    }
}

/// USB ingress calls `ingest_datagram` once for every original UDP datagram;
/// the record framing must never merge or split those payloads.
pub struct VideoReceiver {
    counters: Arc<Counters>,
    reassembler: Mutex<Reassembler>,
    sink: Arc<dyn Fn(Frame) + Send + Sync>,
}

impl VideoReceiver {
    pub fn start<F: Fn(Frame) + Send + Sync + 'static>(sink: F) -> Self {
        Self {
            counters: Arc::new(Counters::default()),
            reassembler: Mutex::new(Reassembler::default()),
            sink: Arc::new(sink),
        }
    }

    pub fn ingest_datagram(&self, datagram: &[u8]) {
        let now = Instant::now();
        let mut reassembler = self.reassembler.lock();
        if let Some(previous) = reassembler.last_rx {
            self.counters.gap_max_ms.fetch_max(
                now.saturating_duration_since(previous).as_millis() as u64,
                Ordering::Relaxed,
            );
        }
        reassembler.last_rx = Some(now);
        self.counters.pkts.fetch_add(1, Ordering::Relaxed);
        self.counters.bytes.fetch_add(datagram.len() as u64, Ordering::Relaxed);
        reassembler.frame.extend_from_slice(datagram);

        if datagram.len() >= DATAGRAM_FULL || reassembler.frame.is_empty() {
            return;
        }

        let recv_epoch_us = epoch_us();
        let capacity = reassembler.frame.capacity();
        let mut data = std::mem::replace(&mut reassembler.frame, Vec::with_capacity(capacity));
        drop(reassembler);

        if let Some(patched) = crate::h264::with_low_delay_sps(&data) {
            data = patched;
        }
        self.counters.frame_max.fetch_max(data.len() as u64, Ordering::Relaxed);
        self.counters
            .last_frame_epoch_us
            .store(recv_epoch_us, Ordering::Relaxed);
        self.counters.frames.fetch_add(1, Ordering::Relaxed);
        (self.sink)(Frame { data, recv_epoch_us });
    }

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

    pub fn frame_counter(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.counters.frames)
    }

    /// Kept idempotent for the session teardown contract. USB worker ownership
    /// is the cancellation boundary now, so there is no receiver thread to join.
    pub fn stop(&self) {}
}

fn epoch_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_datagrams_define_batch_and_empty_terminal_is_preserved() {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&frames);
        let receiver = VideoReceiver::start(move |frame| captured.lock().push(frame.data));
        receiver.ingest_datagram(&vec![7; DATAGRAM_FULL]);
        receiver.ingest_datagram(&[]);
        let frames = frames.lock();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), DATAGRAM_FULL);
        assert_eq!(&frames[0][..2], &[7, 7]);
    }
}
