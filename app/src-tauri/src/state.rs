//! Tello state telemetry delivered as original UDP:8890 payloads by USB bulk.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

pub struct StateReceiver {
    datagrams: AtomicU64,
    sink: Arc<dyn Fn(Value) + Send + Sync>,
}

impl StateReceiver {
    pub fn start<F: Fn(Value) + Send + Sync + 'static>(sink: F) -> Self {
        Self { datagrams: AtomicU64::new(0), sink: Arc::new(sink) }
    }

    /// Called only by the USB worker, once per complete record. Parsing remains
    /// lossy and field-compatible with the old UDP receiver.
    pub fn ingest_datagram(&self, datagram: &[u8]) {
        self.datagrams.fetch_add(1, Ordering::Relaxed);
        let recv_epoch_us = epoch_us();
        if let Some(value) = parse(&String::from_utf8_lossy(datagram), recv_epoch_us) {
            (self.sink)(value);
        }
    }

    #[allow(dead_code)]
    pub fn datagrams(&self) -> u64 {
        self.datagrams.load(Ordering::Relaxed)
    }

}

/// One state line into a JSON object, or None if nothing in it parsed.
fn parse(line: &str, recv_epoch_us: u64) -> Option<Value> {
    let mut obj = Map::new();
    for pair in line.split(';') {
        let Some((key, raw)) = pair.split_once(':') else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let Ok(n) = raw.trim().parse::<f64>() else { continue };
        let value = if n.fract() == 0.0 {
            Value::from(n as i64)
        } else {
            match serde_json::Number::from_f64(n) {
                Some(number) => Value::Number(number),
                None => continue,
            }
        };
        obj.insert(key.to_string(), value);
    }
    if obj.is_empty() {
        return None;
    }
    obj.insert("recvEpochUs".into(), Value::from(recv_epoch_us));
    Some(Value::Object(obj))
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
    fn ingress_keeps_the_existing_numeric_state_contract() {
        let state = StateReceiver::start(|_| {});
        state.ingest_datagram(b"bat:87;baro:404.71;bad:no;");
        assert_eq!(state.datagrams(), 1);
        let value = parse("bat:87;baro:404.71;bad:no;", 42).unwrap();
        assert_eq!(value["bat"].as_i64(), Some(87));
        assert_eq!(value["baro"].as_f64(), Some(404.71));
        assert_eq!(value["recvEpochUs"].as_u64(), Some(42));
        assert!(value.get("bad").is_none());
    }
}
