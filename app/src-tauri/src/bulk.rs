//! ESP32 vendor-bulk transport.
//!
//! This is deliberately a byte stream rather than one USB transfer per Tello
//! datagram. USB may fragment or coalesce transfers at either end, so record
//! framing is persistent and every outbound record is chunked.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use nusb::transfer::{Bulk, In, Out};
use nusb::MaybeFuture;

pub const VID: u16 = 0x303A;
pub const PID: u16 = 0x8AD2;
pub const INTERFACE: u8 = 0;
pub const BULK_OUT: u8 = 0x01;
pub const BULK_IN: u8 = 0x81;
pub const CMD_PORT: u16 = 8889;
pub const STATE_PORT: u16 = 8890;
pub const VIDEO_PORT: u16 = 11111;
pub const BENCH_PORT: u16 = 9999;

const MAGIC: [u8; 2] = [0xD2, 0xA1];
const HEADER_LEN: usize = 6;
pub const MAX_PAYLOAD: usize = 2048;
const USB_CHUNK: usize = 64;
const IN_BUFFER: usize = 4096;
const IN_FLIGHT: usize = 8;
const READ_WAIT: Duration = Duration::from_millis(25);
const WRITE_WAIT: Duration = Duration::from_secs(1);
const START_WAIT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkRecord {
    pub udp_port: u16,
    pub payload: Vec<u8>,
}

impl BulkRecord {
    pub fn new(udp_port: u16, payload: Vec<u8>) -> io::Result<Self> {
        if payload.len() > MAX_PAYLOAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("bulk payload exceeds {MAX_PAYLOAD} bytes"),
            ));
        }
        Ok(Self { udp_port, payload })
    }

    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let len = u16::try_from(self.payload.len()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "bulk payload length overflows u16")
        })?;
        if usize::from(len) > MAX_PAYLOAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("bulk payload exceeds {MAX_PAYLOAD} bytes"),
            ));
        }

        let mut bytes = Vec::with_capacity(HEADER_LEN + self.payload.len());
        bytes.extend_from_slice(&MAGIC);
        bytes.extend_from_slice(&self.udp_port.to_le_bytes());
        bytes.extend_from_slice(&len.to_le_bytes());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }
}

/// Persistent decoder for the USB byte stream. Invalid headers lose only one
/// byte before searching again, which preserves an overlapping magic sequence.
#[derive(Default)]
pub struct RecordParser {
    pending: Vec<u8>,
}

impl RecordParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<BulkRecord> {
        self.pending.extend_from_slice(bytes);
        let mut records = Vec::new();

        loop {
            self.resynchronise();
            if self.pending.len() < HEADER_LEN {
                break;
            }

            let udp_port = u16::from_le_bytes([self.pending[2], self.pending[3]]);
            let payload_len = usize::from(u16::from_le_bytes([self.pending[4], self.pending[5]]));
            if payload_len > MAX_PAYLOAD {
                self.pending.drain(..1);
                continue;
            }

            let record_len = HEADER_LEN + payload_len;
            if self.pending.len() < record_len {
                break;
            }
            let payload = self.pending[HEADER_LEN..record_len].to_vec();
            self.pending.drain(..record_len);
            records.push(BulkRecord { udp_port, payload });
        }

        records
    }

    fn resynchronise(&mut self) {
        if self.pending.starts_with(&MAGIC) {
            return;
        }
        if let Some(index) = self.pending.windows(2).position(|pair| pair == MAGIC) {
            self.pending.drain(..index);
            return;
        }
        let keep_magic_prefix = self.pending.last().copied() == Some(MAGIC[0]);
        self.pending.clear();
        if keep_magic_prefix {
            self.pending.push(MAGIC[0]);
        }
    }
}

type InboundHandler = Arc<dyn Fn(BulkRecord) + Send + Sync + 'static>;

/// A single worker owns the claimed vendor interface and both endpoints. The
/// caller may send command records from Tauri tasks while it continuously
/// drains and routes inbound records.
pub struct BulkTransport {
    outgoing: SyncSender<BulkRecord>,
    replies: std::sync::Mutex<Receiver<Vec<u8>>>,
    running: Arc<AtomicBool>,
    failure: Arc<std::sync::Mutex<Option<io::Error>>>,
    worker: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl BulkTransport {
    pub(crate) fn connect(on_inbound: InboundHandler) -> io::Result<Self> {
        let (outgoing, outgoing_rx) = mpsc::sync_channel(64);
        let (reply_tx, replies) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let running = Arc::new(AtomicBool::new(true));
        let worker_running = Arc::clone(&running);
        let failure = Arc::new(std::sync::Mutex::new(None));
        let worker_failure = Arc::clone(&failure);

        let worker = thread::Builder::new()
            .name("usb-bulk".into())
            .spawn(move || {
                let result = run_worker(
                    outgoing_rx,
                    reply_tx,
                    on_inbound,
                    Arc::clone(&worker_running),
                    &ready_tx,
                );
                if let Err(error) = result {
                    *worker_failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(io_clone(&error));
                    let _ = ready_tx.send(Err(io_clone(&error)));
                }
                worker_running.store(false, Ordering::Relaxed);
            })?;

        match ready_rx.recv_timeout(START_WAIT) {
            Ok(Ok(())) => Ok(Self {
                outgoing,
                replies: std::sync::Mutex::new(replies),
                running,
                failure,
                worker: std::sync::Mutex::new(Some(worker)),
            }),
            Ok(Err(error)) => {
                running.store(false, Ordering::Relaxed);
                let _ = worker.join();
                Err(error)
            }
            Err(RecvTimeoutError::Timeout) => {
                running.store(false, Ordering::Relaxed);
                let _ = worker.join();
                Err(io::Error::new(io::ErrorKind::TimedOut, "USB bulk device did not open"))
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                Err(io::Error::new(io::ErrorKind::NotConnected, "USB bulk worker stopped"))
            }
        }
    }

    pub fn send(&self, udp_port: u16, payload: &[u8]) -> io::Result<()> {
        if udp_port != CMD_PORT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "USB bulk outbound records may target only UDP/8889",
            ));
        }
        if !self.running.load(Ordering::Relaxed) {
            return Err(self.worker_error());
        }
        let record = BulkRecord::new(udp_port, payload.to_vec())?;
        match self.outgoing.try_send(record) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => io::Result::Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "USB bulk command queue is full",
            )),
            Err(mpsc::TrySendError::Disconnected(_)) => Err(self.worker_error()),
        }
    }

    pub fn discard_replies(&self) {
        let replies = self.replies.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while replies.try_recv().is_ok() {}
    }

    pub fn recv_reply(&self, timeout: Duration) -> io::Result<Vec<u8>> {
        let result = {
            let replies = self.replies.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            replies.recv_timeout(timeout)
        };
        result.map_err(|error| match error {
            RecvTimeoutError::Timeout => io::Error::new(io::ErrorKind::TimedOut, "USB bulk command reply timed out"),
            RecvTimeoutError::Disconnected => self.worker_error(),
        })
    }

    fn worker_error(&self) -> io::Error {
        self.failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(io_clone)
            .unwrap_or_else(|| io::Error::new(io::ErrorKind::NotConnected, "USB bulk worker stopped"))
    }

    pub(crate) fn device_ready() -> bool {
        let Some(info) = nusb::list_devices()
            .wait()
            .ok()
            .and_then(|mut devices| devices.find(is_target))
        else {
            return false;
        };
        let Ok(device) = info.open().wait() else {
            return false;
        };
        let Ok(interface) = device.claim_interface(INTERFACE).wait() else {
            return false;
        };
        interface.endpoint::<Bulk, In>(BULK_IN).is_ok() && interface.endpoint::<Bulk, Out>(BULK_OUT).is_ok()
    }
}

impl Drop for BulkTransport {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        let worker = self.worker.lock().ok().and_then(|mut slot| slot.take());
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

fn is_target(device: &nusb::DeviceInfo) -> bool {
    device.vendor_id() == VID && device.product_id() == PID
}

fn run_worker(
    outgoing: Receiver<BulkRecord>,
    replies: mpsc::Sender<Vec<u8>>,
    on_inbound: InboundHandler,
    running: Arc<AtomicBool>,
    ready: &mpsc::SyncSender<io::Result<()>>,
) -> io::Result<()> {
    let info = nusb::list_devices()
        .wait()
        .map_err(io_error)?
        .find(is_target)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "ESP32 USB bulk device is absent"))?;
    let device = info.open().wait().map_err(io_error)?;
    let interface = device.claim_interface(INTERFACE).wait().map_err(io_error)?;
    let mut input = interface.endpoint::<Bulk, In>(BULK_IN).map_err(io_error)?;
    let mut output = interface.endpoint::<Bulk, Out>(BULK_OUT).map_err(io_error)?;
    let _ = ready.send(Ok(()));
    while input.pending() < IN_FLIGHT {
        let buffer = input.allocate(IN_BUFFER);
        input.submit(buffer);
    }

    let mut parser = RecordParser::default();
    while running.load(Ordering::Relaxed) {
        loop {
            match outgoing.try_recv() {
                Ok(record) => write_record(&mut output, &record)
                    .map_err(|error| io::Error::new(error.kind(), format!("USB bulk OUT: {error}")))?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
        }

        let Some(completion) = input.wait_next_complete(READ_WAIT) else {
            continue;
        };
        let actual_len = completion.actual_len;
        let status = completion.status;
        if actual_len != 0 {
            for record in parser.push(&completion.buffer[..actual_len]) {
                if record.udp_port == CMD_PORT {
                    let _ = replies.send(record.payload);
                } else {
                    on_inbound(record);
                }
            }
        }
        status.map_err(|error| io::Error::other(format!("USB bulk IN: {error}")))?;
        input.submit(completion.buffer);
    }

    Ok(())
}

fn write_record(
    output: &mut nusb::Endpoint<Bulk, Out>,
    record: &BulkRecord,
) -> io::Result<()> {
    let encoded = record.encode()?;
    let mut offset = 0;
    while offset < encoded.len() {
        let end = (offset + USB_CHUNK).min(encoded.len());
        let completion = output.transfer_blocking(encoded[offset..end].to_vec().into(), WRITE_WAIT);
        let actual_len = completion.actual_len;
        completion.status.map_err(io_error)?;
        if actual_len == 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "USB bulk write made no progress"));
        }
        offset += actual_len.min(end - offset);
    }
    Ok(())
}

fn io_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn io_clone(error: &io::Error) -> io::Error {
    io::Error::new(error.kind(), error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_round_trip_survives_fragmentation_and_coalescing() {
        let first = BulkRecord::new(8889, b"command".to_vec()).unwrap().encode().unwrap();
        let second = BulkRecord::new(11111, Vec::new()).unwrap().encode().unwrap();
        let mut parser = RecordParser::default();
        assert!(parser.push(&first[..3]).is_empty());
        let mut tail = first[3..].to_vec();
        tail.extend_from_slice(&second);
        assert_eq!(
            parser.push(&tail),
            vec![
                BulkRecord::new(8889, b"command".to_vec()).unwrap(),
                BulkRecord::new(11111, Vec::new()).unwrap(),
            ]
        );
    }

    #[test]
    fn parser_resynchronises_after_garbage_and_invalid_length() {
        let valid = BulkRecord::new(8890, b"bat:87;".to_vec()).unwrap().encode().unwrap();
        let mut parser = RecordParser::default();
        let mut stream = vec![0x00, MAGIC[0], 0x00, MAGIC[0], MAGIC[1], 0, 0, 1, 0x20];
        stream.extend_from_slice(&valid);
        assert_eq!(parser.push(&stream), vec![BulkRecord::new(8890, b"bat:87;".to_vec()).unwrap()]);
    }

    #[test]
    fn encoder_rejects_oversized_payload() {
        assert!(BulkRecord::new(8889, vec![0; MAX_PAYLOAD + 1]).is_err());
    }
}
