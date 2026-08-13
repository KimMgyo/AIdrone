// AIdrone - Tauri glue.
//
// Rust owns every byte of the drone link; the webview only decodes and paints.
// The stream payload crossing into JS is a finished Annex-B frame. Native
// perception runs beside USB bulk ingress and reports only small geometry
// events; it cannot issue a flight command.

mod apriltag3;
mod bulk;
mod copilot;
mod h264;
mod link;
mod speech;
mod state;
mod tello;
mod track;
mod update;
mod video;
mod vision;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::json;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::Manager;

const STATE_PORT: u16 = bulk::STATE_PORT;
const VIDEO_PORT: u16 = bulk::VIDEO_PORT;

/// The official ONNX Runtime 1.28.0 CPU binaries are deliberately loaded at
/// runtime. Unlike the static binary downloaded by `ort`, their Linux build
/// has a GLIBC_2.27 floor, so the same detector builds on Ubuntu 22.04 onward.
#[cfg(target_os = "linux")]
const ONNX_RUNTIME_RESOURCE: &str = "onnxruntime/linux-x64/libonnxruntime.so.1.28.0";
#[cfg(target_os = "windows")]
const ONNX_RUNTIME_RESOURCE: &str = "onnxruntime/windows-x64/onnxruntime.dll";

/// Resolve the packaged asset first; the manifest-directory fallback keeps
/// `bun tauri dev` useful without relying on a particular Tauri dev layout.
fn yolo_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource = app
        .path()
        .resolve("models/yolo26n.onnx", BaseDirectory::Resource)
        .ok();
    if resource.as_ref().is_some_and(|path| path.is_file()) {
        return resource;
    }

    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/yolo26n.onnx");
    development.is_file().then_some(development)
}

/// Kept separate so the native detector test exercises the exact library
/// packaged for this target, rather than finding a developer-installed copy.
pub(crate) fn development_onnx_runtime_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(ONNX_RUNTIME_RESOURCE)
}

fn onnx_runtime_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource = app
        .path()
        .resolve(ONNX_RUNTIME_RESOURCE, BaseDirectory::Resource)
        .map_err(|error| format!("resolve bundled ONNX Runtime: {error}"))?;
    if resource.is_file() {
        return Ok(resource);
    }

    let development = development_onnx_runtime_path();
    if development.is_file() {
        return Ok(development);
    }

    Err(format!(
        "bundled ONNX Runtime is missing: expected {}",
        ONNX_RUNTIME_RESOURCE
    ))
}

/// 1 Hz, matching the ESP32 console's own report line so the two can be read
/// side by side when something is wrong.
const TELEMETRY_PERIOD: Duration = Duration::from_secs(1);

/// A query is answered in milliseconds, so 3 s means a dead link rather than a
/// slow one.
const CMD_TIMEOUT: Duration = Duration::from_secs(3);

/// A motion command is different in kind: the Tello acknowledges `forward 300`
/// only **after** it has finished travelling, so its reply latency is the
/// manoeuvre's own duration. At the SDK's slowest speed 500 cm takes tens of
/// seconds. Judging those by the query timeout reported a failure at 3 s while
/// the drone was still flying the command - which is exactly the point where a
/// sequence of them falls apart.
const MOTION_TIMEOUT: Duration = Duration::from_secs(30);

/// Commands whose reply waits on the airframe, not on the link.
fn command_timeout(cmd: &str) -> Duration {
    let verb = cmd.split_whitespace().next().unwrap_or("");
    match verb {
        "takeoff" | "land" | "up" | "down" | "left" | "right" | "forward" | "back" | "cw"
        | "ccw" | "flip" | "go" | "curve" => MOTION_TIMEOUT,
        _ => CMD_TIMEOUT,
    }
}

struct Session {
    video: Arc<video::VideoReceiver>,
    _state: Arc<state::StateReceiver>,
    /// Must drop before `bulk`: it sends the final streamoff using this worker.
    tello: Arc<tello::Tello>,
    _bulk: Arc<bulk::BulkTransport>,
    _link: link::LinkMonitor,
    vision: Arc<vision::VisionWorker>,
    telemetry_stop: Arc<AtomicBool>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.telemetry_stop.store(true, Ordering::Relaxed);
        self.video.stop();
    }
}

#[derive(Default)]
struct AppState {
    session: Arc<Mutex<Option<Session>>>,
}

/// Wall-clock stamp prefixed to every frame handed to the webview: 8 bytes of
/// little-endian microseconds, then the Annex-B payload. The frontend
/// subtracts it from its own clock to get true receive-to-paint latency -
/// the number this whole app exists to improve, so it ships with the pixels
/// rather than in a side channel that could drift out of step with them.
const STAMP_LEN: usize = 8;

/// How long a single observation may wait for the stream to prove itself.
const FLOW_TIMEOUT: Duration = Duration::from_millis(2_500);

/// Growth has to still be there this long after the first frame. A stuck drone
/// emits a short burst and then stops - measured at 21 frames, ~0.8 s at the
/// Tello's 26 fps - so any window that fits inside that burst proves nothing.
const FLOW_WINDOW: Duration = Duration::from_millis(1_500);

/// Polling step. Fine enough that the happy path leaves promptly, coarse
/// enough that a step carries ~6 frames of signal at 26 fps.
const FLOW_STEP: Duration = Duration::from_millis(250);

/// Settle times for the retries, in order. The first observation follows the
/// handshake's own `HANDSHAKE_GAP`; these escalate only if that was not enough.
const FLOW_RETRY_GAPS: [Duration; 2] = [Duration::from_millis(1_500), Duration::from_secs(3)];

/// `ok` from `streamon` is not evidence the stream started.
///
/// A Tello whose previous session was killed rather than closed still believes
/// it is streaming: it acks `streamon` and then sends nothing, or sends a
/// fraction of a second of frames and stops, all while `battery?` keeps
/// answering normally. That is not a hypothetical - it is what a `hub stop` on
/// this app leaves behind, since a terminated process runs no destructors and
/// so never sends the closing `streamoff`. The user sees a black window and an
/// app that says "connected".
///
/// Datagrams still arriving after the burst has had time to end is the only
/// proof, so watch the counter and re-cycle the stream with a longer settle
/// time until it keeps moving.
fn ensure_stream_flowing(tello: &tello::Tello, frames: &AtomicU64) -> Result<(), String> {
    if stream_flows(frames) {
        return Ok(());
    }
    for gap in FLOW_RETRY_GAPS {
        tello
            .recycle_stream(gap)
            .map_err(|e| format!("stream restart: {e}"))?;
        if stream_flows(frames) {
            return Ok(());
        }
    }
    Err("no video after three streamon attempts - power-cycle the Tello".into())
}

/// True once the frame counter has been climbing for `FLOW_WINDOW` and is
/// still climbing at the end of it.
fn stream_flows(frames: &AtomicU64) -> bool {
    let started = Instant::now();
    let mut last = frames.load(Ordering::Relaxed);
    let mut first_growth: Option<Instant> = None;
    while started.elapsed() < FLOW_TIMEOUT {
        thread::sleep(FLOW_STEP);
        let seen = frames.load(Ordering::Relaxed);
        let grew = seen > last;
        if grew && first_growth.is_none() {
            first_growth = Some(Instant::now());
        }
        // Only the reading taken past the far edge of the burst decides.
        if first_growth.is_some_and(|t| t.elapsed() >= FLOW_WINDOW) {
            return grew;
        }
        last = seen;
    }
    false
}

fn build_session(
    frames: Channel<InvokeResponseBody>,
    telemetry: Channel<serde_json::Value>,
    link_events: Channel<serde_json::Value>,
    drone: Channel<serde_json::Value>,
    vision_events: Channel<serde_json::Value>,
    model_path: Option<PathBuf>,
) -> Result<Session, String> {
    let vision = Arc::new(vision::VisionWorker::start(vision_events, model_path));
    let vision_sink = Arc::clone(&vision);
    let video = Arc::new(video::VideoReceiver::start(move |f: video::Frame| {
        let video::Frame { data, recv_epoch_us } = f;
        vision_sink.submit(&data, recv_epoch_us);
        let mut buf = Vec::with_capacity(STAMP_LEN + data.len());
        buf.extend_from_slice(&recv_epoch_us.to_le_bytes());
        buf.extend_from_slice(&data);
        let _ = frames.send(InvokeResponseBody::Raw(buf));
    }));
    let state_rx = Arc::new(state::StateReceiver::start(move |value| {
        let _ = drone.send(value);
    }));

    let inbound_video = Arc::clone(&video);
    let inbound_state = Arc::clone(&state_rx);
    let bulk = Arc::new(
        bulk::BulkTransport::connect(Arc::new(move |record| match record.udp_port {
            STATE_PORT => inbound_state.ingest_datagram(&record.payload),
            VIDEO_PORT => inbound_video.ingest_datagram(&record.payload),
            bulk::BENCH_PORT => {}
            _ => {}
        }))
        .map_err(|error| format!("USB bulk open: {error}"))?,
    );
    let tello = Arc::new(tello::Tello::connect(Arc::clone(&bulk)));
    tello
        .start_stream()
        .map_err(|error| format!("stream handshake: {error}"))?;
    ensure_stream_flowing(&tello, &video.frame_counter())?;
    tello.set_keepalive(true);

    let link = link::LinkMonitor::start(video.frame_counter(), move |event| {
        if let Ok(value) = serde_json::to_value(event) {
            let _ = link_events.send(value);
        }
    })
    .map_err(|error| format!("video link watcher: {error}"))?;

    let telemetry_stop = Arc::new(AtomicBool::new(false));
    spawn_telemetry(video.clone(), telemetry, telemetry_stop.clone());

    Ok(Session {
        video,
        _state: state_rx,
        tello,
        _bulk: bulk,
        _link: link,
        vision,
        telemetry_stop,
    })
}

/// Pumps 1 Hz stats to the webview. fps and Mb/s are deltas over the tick, not
/// session averages: an average hides exactly the transient - six seconds of
/// nothing, then full recovery - that this app was built to make visible.
fn spawn_telemetry(
    video: Arc<video::VideoReceiver>,
    telemetry: Channel<serde_json::Value>,
    stop: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut prev = video.stats();
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(TELEMETRY_PERIOD);
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let now = video.stats();
            let d_frames = now.frames.saturating_sub(prev.frames);
            let d_bytes = now.bytes.saturating_sub(prev.bytes);
            let msg = json!({
                "frames": now.frames,
                "pkts": now.pkts,
                "bytes": now.bytes,
                "fps": d_frames,
                "mbps": (d_bytes as f64) * 8.0 / 1_000_000.0,
                "frameMax": now.frame_max,
                "gapMaxMs": now.gap_max_ms,
                "lastFrameEpochUs": now.last_frame_epoch_us,
            });
            if telemetry.send(msg).is_err() {
                break; // webview dropped the channel - nothing left to report to
            }
            prev = now;
        }
    });
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    frames: Channel<InvokeResponseBody>,
    telemetry: Channel<serde_json::Value>,
    link: Channel<serde_json::Value>,
    drone: Channel<serde_json::Value>,
    vision: Channel<serde_json::Value>,
) -> Result<(), String> {
    let slot = state.session.clone();
    let model_path = yolo_model_path(&app);
    // A reload tears down the webview but not the session behind it. Refusing
    // here ("already connected") wedged the app permanently: the only page
    // that could call disconnect() is the one that just died, and the fresh
    // page renders its Disconnect button dead because it owns no renderer.
    // A connect from the only window therefore means any prior session is
    // stale by definition -- retire it instead of rejecting.
    let stale = slot.lock().take();
    // The handshake blocks ~1.4 s by design - `streamoff` has to land between
    // `command` and `streamon`, with real waits either side. Off the main
    // thread, or the window is frozen for the whole of it. Dropping the stale
    // session also joins the USB worker before the next one claims interface 0.
    let session = tauri::async_runtime::spawn_blocking(move || {
        drop(stale);
        build_session(frames, telemetry, link, drone, vision, model_path)
    })
    .await
    .map_err(|e| format!("connect task: {e}"))??;
    *slot.lock() = Some(session);
    Ok(())
}

#[tauri::command]
async fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let taken = state.session.lock().take();
    // Dropping the session sends `streamoff` through USB bulk and joins the
    // link workers off the Tauri runtime.
    tauri::async_runtime::spawn_blocking(move || drop(taken))
        .await
        .map_err(|e| format!("disconnect task: {e}"))
}

#[tauri::command]
async fn send_command(state: tauri::State<'_, AppState>, cmd: String) -> Result<String, String> {
    let tello = {
        let guard = state.session.lock();
        guard
            .as_ref()
            .map(|s| s.tello.clone())
            .ok_or_else(|| "not connected".to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let timeout = command_timeout(&cmd);
        tello.send(&cmd, timeout).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("command task: {e}"))?
}

/// Stick control bypasses `spawn_blocking`: `send_now` only enqueues one USB
/// bulk record and does not wait for a reply, which keeps the 10 Hz control
/// path off the runtime's blocking pool.
#[tauri::command]
async fn send_rc(state: tauri::State<'_, AppState>, cmd: String) -> Result<(), String> {
    let tello = {
        let guard = state.session.lock();
        guard
            .as_ref()
            .map(|s| s.tello.clone())
            .ok_or_else(|| "not connected".to_string())?
    };
    tello.send_now(&cmd).map_err(|e| e.to_string())
}

/// Native perception is presentation-only: this command changes the worker's
/// selected detector, never a Tello SDK or RC command.
#[tauri::command]
fn set_vision_mode(state: tauri::State<'_, AppState>, mode: String) -> Result<(), String> {
    let mode = vision::VisionMode::parse(&mode)?;
    let worker = state
        .session
        .lock()
        .as_ref()
        .map(|session| Arc::clone(&session.vision))
        .ok_or_else(|| "not connected".to_string())?;
    worker.set_mode(mode);
    Ok(())
}

/// The existing frontend shape is retained, but all endpoints now identify the
/// one USB vendor interface rather than invented host-side addresses.
#[tauri::command]
fn endpoints() -> serde_json::Value {
    json!({
        "node": "USB VID:303A PID:8AD2 IF:0",
        "tello": "bulk OUT -> UDP/8889",
        "state": "bulk IN <- UDP/8890",
        "video": "bulk IN <- UDP/11111",
    })
}

#[tauri::command]
fn node_link() -> &'static str {
    if bulk::BulkTransport::device_ready() {
        "ready"
    } else {
        "absent"
    }
}

/// The build's own version, so the status bar shows the exact string the
/// updater compares against - not a copy in `package.json` that is free to
/// drift from the one the release artifacts are named after.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The 250 payload codes of the marker dictionary, for the panel's 6x6 drawing
/// pad and its roster glyphs.
#[tauri::command]
fn marker_codes() -> Result<Vec<u64>, String> {
    crate::apriltag3::payload_codes()
}

const PROBE_TIMEOUT: Duration = Duration::from_millis(1_200);

#[tauri::command]
async fn preflight(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let live = state.session.lock().is_some();
    if live {
        return Ok(vec![probe("session", "세션 실행 중", "USB bulk 세션이 활성 상태", true)]);
    }
    tauri::async_runtime::spawn_blocking(run_preflight)
        .await
        .map_err(|error| format!("preflight task: {error}"))
}

fn probe(id: &str, label: &str, detail: &str, ok: bool) -> serde_json::Value {
    json!({ "id": id, "label": label, "detail": detail, "ok": ok })
}

fn run_preflight() -> Vec<serde_json::Value> {
    let state_seen = Arc::new(AtomicBool::new(false));
    let observed_state = Arc::clone(&state_seen);
    let transport = match bulk::BulkTransport::connect(Arc::new(move |record| {
        if record.udp_port == STATE_PORT {
            observed_state.store(true, Ordering::Relaxed);
        }
    })) {
        Ok(transport) => Arc::new(transport),
        Err(error) => {
            let detail = format!("USB VID:303A PID:8AD2 열기 실패: {error}");
            return vec![
                probe("command", "명령 응답", &detail, false),
                probe("state", "상태 수신", "USB bulk 장치 없음", false),
                probe("video", "영상 경로", "USB bulk 장치 없음", false),
            ];
        }
    };
    let tello = tello::Tello::connect(transport);
    let command = match tello.send("command", PROBE_TIMEOUT) {
        Ok(reply) => probe("command", "명령 응답", &format!("bulk UDP/8889 -> \"{reply}\""), true),
        Err(error) => probe("command", "명령 응답", &format!("bulk UDP/8889 응답 없음: {error}"), false),
    };
    let deadline = Instant::now() + PROBE_TIMEOUT;
    while Instant::now() < deadline && !state_seen.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(25));
    }
    let state = if state_seen.load(Ordering::Relaxed) {
        probe("state", "상태 수신", "bulk IN <- UDP/8890", true)
    } else {
        probe("state", "상태 수신", "bulk IN <- UDP/8890 수신 없음", false)
    };
    vec![
        command,
        state,
        probe("video", "영상 경로", "bulk IN <- UDP/11111 (streamon 전에는 무신호)", true),
    ]
}

/// Decoder policy for the Linux WebView, published before WebKit forks its web
/// process (which inherits this environment).
///
/// WebKitGTK's WebCodecs backend does not act on the
/// `hardwareAcceleration: "prefer-software"` hint the decoder is configured
/// with - it takes whichever GStreamer element ranks highest for the caps. On a
/// machine with a VA-API or NVDEC plugin installed that is a hardware decoder,
/// and the Tello's SPS carries no VUI, which is the stream shape those handle
/// worst: the equivalent Chromium path filled a 12-frame DPB (470 ms, README),
/// and WebKitGTK fails outright with a bare `decode error`. libav's
/// `avdec_h264` costs ~1.2 ms per 960x720 frame and honours the low-latency
/// hint, so it is pinned and the hardware elements are ranked away.
///
/// Measured on WebKitGTK 2.52.3 / Ubuntu 26.04: with `avdec_h264:NONE` the same
/// stream reports `NotSupportedError: No decoder found for codec avc1.4d4028`,
/// with `avdec_h264:MAX` it decodes every frame - the variable is honoured, and
/// it is the only lever that reaches this decision.
#[cfg(target_os = "linux")]
const SOFTWARE_H264_RANK: &str = concat!(
    "avdec_h264:MAX,",
    "vah264dec:NONE,vah264lpdec:NONE,vaapih264dec:NONE,",
    "nvh264dec:NONE,nvh264sldec:NONE,",
    "v4l2h264dec:NONE,v4l2slh264dec:NONE,msdkh264dec:NONE"
);

/// The value to publish as `GST_PLUGIN_FEATURE_RANK`, or `None` when the
/// operator already set one - an explicit override always wins, including the
/// blank-but-present case, which is how a shell says "leave this alone".
#[cfg(target_os = "linux")]
fn software_h264_rank(existing: Option<&str>) -> Option<&'static str> {
    match existing {
        Some(_) => None,
        None => Some(SOFTWARE_H264_RANK),
    }
}

#[cfg(target_os = "linux")]
fn pin_software_h264_decoder() {
    const VAR: &str = "GST_PLUGIN_FEATURE_RANK";
    if let Some(rank) = software_h264_rank(std::env::var(VAR).ok().as_deref()) {
        std::env::set_var(VAR, rank);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any GStreamer registry load: WebKit's web process inherits this.
    #[cfg(target_os = "linux")]
    pin_software_h264_decoder();

    tauri::Builder::default()
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let runtime = onnx_runtime_path(&app.handle()).map_err(std::io::Error::other)?;
            vision::init_onnx_runtime(&runtime).map_err(std::io::Error::other)?;
            Ok(())
        })
        .manage(AppState::default())
        .manage(speech::Dictation::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            send_command,
            send_rc,
            set_vision_mode,
            endpoints,
            node_link,
            app_version,
            marker_codes,
            preflight,
            copilot::copilot_turn,
            speech::dictate_ready,
            speech::dictate_start,
            speech::dictate_stop,
            update::update_check,
            update::update_apply
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Closing the window is the ordinary way to end a session, and
            // without this the process exits with the drone still streaming:
            // Tauri does not drop managed state on exit, so `Session`'s
            // destructor - the only thing that sends the closing `streamoff` -
            // never runs. The drone then answers the next `streamon` with `ok`
            // and silence, and `ensure_stream_flowing` has to cycle it back out
            // of that state at a cost of seconds. One second spent here, at a
            // moment when nobody is waiting, buys all of that back.
            if matches!(event, tauri::RunEvent::Exit) {
                let taken = app
                    .state::<AppState>()
                    .session
                    .lock()
                    .take();
                drop(taken);
            }
        });
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{software_h264_rank, SOFTWARE_H264_RANK};

    #[test]
    fn pins_libav_when_the_operator_set_nothing() {
        assert_eq!(software_h264_rank(None), Some(SOFTWARE_H264_RANK));
        assert!(SOFTWARE_H264_RANK.contains("avdec_h264:MAX"));
        assert!(SOFTWARE_H264_RANK.contains("vah264dec:NONE"));
    }

    #[test]
    fn an_existing_rank_is_never_overwritten() {
        assert_eq!(software_h264_rank(Some("nvh264dec:MAX")), None);
        // A present-but-blank value is a deliberate "leave GStreamer alone".
        assert_eq!(software_h264_rank(Some("")), None);
    }
}
