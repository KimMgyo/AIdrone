// -----------------------------------------------------------------------------
// vision.rs - bounded native perception worker.
//
// The drone-facing video receiver has a ~450 ms UDP socket buffer.  It cannot
// wait for a decoder, an ArUco scan, or an ONNX inference run, so this module
// has exactly one loss policy: keep at most one newest encoded access unit.
// Every detector result is presentation data only.  This module never imports
// `tello`, and cannot send either SDK or RC packets.
// -----------------------------------------------------------------------------

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use aruco_rs::core::detector::Detector;
use aruco_rs::core::dictionary::{Dictionary, DICTIONARY_ARUCO_MIP_36H12};
use aruco_rs::simd::dispatch::NativeCV;
use aruco_rs::ImageBuffer;
use ort::session::Session;
use ort::value::TensorRef;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::apriltag3::{Detector as AprilTag3Detector, FAMILY_NAME as APRILTAG_FAMILY_NAME};
use crate::h264::{H264AccessUnitAssembler, H264Decoder};
use crate::track::{Observation, Tracker, TrackerConfig};

/// Active-mode H.264 is always decoded to preserve stream synchronization.
/// These intervals are floors between analyses, not a promise: the one-slot
/// mailbox drops frames whenever a detector runs long, so overshooting the
/// stream's own rate costs nothing but a busier worker thread.
///
/// Measured per frame at 960x720 on this bench: AprilTag 3 1-4 ms plus
/// `aruco-rs` 3-7 ms for the marker pair, and 20.1 ms for one YOLO26n
/// inference. Marker analysis therefore runs on essentially every decoded
/// frame; person inference is capped at 10 Hz, which is a fifth of a core.
const ARUCO_SAMPLE_INTERVAL: Duration = Duration::from_millis(33);
const PERSON_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
const ARUCO_MAX_HAMMING_DISTANCE: usize = 5;
const YOLO_INPUT_EDGE: usize = 640;
const YOLO_PERSON_CLASS: f32 = 0.0;
/// The model-side floor is only the tracker's association floor. The 0.40
/// score that used to gate the wire is now the tracker's *birth* threshold:
/// weaker boxes still reach `Tracker::update`, where they are allowed to
/// continue an existing identity through a partial occlusion but never to
/// start one. Filtering them here instead would starve that second pass.
const YOLO_CONFIDENCE_MIN: f32 = crate::track::DEFAULT_LOW_CONFIDENCE;
const LETTERBOX_VALUE: f32 = 114.0 / 255.0;
const YOLO_INTRA_THREADS: usize = 4;

/// The `ort` crate is built with `load-dynamic`: this is the sole place the
/// application admits a runtime. It must run before `Session::builder`, and
/// `ort` itself makes repeated calls idempotent for test and reload safety.
pub(crate) fn init_onnx_runtime(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("ONNX Runtime library not found: {}", path.display()));
    }
    ort::init_from(path)
        .map_err(|error| format!("load ONNX Runtime from {}: {error}", path.display()))?
        .commit();
    Ok(())
}

/// Rust's state is intentionally identical to the wire values.  The frontend
/// can only request these three names; invalid strings are rejected at the
/// Tauri command boundary before they reach the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisionMode {
    Key,
    Person,
    Aruco,
}

impl VisionMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "key" => Ok(Self::Key),
            "person" => Ok(Self::Person),
            "aruco" => Ok(Self::Aruco),
            _ => Err(format!("invalid vision mode: {value}")),
        }
    }

    fn from_atomic(value: u8) -> Self {
        match value {
            1 => Self::Person,
            2 => Self::Aruco,
            _ => Self::Key,
        }
    }

    fn as_atomic(self) -> u8 {
        match self {
            Self::Key => 0,
            Self::Person => 1,
            Self::Aruco => 2,
        }
    }
}

fn analysis_interval(mode: VisionMode) -> Option<Duration> {
    match mode {
        VisionMode::Key => None,
        VisionMode::Aruco => Some(ARUCO_SAMPLE_INTERVAL),
        VisionMode::Person => Some(PERSON_SAMPLE_INTERVAL),
    }
}

#[derive(Clone)]
struct EncodedFrame {
    /// A complete Annex-B H.264 access unit. It is assembled before entering
    /// the one-slot mailbox, so dropping an older item can never corrupt the
    /// stream parser.
    data: Arc<Vec<u8>>,
    /// A complete SPS/PPS/IDR access unit attached to the latest queued frame
    /// until the worker consumes it after a detector mode change.
    decoder_seed: Option<Arc<Vec<u8>>>,
    recv_epoch_us: u64,
}

enum Control {
    SetMode(VisionMode),
    Stop,
}

/// A one-slot overwrite mailbox. `video-rx` uses `try_lock`, so even a worker
/// transitioning between frames can make ingress drop rather than wait. When
/// it acquires the slot, it overwrites the older unit with the newest one.
struct FrameMailbox {
    slot: Mutex<Option<EncodedFrame>>,
    wake: Condvar,
}

impl FrameMailbox {
    fn new() -> Self {
        Self {
            slot: Mutex::new(None),
            wake: Condvar::new(),
        }
    }

    /// Returns false only when the worker currently owns the mailbox lock.
    /// Preserve an unconsumed decoder seed when replacing the older frame: an
    /// overwrite must not make a late-selected detector miss its bootstrap.
    fn publish(&self, mut frame: EncodedFrame) -> bool {
        let Ok(mut slot) = self.slot.try_lock() else {
            return false;
        };
        if frame.decoder_seed.is_none() {
            frame.decoder_seed = slot
                .as_ref()
                .and_then(|older| older.decoder_seed.as_ref().map(Arc::clone));
        }
        *slot = Some(frame);
        self.wake.notify_one();
        true
    }

    fn take_timeout(&self, timeout: Duration) -> Option<EncodedFrame> {
        let slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (mut slot, _) = self
            .wake
            .wait_timeout_while(slot, timeout, |frame| frame.is_none())
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.take()
    }

    fn wake(&self) {
        self.wake.notify_all();
    }
}

/// A receiver-owned perception worker. `submit` first reassembles arbitrary
/// Annex-B transport bytes into complete access units, retains an SPS/PPS/IDR
/// seed while Key mode is selected, then applies the one-slot newest-only
/// policy to those complete units.
pub struct VisionWorker {
    mode: Arc<AtomicU8>,
    running: Arc<AtomicBool>,
    needs_decoder_seed: AtomicBool,
    access_units: Mutex<H264AccessUnitAssembler>,
    frames: Arc<FrameMailbox>,
    controls: Sender<Control>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl VisionWorker {
    pub fn start(events: Channel<serde_json::Value>, model_path: Option<PathBuf>) -> Self {
        let frames = Arc::new(FrameMailbox::new());
        let (controls, control_rx) = mpsc::channel();
        let mode = Arc::new(AtomicU8::new(VisionMode::Key.as_atomic()));
        let running = Arc::new(AtomicBool::new(true));
        let worker_frames = Arc::clone(&frames);
        let worker_mode = Arc::clone(&mode);
        let worker_running = Arc::clone(&running);

        let worker = thread::Builder::new()
            .name("vision".into())
            .spawn(move || {
                worker_loop(
                    worker_frames,
                    control_rx,
                    worker_mode,
                    worker_running,
                    events,
                    model_path,
                )
            })
            // Resource exhaustion makes the process unable to service its UI or
            // UDP worker too; this is not a recoverable session-level error.
            .expect("spawn vision worker");

        Self {
            mode,
            running,
            needs_decoder_seed: AtomicBool::new(false),
            access_units: Mutex::new(H264AccessUnitAssembler::new()),
            frames,
            controls,
            worker: Mutex::new(Some(worker)),
        }
    }

    /// Selects a detector. There is no Tello handle in this type, so a mode
    /// transition can never become an autonomous movement command.
    pub fn set_mode(&self, mode: VisionMode) {
        self.needs_decoder_seed
            .store(mode != VisionMode::Key, Ordering::Release);
        self.mode.store(mode.as_atomic(), Ordering::Release);
        let _ = self.controls.send(Control::SetMode(mode));
        self.frames.wake();
    }

    /// Reassembles raw, arbitrarily segmented Annex-B bytes before applying
    /// newest-only backpressure. The receiver is the sole caller, so the
    /// reassembler remains coherent even when a slow detector drops access
    /// units from the mailbox.
    pub fn submit(&self, raw: &[u8], recv_epoch_us: u64) {
        let active = VisionMode::from_atomic(self.mode.load(Ordering::Acquire));
        let needs_decoder_seed =
            active != VisionMode::Key && self.needs_decoder_seed.load(Ordering::Acquire);
        let (access_units, decoder_seed) = {
            let mut reassembler = self
                .access_units
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let access_units = reassembler.push(raw, active != VisionMode::Key);
            let decoder_seed = needs_decoder_seed
                .then(|| reassembler.decoder_seed())
                .flatten();
            (access_units, decoder_seed)
        };

        if active == VisionMode::Key {
            return;
        }

        let mut pending_seed = decoder_seed;
        for data in access_units {
            let attached_seed = pending_seed.as_ref().map(Arc::clone);
            let published = self.frames.publish(EncodedFrame {
                data,
                decoder_seed: attached_seed.clone(),
                recv_epoch_us,
            });
            if attached_seed.is_some()
                && published
                && self
                    .needs_decoder_seed
                    .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                pending_seed = None;
            }
        }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
        self.needs_decoder_seed.store(false, Ordering::Release);
        self.mode
            .store(VisionMode::Key.as_atomic(), Ordering::Release);
        let _ = self.controls.send(Control::Stop);
        self.frames.wake();
        let handle = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

impl Drop for VisionWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    x: f32,
    y: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArucoMarker {
    id: i32,
    hamming_distance: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_margin: Option<f32>,
    corners: [Point; 4],
}

/// Engine order is the wire contract: index 0 is the primary whose markers the
/// UI selects and overlays, index 1 is the comparison row. AprilTag 3 leads
/// because a 596-frame live capture had it detect the print in every frame the
/// `aruco-rs` baseline did, plus 298 more, at half the per-frame cost.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ArucoEngine {
    Apriltag3,
    ArucoRs,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ArucoEngineState {
    Ready,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArucoEngineResult {
    engine: ArucoEngine,
    family: &'static str,
    state: ArucoEngineState,
    analysis_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    markers: Vec<ArucoMarker>,
}

/// The wire shape of one tracked person. `track_id` is the identity the UI
/// locks onto: it is stable for the life of a track, never reused within a
/// session, and plays exactly the role a marker id plays on the ArUco path.
/// Every field is a measurement from the current frame - a track the detector
/// did not see this frame is reported by its absence, never by a prediction.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonDetection {
    track_id: u32,
    confidence: f32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum VisionState {
    Inactive,
    WaitingFrame,
    Ready,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum VisionEvent {
    Status {
        mode: VisionMode,
        state: VisionState,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Aruco {
        recv_epoch_us: u64,
        width: u32,
        height: u32,
        engines: [ArucoEngineResult; 2],
    },
    Person {
        recv_epoch_us: u64,
        width: u32,
        height: u32,
        analysis_ms: u64,
        detections: Vec<PersonDetection>,
    },
}

fn emit(events: &Channel<serde_json::Value>, event: VisionEvent) {
    if let Ok(value) = serde_json::to_value(event) {
        let _ = events.send(value);
    }
}

/// The worker owns both marker engines and the optional person runtime.
/// Neither is synchronized or shared with the UDP receiver, which keeps their
/// mutable decoder/session state out of the flight-critical path.
fn worker_loop(
    frames: Arc<FrameMailbox>,
    controls: Receiver<Control>,
    mode_atomic: Arc<AtomicU8>,
    running: Arc<AtomicBool>,
    events: Channel<serde_json::Value>,
    model_path: Option<PathBuf>,
) {
    let mut dictionary = Dictionary::new(&DICTIONARY_ARUCO_MIP_36H12);
    // The upstream MIP dictionary's published tau is 12.  This station uses
    // the established conservative strict comparison `distance < 5`, matching
    // the former desktop detector and refusing weak near-matches.
    dictionary.tau = ARUCO_MAX_HAMMING_DISTANCE;
    let aruco_detector = Detector::new(&dictionary, NativeCV);
    // An unavailable comparison engine must not disable the established
    // `aruco-rs` observation. Its fresh per-frame error row makes that clear.
    let mut apriltag_detector = AprilTag3Detector::new();

    let mut decoder = H264Decoder::new()
        .map_err(|e| {
            emit(
                &events,
                VisionEvent::Status {
                    mode: VisionMode::Key,
                    state: VisionState::Error,
                    detail: Some(format!("native H.264 decoder: {e}")),
                },
            );
            e
        })
        .ok();
    let mut yolo = PersonRuntime::Unloaded;
    // One tracker for the whole session. It is the only thing in this module
    // that remembers anything across frames, and `drain_controls` wipes it on
    // every mode change so a fresh Person session cannot inherit stale ids.
    let mut tracker = Tracker::new(TrackerConfig::default());
    let mut current = VisionMode::Key;
    let mut next_sample_at = Instant::now();
    let mut ready_mode: Option<VisionMode> = None;
    let mut next_decode_error_at = Instant::now();

    emit(
        &events,
        VisionEvent::Status {
            mode: VisionMode::Key,
            state: VisionState::Inactive,
            detail: None,
        },
    );

    while running.load(Ordering::Acquire) {
        if !drain_controls(
            &controls,
            &mode_atomic,
            &events,
            &mut current,
            &mut next_sample_at,
            &mut ready_mode,
            &mut tracker,
        ) {
            break;
        }

        let Some(frame) = frames.take_timeout(Duration::from_millis(100)) else {
            continue;
        };

        if !drain_controls(
            &controls,
            &mode_atomic,
            &events,
            &mut current,
            &mut next_sample_at,
            &mut ready_mode,
            &mut tracker,
        ) {
            break;
        }
        if current == VisionMode::Key {
            continue;
        }

        let sample = Instant::now() >= next_sample_at;
        let selected_mode = current;
        let decoder = match decoder.as_mut() {
            Some(decoder) => decoder,
            None => {
                emit(
                    &events,
                    VisionEvent::Status {
                        mode: selected_mode,
                        state: VisionState::Error,
                        detail: Some("native H.264 decoder is unavailable".into()),
                    },
                );
                continue;
            }
        };

        // The detector can be enabled long after `streamon`; its private FFmpeg
        // instance then has never seen the initial SPS/PPS. Prime it once with
        // the retained complete IDR before decoding the current live frame.
        let result: Result<(), String> = (|| {
            if let Some(seed) = frame
                .decoder_seed
                .as_ref()
                .filter(|seed| !Arc::ptr_eq(seed, &frame.data))
            {
                decoder.decode_into(seed, false, |_, _, _| {})?;
            }

            decoder.decode_into(&frame.data, sample, |width, height, rgba| {
                // A packet can yield no output while the decoder acquires its first
                // keyframe. A callback is therefore the proof that analysis had
                // real pixels; only here do we mark the mode ready.
                if !sample {
                    return;
                }
                let Some(interval) = analysis_interval(selected_mode) else {
                    return;
                };
                next_sample_at = Instant::now() + interval;
                let started = Instant::now();
                match selected_mode {
                    VisionMode::Aruco => {
                        let image = ImageBuffer {
                            data: rgba,
                            width,
                            height,
                        };
                        let aruco_started = Instant::now();
                        let aruco_markers = aruco_detector
                            .detect(&image)
                            .into_iter()
                            .map(|marker| ArucoMarker {
                                id: marker.id,
                                hamming_distance: marker.hamming_distance,
                                decision_margin: None,
                                corners: marker.corners.map(|point| Point {
                                    x: point.x,
                                    y: point.y,
                                }),
                            })
                            .collect();
                        let aruco_result = ArucoEngineResult {
                            engine: ArucoEngine::ArucoRs,
                            family: APRILTAG_FAMILY_NAME,
                            state: ArucoEngineState::Ready,
                            analysis_ms: aruco_started.elapsed().as_millis() as u64,
                            detail: None,
                            markers: aruco_markers,
                        };

                        let apriltag_started = Instant::now();
                        let apriltag_result = match apriltag_detector.as_mut() {
                            Ok(detector) => match detector.detect(width, height, rgba) {
                                Ok(markers) => ArucoEngineResult {
                                    engine: ArucoEngine::Apriltag3,
                                    family: APRILTAG_FAMILY_NAME,
                                    state: ArucoEngineState::Ready,
                                    analysis_ms: apriltag_started.elapsed().as_millis() as u64,
                                    detail: None,
                                    markers: markers
                                        .into_iter()
                                        .map(|marker| ArucoMarker {
                                            id: marker.id,
                                            hamming_distance: marker.hamming_distance,
                                            decision_margin: Some(marker.decision_margin),
                                            corners: marker.corners.map(|point| Point {
                                                x: point[0],
                                                y: point[1],
                                            }),
                                        })
                                        .collect(),
                                },
                                Err(detail) => ArucoEngineResult {
                                    engine: ArucoEngine::Apriltag3,
                                    family: APRILTAG_FAMILY_NAME,
                                    state: ArucoEngineState::Error,
                                    analysis_ms: apriltag_started.elapsed().as_millis() as u64,
                                    detail: Some(detail),
                                    markers: Vec::new(),
                                },
                            },
                            Err(detail) => ArucoEngineResult {
                                engine: ArucoEngine::Apriltag3,
                                family: APRILTAG_FAMILY_NAME,
                                state: ArucoEngineState::Error,
                                analysis_ms: 0,
                                detail: Some(detail.clone()),
                                markers: Vec::new(),
                            },
                        };
                        if ready_mode != Some(VisionMode::Aruco) {
                            emit(
                                &events,
                                VisionEvent::Status {
                                    mode: VisionMode::Aruco,
                                    state: VisionState::Ready,
                                    detail: Some(
                                        "ARUCO_MIP_36h12 AprilTag 3 + aruco-rs comparison".into(),
                                    ),
                                },
                            );
                            ready_mode = Some(VisionMode::Aruco);
                        }
                        emit(
                            &events,
                            VisionEvent::Aruco {
                                recv_epoch_us: frame.recv_epoch_us,
                                width,
                                height,
                                engines: [apriltag_result, aruco_result],
                            },
                        );
                    }
                    VisionMode::Person => {
                        let observations = match yolo.load_or_get(model_path.as_deref()) {
                            Ok(detector) => detector.infer(width, height, rgba),
                            Err(err) => Err(err),
                        };
                        // The tracker is what turns this frame's anonymous
                        // boxes into the durable ids the UI locks onto. It
                        // returns only the tracks a real detection landed on,
                        // already ordered highest confidence first.
                        let detections = observations.map(|observations| {
                            tracker
                                .update(&observations)
                                .into_iter()
                                .map(|track| PersonDetection {
                                    track_id: track.id,
                                    confidence: track.confidence,
                                    x: track.bbox[0],
                                    y: track.bbox[1],
                                    width: track.bbox[2],
                                    height: track.bbox[3],
                                })
                                .collect::<Vec<_>>()
                        });
                        match detections {
                            Ok(detections) => {
                                let analysis_ms = started.elapsed().as_millis() as u64;
                                if ready_mode != Some(VisionMode::Person) {
                                    emit(
                                        &events,
                                        VisionEvent::Status {
                                            mode: VisionMode::Person,
                                            state: VisionState::Ready,
                                            detail: Some("YOLO26n / CPU ONNX Runtime".into()),
                                        },
                                    );
                                    ready_mode = Some(VisionMode::Person);
                                }
                                emit(
                                    &events,
                                    VisionEvent::Person {
                                        recv_epoch_us: frame.recv_epoch_us,
                                        width,
                                        height,
                                        analysis_ms,
                                        detections,
                                    },
                                );
                            }
                            Err(err) => {
                                emit(
                                    &events,
                                    VisionEvent::Status {
                                        mode: VisionMode::Person,
                                        state: VisionState::Error,
                                        detail: Some(err),
                                    },
                                );
                            }
                        }
                    }
                    VisionMode::Key => {}
                }
            })
        })();

        if let Err(err) = result {
            // An active detector can begin between IDR access units. Report
            // that transition at most once per second; forwarding one error
            // per H.264 packet would turn a normal keyframe wait into a busy
            // IPC stream.
            let now = Instant::now();
            if now >= next_decode_error_at {
                emit(
                    &events,
                    VisionEvent::Status {
                        mode: selected_mode,
                        state: VisionState::WaitingFrame,
                        detail: Some(format!("H.264 frame wait: {err}")),
                    },
                );
                next_decode_error_at = now + Duration::from_secs(1);
            }
        }
    }
}

fn drain_controls(
    controls: &Receiver<Control>,
    mode_atomic: &AtomicU8,
    events: &Channel<serde_json::Value>,
    current: &mut VisionMode,
    next_sample_at: &mut Instant,
    ready_mode: &mut Option<VisionMode>,
    tracker: &mut Tracker,
) -> bool {
    loop {
        match controls.try_recv() {
            Ok(Control::SetMode(mode)) => {
                *current = mode;
                mode_atomic.store(mode.as_atomic(), Ordering::Release);
                *next_sample_at = Instant::now();
                *ready_mode = None;
                // Any mode change ends the person session. Dropping every
                // track here is what guarantees the next Person session
                // starts with no identity the UI could still be locked to.
                tracker.reset();
                let state = if mode == VisionMode::Key {
                    VisionState::Inactive
                } else {
                    VisionState::WaitingFrame
                };
                emit(
                    events,
                    VisionEvent::Status {
                        mode,
                        state,
                        detail: if mode == VisionMode::Key {
                            None
                        } else {
                            Some("native decoder frame wait".into())
                        },
                    },
                );
            }
            Ok(Control::Stop) | Err(TryRecvError::Disconnected) => return false,
            Err(TryRecvError::Empty) => return true,
        }
    }
}

enum PersonRuntime {
    Unloaded,
    Ready(YoloDetector),
    Failed(String),
}

impl PersonRuntime {
    fn load_or_get(
        &mut self,
        model_path: Option<&std::path::Path>,
    ) -> Result<&mut YoloDetector, String> {
        if matches!(self, Self::Unloaded) {
            *self = match model_path {
                Some(path) => YoloDetector::load(path)
                    .map(Self::Ready)
                    .unwrap_or_else(Self::Failed),
                None => Self::Failed("YOLO26n model resource is missing".into()),
            };
        }
        match self {
            Self::Ready(detector) => Ok(detector),
            Self::Failed(error) => Err(error.clone()),
            Self::Unloaded => Err("YOLO26 runtime did not initialize".into()),
        }
    }
}

/// The exported asset is a fixed, end-to-end YOLO26n graph:
/// `images [1, 3, 640, 640] -> output0 [1, 300, 6]`.
///
/// Inference is owned by the one vision thread because `ort::Session::run`
/// takes `&mut self`.  Four intra-op threads leave enough CPU for WebView paint,
/// the UDP receive thread, and the operating system on the target i7-13700K.
struct YoloDetector {
    session: Session,
    input: Vec<f32>,
}

impl YoloDetector {
    fn load(path: &std::path::Path) -> Result<Self, String> {
        if !path.is_file() {
            return Err(format!("YOLO26n model not found: {}", path.display()));
        }
        let session = Session::builder()
            .map_err(|err| format!("ONNX session builder: {err}"))?
            .with_intra_threads(YOLO_INTRA_THREADS)
            .map_err(|err| format!("ONNX intra-op threads: {err}"))?
            .commit_from_file(path)
            .map_err(|err| format!("load YOLO26n: {err}"))?;
        Ok(Self {
            session,
            input: vec![LETTERBOX_VALUE; YOLO_INPUT_EDGE * YOLO_INPUT_EDGE * 3],
        })
    }

    fn infer(&mut self, width: u32, height: u32, rgba: &[u8]) -> Result<Vec<Observation>, String> {
        let letterbox = letterbox_rgba_to_chw(&mut self.input, width, height, rgba)?;
        let input = TensorRef::from_array_view((
            [1usize, 3, YOLO_INPUT_EDGE, YOLO_INPUT_EDGE],
            &*self.input,
        ))
        .map_err(|err| format!("YOLO input tensor: {err}"))?;
        let output = self
            .session
            .run(ort::inputs![input])
            .map_err(|err| format!("YOLO inference: {err}"))?;
        let first = output
            .values()
            .next()
            .ok_or_else(|| "YOLO26n emitted no output tensor".to_string())?;
        let (shape, values) = first
            .try_extract_tensor::<f32>()
            .map_err(|err| format!("YOLO output tensor: {err}"))?;
        if shape.len() != 3 || shape[0] != 1 || shape[1] != 300 || shape[2] != 6 {
            return Err(format!("unexpected YOLO26n output shape: {shape}"));
        }

        let mut observations = values
            .chunks_exact(6)
            .filter_map(|candidate| person_from_candidate(candidate, width, height, letterbox))
            .collect::<Vec<_>>();
        // The exported end-to-end head is already NMS-free.  Sort so that the
        // tracker hands out ids strongest-detection-first, which keeps the
        // UI's first selectable target deterministic frame to frame.
        observations.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));
        Ok(observations)
    }
}

#[derive(Clone, Copy)]
struct Letterbox {
    scale: f32,
    pad_x: f32,
    pad_y: f32,
}

/// Matches Ultralytics' default LetterBox behaviour: aspect-preserving linear
/// resize centred in a 640 square, filled with 114, then RGB/255 into NCHW.
/// We write NCHW directly rather than materializing a 640² RGB image.
fn letterbox_rgba_to_chw(
    output: &mut [f32],
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<Letterbox, String> {
    if width == 0 || height == 0 {
        return Err("YOLO input frame has zero dimensions".into());
    }
    let source_pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "YOLO input dimensions overflow".to_string())?;
    if rgba.len() != source_pixels * 4 {
        return Err(format!(
            "YOLO input RGBA length {} does not match {width}x{height}",
            rgba.len()
        ));
    }
    if output.len() != YOLO_INPUT_EDGE * YOLO_INPUT_EDGE * 3 {
        return Err("YOLO input workspace has an invalid length".into());
    }

    output.fill(LETTERBOX_VALUE);
    let scale = (YOLO_INPUT_EDGE as f32 / width as f32).min(YOLO_INPUT_EDGE as f32 / height as f32);
    let scaled_width = ((width as f32 * scale).round() as usize).clamp(1, YOLO_INPUT_EDGE);
    let scaled_height = ((height as f32 * scale).round() as usize).clamp(1, YOLO_INPUT_EDGE);
    let pad_x = (YOLO_INPUT_EDGE - scaled_width) / 2;
    let pad_y = (YOLO_INPUT_EDGE - scaled_height) / 2;
    let plane = YOLO_INPUT_EDGE * YOLO_INPUT_EDGE;

    for y in 0..scaled_height {
        let source_y = ((y as f32 + 0.5) * height as f32 / scaled_height as f32 - 0.5)
            .clamp(0.0, height.saturating_sub(1) as f32);
        let y0 = source_y.floor() as usize;
        let y1 = (y0 + 1).min(height as usize - 1);
        let wy = source_y - y0 as f32;
        for x in 0..scaled_width {
            let source_x = ((x as f32 + 0.5) * width as f32 / scaled_width as f32 - 0.5)
                .clamp(0.0, width.saturating_sub(1) as f32);
            let x0 = source_x.floor() as usize;
            let x1 = (x0 + 1).min(width as usize - 1);
            let wx = source_x - x0 as f32;
            let destination = (pad_y + y) * YOLO_INPUT_EDGE + pad_x + x;
            for channel in 0..3 {
                let top_left = rgba[(y0 * width as usize + x0) * 4 + channel] as f32;
                let top_right = rgba[(y0 * width as usize + x1) * 4 + channel] as f32;
                let bottom_left = rgba[(y1 * width as usize + x0) * 4 + channel] as f32;
                let bottom_right = rgba[(y1 * width as usize + x1) * 4 + channel] as f32;
                let top = top_left + (top_right - top_left) * wx;
                let bottom = bottom_left + (bottom_right - bottom_left) * wx;
                output[channel * plane + destination] = (top + (bottom - top) * wy) / 255.0;
            }
        }
    }

    Ok(Letterbox {
        scale,
        pad_x: pad_x as f32,
        pad_y: pad_y as f32,
    })
}

fn person_from_candidate(
    candidate: &[f32],
    source_width: u32,
    source_height: u32,
    letterbox: Letterbox,
) -> Option<Observation> {
    if candidate.len() != 6 {
        return None;
    }
    let (x1, y1, x2, y2, confidence, class_id) = (
        candidate[0],
        candidate[1],
        candidate[2],
        candidate[3],
        candidate[4],
        candidate[5],
    );
    if !x1.is_finite()
        || !y1.is_finite()
        || !x2.is_finite()
        || !y2.is_finite()
        || !confidence.is_finite()
        || !class_id.is_finite()
        || confidence < YOLO_CONFIDENCE_MIN
        || (class_id - YOLO_PERSON_CLASS).abs() > f32::EPSILON
    {
        return None;
    }

    let left = ((x1 - letterbox.pad_x) / letterbox.scale).clamp(0.0, source_width as f32);
    let top = ((y1 - letterbox.pad_y) / letterbox.scale).clamp(0.0, source_height as f32);
    let right = ((x2 - letterbox.pad_x) / letterbox.scale).clamp(0.0, source_width as f32);
    let bottom = ((y2 - letterbox.pad_y) / letterbox.scale).clamp(0.0, source_height as f32);
    let width = right - left;
    let height = bottom - top;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(Observation {
        bbox: [left, top, width, height],
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_preserves_source_geometry_and_channel_order() {
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255];
        let mut output = vec![0.0; YOLO_INPUT_EDGE * YOLO_INPUT_EDGE * 3];
        let letterbox = letterbox_rgba_to_chw(&mut output, 2, 1, &rgba).expect("letterbox");
        assert_eq!(letterbox.pad_x, 0.0);
        assert_eq!(letterbox.pad_y, 160.0);
        let plane = YOLO_INPUT_EDGE * YOLO_INPUT_EDGE;
        let red_pixel = 160 * YOLO_INPUT_EDGE;
        assert!(output[red_pixel] > 0.99);
        assert!(output[plane + red_pixel] < 0.01);
        let green_pixel = 160 * YOLO_INPUT_EDGE + 639;
        assert!(output[plane + green_pixel] > 0.99);
        assert!(output[green_pixel] < 0.01);
        assert!((output[0] - LETTERBOX_VALUE).abs() < f32::EPSILON);
    }

    #[test]
    fn person_coordinates_unletterbox_and_reject_non_people() {
        let letterbox = Letterbox {
            scale: 2.0 / 3.0,
            pad_x: 0.0,
            pad_y: 80.0,
        };
        let person =
            person_from_candidate(&[80.0, 140.0, 240.0, 340.0, 0.9, 0.0], 960, 720, letterbox)
                .expect("person");
        assert!((person.bbox[0] - 120.0).abs() < 0.01);
        assert!((person.bbox[1] - 90.0).abs() < 0.01);
        assert!((person.bbox[2] - 240.0).abs() < 0.01);
        assert!((person.bbox[3] - 300.0).abs() < 0.01);
        assert!(
            person_from_candidate(&[80.0, 140.0, 240.0, 340.0, 0.9, 1.0], 960, 720, letterbox)
                .is_none()
        );
        // A weak-but-real box now survives the model-side filter: it is the
        // tracker, not this function, that decides 0.39 cannot start a track.
        assert!(person_from_candidate(
            &[80.0, 140.0, 240.0, 340.0, 0.39, 0.0],
            960,
            720,
            letterbox
        )
        .is_some());
        // Below the tracker's association floor nothing is forwarded at all.
        assert!(person_from_candidate(
            &[80.0, 140.0, 240.0, 340.0, 0.09, 0.0],
            960,
            720,
            letterbox
        )
        .is_none());
    }

    /// The frontend decoder rejects a person event outright if a field is
    /// missing or misnamed, so the camelCase wire shape is a contract, not an
    /// implementation detail.
    #[test]
    fn person_detection_serializes_with_a_track_id() {
        let wire = serde_json::to_value(PersonDetection {
            track_id: 7,
            confidence: 0.5,
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        })
        .expect("serialize person detection");
        assert_eq!(
            wire,
            serde_json::json!({
                "trackId": 7,
                "confidence": 0.5,
                "x": 1.0,
                "y": 2.0,
                "width": 3.0,
                "height": 4.0,
            })
        );
    }

    /// Marker analysis must keep up with the stream while person inference,
    /// which is an order of magnitude dearer, stays capped well below it.
    #[test]
    fn aruco_samples_every_frame_while_person_inference_stays_capped() {
        let aruco = analysis_interval(VisionMode::Aruco).expect("aruco interval");
        let person = analysis_interval(VisionMode::Person).expect("person interval");
        assert!(
            aruco <= Duration::from_millis(33),
            "marker analysis must not lag a 30 fps stream"
        );
        assert!(
            person >= Duration::from_millis(100) && person > aruco,
            "one 20 ms inference per 100 ms is the person budget"
        );
        assert_eq!(analysis_interval(VisionMode::Key), None);
    }

    const FIXTURE_WIDTH: usize = 960;
    const FIXTURE_HEIGHT: usize = 720;

    /// A synthetic, perfectly axis-aligned print of MIP-36h12 ID 0: an 8×8
    /// marker (six-by-six payload inside a one-cell black border) whose cells
    /// are `cell` pixels square, centred on a light background.
    fn mip_id_zero_frame(cell: usize) -> Vec<u8> {
        const GRID: usize = 8;
        const CODE: u64 = 0xd2b63a09d;

        let mut rgba = vec![235_u8; FIXTURE_WIDTH * FIXTURE_HEIGHT * 4];
        for alpha in rgba.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }

        let left = (FIXTURE_WIDTH - GRID * cell) / 2;
        let top = (FIXTURE_HEIGHT - GRID * cell) / 2;
        for grid_y in 0..GRID {
            for grid_x in 0..GRID {
                let border = grid_x == 0 || grid_y == 0 || grid_x == GRID - 1 || grid_y == GRID - 1;
                let bit = if border {
                    false
                } else {
                    let payload_bit = (grid_y - 1) * 6 + (grid_x - 1);
                    ((CODE >> (35 - payload_bit)) & 1) != 0
                };
                let value = if bit { 255 } else { 0 };
                for y in top + grid_y * cell..top + (grid_y + 1) * cell {
                    for x in left + grid_x * cell..left + (grid_x + 1) * cell {
                        let pixel = (y * FIXTURE_WIDTH + x) * 4;
                        rgba[pixel..pixel + 3].fill(value);
                    }
                }
            }
        }
        rgba
    }

    /// Separable box blur - a deterministic stand-in for the defocus/motion
    /// smear that makes a real Tello frame hard to decode.
    fn box_blur(rgba: &[u8], radius: usize) -> Vec<u8> {
        let mut pass = rgba.to_vec();
        for y in 0..FIXTURE_HEIGHT {
            for x in 0..FIXTURE_WIDTH {
                for channel in 0..3 {
                    let span = x.saturating_sub(radius)..(x + radius + 1).min(FIXTURE_WIDTH);
                    let count = span.len() as u32;
                    let sum: u32 = span
                        .map(|offset| rgba[(y * FIXTURE_WIDTH + offset) * 4 + channel] as u32)
                        .sum();
                    pass[(y * FIXTURE_WIDTH + x) * 4 + channel] = (sum / count) as u8;
                }
            }
        }
        let mut out = pass.clone();
        for y in 0..FIXTURE_HEIGHT {
            for x in 0..FIXTURE_WIDTH {
                for channel in 0..3 {
                    let span = y.saturating_sub(radius)..(y + radius + 1).min(FIXTURE_HEIGHT);
                    let count = span.len() as u32;
                    let sum: u32 = span
                        .map(|offset| pass[(offset * FIXTURE_WIDTH + x) * 4 + channel] as u32)
                        .sum();
                    out[(y * FIXTURE_WIDTH + x) * 4 + channel] = (sum / count) as u8;
                }
            }
        }
        out
    }

    fn baseline_detects_id_zero(detector: &Detector<NativeCV>, rgba: &[u8]) -> bool {
        detector
            .detect(&ImageBuffer {
                data: rgba,
                width: FIXTURE_WIDTH as u32,
                height: FIXTURE_HEIGHT as u32,
            })
            .iter()
            .any(|marker| marker.id == 0)
    }

    fn baseline_detector(dictionary: &Dictionary) -> Detector<'_, NativeCV> {
        Detector::new(dictionary, NativeCV)
    }

    fn strict_mip_dictionary() -> Dictionary {
        let mut dictionary = Dictionary::new(&DICTIONARY_ARUCO_MIP_36H12);
        dictionary.tau = ARUCO_MAX_HAMMING_DISTANCE;
        dictionary
    }

    #[test]
    fn native_marker_detectors_find_exact_mip_marker() {
        let rgba = mip_id_zero_frame(70);
        let dictionary = strict_mip_dictionary();
        let detector = baseline_detector(&dictionary);
        assert!(detector
            .detect(&ImageBuffer {
                data: &rgba,
                width: FIXTURE_WIDTH as u32,
                height: FIXTURE_HEIGHT as u32,
            })
            .iter()
            .any(|marker| marker.id == 0 && marker.hamming_distance == 0));

        let mut apriltag = AprilTag3Detector::new().expect("AprilTag 3 detector");
        let april_markers = apriltag
            .detect(FIXTURE_WIDTH as u32, FIXTURE_HEIGHT as u32, &rgba)
            .expect("AprilTag 3 MIP detection");
        assert!(april_markers
            .iter()
            .any(|marker| marker.id == 0 && marker.hamming_distance == 0));
    }

    /// The whole reason the comparison engine exists: on the same frame, at a
    /// marker size and blur the drone actually produces, AprilTag 3 still
    /// decodes ID 0 where the `aruco-rs` baseline reports nothing. If this
    /// ever stops holding, the A/B surface has lost its purpose.
    #[test]
    fn apriltag_decodes_a_blurred_marker_the_baseline_drops() {
        let sharp = mip_id_zero_frame(8);
        let blurred = box_blur(&sharp, 4);
        let dictionary = strict_mip_dictionary();
        let baseline = baseline_detector(&dictionary);
        let mut apriltag = AprilTag3Detector::new().expect("AprilTag 3 detector");

        assert!(
            baseline_detects_id_zero(&baseline, &sharp),
            "a 64 px sharp marker must still be the baseline's easy case"
        );
        assert!(
            !baseline_detects_id_zero(&baseline, &blurred),
            "baseline is expected to lose this frame; the margin claim is measured, not assumed"
        );
        assert!(
            apriltag
                .detect(FIXTURE_WIDTH as u32, FIXTURE_HEIGHT as u32, &blurred)
                .expect("AprilTag 3 blurred detection")
                .iter()
                .any(|marker| marker.id == 0),
            "AprilTag 3 must keep the marker the baseline drops"
        );
    }

    /// Neither engine may invent a marker in a bordered, grainy scene - the
    /// false-positive risk that pinned the baseline's tau at 5, not 12.
    #[test]
    fn neither_engine_invents_a_marker_in_clutter() {
        let mut seed = 0x2545_F491_4F6C_DD1D_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut rgba = vec![200_u8; FIXTURE_WIDTH * FIXTURE_HEIGHT * 4];
        for alpha in rgba.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        for _ in 0..120 {
            let w = 20 + (next() as usize % 90);
            let h = 20 + (next() as usize % 90);
            let x0 = next() as usize % (FIXTURE_WIDTH - w);
            let y0 = next() as usize % (FIXTURE_HEIGHT - h);
            let value = if next() % 2 == 0 { 8_u8 } else { 245 };
            for y in y0..y0 + h {
                for x in x0..x0 + w {
                    let pixel = (y * FIXTURE_WIDTH + x) * 4;
                    rgba[pixel..pixel + 3].fill(value);
                }
            }
        }
        for pixel in rgba.chunks_exact_mut(4) {
            let grain = (next() % 31) as i16 - 15;
            for channel in &mut pixel[..3] {
                *channel = (*channel as i16 + grain).clamp(0, 255) as u8;
            }
        }

        let dictionary = strict_mip_dictionary();
        let baseline = baseline_detector(&dictionary);
        assert!(!baseline_detects_id_zero(&baseline, &rgba));
        assert!(AprilTag3Detector::new()
            .expect("AprilTag 3 detector")
            .detect(FIXTURE_WIDTH as u32, FIXTURE_HEIGHT as u32, &rgba)
            .expect("AprilTag 3 clutter detection")
            .is_empty());
    }

    #[test]
    fn mailbox_preserves_decoder_seed_when_newer_frame_replaces_it() {
        let mailbox = FrameMailbox::new();
        let seed = Arc::new(vec![0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65]);

        assert!(mailbox.publish(EncodedFrame {
            data: Arc::clone(&seed),
            decoder_seed: Some(Arc::clone(&seed)),
            recv_epoch_us: 1,
        }));
        assert!(mailbox.publish(EncodedFrame {
            data: Arc::new(vec![0, 0, 0, 1, 0x41]),
            decoder_seed: None,
            recv_epoch_us: 2,
        }));

        let latest = mailbox
            .take_timeout(Duration::ZERO)
            .expect("latest frame must remain queued");
        assert_eq!(latest.recv_epoch_us, 2);
        assert!(
            Arc::ptr_eq(
                latest
                    .decoder_seed
                    .as_ref()
                    .expect("replacement must carry the bootstrap"),
                &seed
            ),
            "the bootstrap must survive newest-only overwrite"
        );
    }
    #[test]
    fn bundled_yolo26n_loads_and_runs() {
        let runtime = crate::development_onnx_runtime_path();
        init_onnx_runtime(&runtime).expect("bundled ONNX Runtime");
        let model = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/yolo26n.onnx");
        let mut detector = YoloDetector::load(&model).expect("bundled YOLO26n model");
        let mut rgba = vec![114_u8; YOLO_INPUT_EDGE * YOLO_INPUT_EDGE * 4];
        for alpha in rgba.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }

        let detections = detector
            .infer(YOLO_INPUT_EDGE as u32, YOLO_INPUT_EDGE as u32, &rgba)
            .expect("YOLO26n inference");
        assert!(detections.iter().all(|detection| {
            detection.confidence.is_finite()
                && detection.bbox[0].is_finite()
                && detection.bbox[1].is_finite()
                && detection.bbox[2] > 0.0
                && detection.bbox[3] > 0.0
        }));
    }
}
