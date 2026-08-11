// AIdrone - Tauri glue.
//
// Rust owns every byte of the drone link; the webview only decodes and paints.
// The stream payload crossing into JS is a finished Annex-B frame. Native
// perception runs beside the UDP receiver and reports only small geometry
// events; it cannot issue a flight command.

mod apriltag3;
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

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Pinned by the cable, never discovered: the ESP32 soft-AP answers on `.1`,
/// the Tello holds `.2` from that AP's lease, and `desktop/nic-setup.ps1`
/// statics this host to `.50/24`. Nothing serves DHCP on the host side.
const DEVICE_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 4, 1);
const TELLO_ADDR: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(192, 168, 4, 2), 8889);
const VIDEO_PORT: u16 = 11111;
const STATE_PORT: u16 = 8890;

/// A test affordance, not configuration. `AIDRONE_TELLO_ADDR=127.0.0.1:8899`
/// and `AIDRONE_DEVICE_IP=127.0.0.1` point the whole link at
/// `desktop/fake-tello.ts`, so the app runs with no drone and no cable, which
/// is most of what a measurement needs.
///
/// Its limit is worth knowing: the simulator's stream is encoded with x264
/// `-tune zerolatency`, so it carries a VUI `max_num_reorder_frames` the real
/// Tello omits, and it therefore could never reproduce the 502 ms DPB stall
/// that dominated every real flight (README, *Solved: the 502 ms reading was
/// the decoder's DPB*). A green run here is not a green run on the drone.
///
/// A malformed value falls back to the pinned address rather than failing
/// the connect.
fn from_env<T: std::str::FromStr>(key: &str, pinned: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(pinned)
}

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
    /// Stopped by its own Drop. Unlike `video` nothing else holds a handle on
    /// it, so field drop order is the whole teardown.
    _state: state::StateReceiver,
    tello: Arc<tello::Tello>,
    _link: link::LinkMonitor,
    /// Kept after `video` so the UDP source stops before the perception worker
    /// is joined during teardown.
    vision: Arc<vision::VisionWorker>,
    telemetry_stop: Arc<AtomicBool>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // The other four own their own teardown; only the stats pump has no
        // handle of its own to stop it.
        self.telemetry_stop.store(true, Ordering::Relaxed);
        // That pump holds its own Arc on the receiver, so leaving the socket
        // to Arc drop order would keep udp/11111 bound for up to a full tick
        // after disconnect - long enough for a prompt reconnect to fail with
        // AddrInUse. stop() joins the receive thread, so do it here.
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
    // Bind the video socket BEFORE the handshake: `streamon` is acked in
    // milliseconds and datagrams follow immediately, so a receiver started
    // afterwards loses the head of the stream - and with it the SPS/PPS the
    // decoder cannot start without.
    // This thread owns decoding and all detector state. It incrementally
    // records decoder bootstrap data from every transport batch, while only
    // emitting complete access units after a non-key mode is selected.
    let vision = Arc::new(vision::VisionWorker::start(vision_events, model_path));
    let vision_sink = Arc::clone(&vision);
    let video = Arc::new(
        video::VideoReceiver::start(VIDEO_PORT, move |f: video::Frame| {
            // The WebView receives the original transport batch. Native
            // perception reframes the same bytes internally before it queues
            // a complete access unit, so neither path depends on UDP packet
            // boundaries.
            let video::Frame {
                data,
                recv_epoch_us,
            } = f;
            vision_sink.submit(&data, recv_epoch_us);
            let mut buf = Vec::with_capacity(STAMP_LEN + data.len());
            buf.extend_from_slice(&recv_epoch_us.to_le_bytes());
            buf.extend_from_slice(&data);
            // Raw, not Serialize: a Vec<u8> going out as a Serialize payload
            // is JSON-encoded into an array of integers, turning each 5.6 KB
            // frame into ~30 KB of text for the webview to parse.
            let _ = frames.send(InvokeResponseBody::Raw(buf));
        })
        .map_err(|e| format!("bind udp/{VIDEO_PORT}: {e}"))?,
    );

    // Bound before the handshake for the same reason as video, and a tighter
    // one: `command` is acked in milliseconds and the first state datagrams
    // follow it immediately, so a receiver started after the handshake misses
    // the burst that tells the panel a drone is there at all.
    let state_rx = state::StateReceiver::start(STATE_PORT, move |v| {
        // Serialize, not Raw: a state object is ~16 small numbers ten times a
        // second, which is nothing next to the video channel beside it.
        let _ = drone.send(v);
    })
    .map_err(|e| format!("bind udp/{STATE_PORT}: {e}"))?;

    let tello = Arc::new(
        tello::Tello::connect(from_env("AIDRONE_TELLO_ADDR", TELLO_ADDR))
            .map_err(|e| format!("bind udp/8889: {e}"))?,
    );
    tello
        .start_stream()
        .map_err(|e| format!("stream handshake: {e}"))?;
    ensure_stream_flowing(&tello, &video.frame_counter())?;
    tello.set_keepalive(true);

    let link = link::LinkMonitor::start(
        from_env("AIDRONE_DEVICE_IP", DEVICE_IP),
        video.frame_counter(),
        move |e| {
            if let Ok(v) = serde_json::to_value(e) {
                let _ = link_events.send(v);
            }
        },
    )
    .map_err(|e| format!("heartbeat socket: {e}"))?;

    let telemetry_stop = Arc::new(AtomicBool::new(false));
    spawn_telemetry(video.clone(), telemetry, telemetry_stop.clone());

    Ok(Session {
        video,
        _state: state_rx,
        vision,
        tello,
        _link: link,
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
    let stale = slot.lock().expect("session lock").take();
    // The handshake blocks ~1.4 s by design - `streamoff` has to land between
    // `command` and `streamon`, with real waits either side. Off the main
    // thread, or the window is frozen for the whole of it. Dropping the stale
    // session is blocking too (it sends `streamoff` and joins three threads),
    // and it shares the same task so it completes before the new session
    // binds - otherwise udp/8889 and udp/11111 are still held and the bind
    // fails with AddrInUse.
    let session = tauri::async_runtime::spawn_blocking(move || {
        drop(stale);
        build_session(frames, telemetry, link, drone, vision, model_path)
    })
    .await
    .map_err(|e| format!("connect task: {e}"))??;
    *slot.lock().expect("session lock") = Some(session);
    Ok(())
}

#[tauri::command]
async fn disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let taken = state.session.lock().expect("session lock").take();
    // Dropping the session sends `streamoff` and joins three threads. Also
    // blocking work, also not the main thread's problem.
    tauri::async_runtime::spawn_blocking(move || drop(taken))
        .await
        .map_err(|e| format!("disconnect task: {e}"))
}

#[tauri::command]
async fn send_command(state: tauri::State<'_, AppState>, cmd: String) -> Result<String, String> {
    let tello = {
        let guard = state.session.lock().expect("session lock");
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

/// Stick control. Deliberately not `spawn_blocking`, unlike every other
/// command here: `send_now` is one non-blocking datagram write with no reply
/// to wait for, and at the 10 Hz a live stick runs at, a thread hop per update
/// would cost more than the send it wraps.
#[tauri::command]
async fn send_rc(state: tauri::State<'_, AppState>, cmd: String) -> Result<(), String> {
    let tello = {
        let guard = state.session.lock().expect("session lock");
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
        .expect("session lock")
        .as_ref()
        .map(|session| Arc::clone(&session.vision))
        .ok_or_else(|| "not connected".to_string())?;
    worker.set_mode(mode);
    Ok(())
}

/// Where this build's bytes actually come from, resolved through the same
/// `from_env` overrides `build_session` reads. Reporting the pinned constants
/// instead would have the panel confidently name 192.168.4.2 through a whole
/// simulator run - the one case where showing the addresses is worth anything.
#[tauri::command]
fn endpoints() -> serde_json::Value {
    json!({
        "node": from_env("AIDRONE_DEVICE_IP", DEVICE_IP).to_string(),
        "tello": from_env("AIDRONE_TELLO_ADDR", TELLO_ADDR).to_string(),
        "state": format!("0.0.0.0:{STATE_PORT}"),
        "video": format!("0.0.0.0:{VIDEO_PORT}"),
    })
}

/// How long one probe waits for its answer. A healthy Tello acks `command` in
/// a few ms and state follows within one 10 Hz period, so this is slack for a
/// link that is merely slow - and short enough that all three probes are done
/// inside three seconds, which is as long as anyone will watch a spinner.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1_200);

#[tauri::command]
async fn preflight(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    // A live session already owns 8889, 8890 and 11111. Probing anyway would
    // report AddrInUse against ourselves on every line, and read as a dead
    // link at the exact moment the link is provably up.
    //
    // Bound to a `let` rather than tested inline so the guard is provably
    // dropped at the end of this statement: a MutexGuard is !Send, and one
    // still alive at the await below would make the whole command's future
    // !Send and fail to compile.
    let live = state.session.lock().expect("session lock").is_some();
    if live {
        return Ok(vec![probe(
            "session",
            "세션 실행 중",
            "포트 점유 중 - 연결 해제 후 재점검",
            false,
        )]);
    }
    // Up to ~2.4 s of blocking listens. Not the main thread's problem.
    tauri::async_runtime::spawn_blocking(run_preflight)
        .await
        .map_err(|e| format!("preflight task: {e}"))
}

fn probe(id: &str, label: &str, detail: &str, ok: bool) -> serde_json::Value {
    json!({ "id": id, "label": label, "detail": detail, "ok": ok })
}

/// Sequential, and the order carries meaning: probe 1's `command` is what
/// makes a live drone start broadcasting, so probe 2 has something to hear
/// without sending anything of its own. Each probe owns its socket for exactly
/// its own duration, because the connect that follows a green preflight binds
/// these same three ports and a probe still holding one would fail the run it
/// just blessed.
fn run_preflight() -> Vec<serde_json::Value> {
    let peer = from_env("AIDRONE_TELLO_ADDR", TELLO_ADDR);
    vec![probe_command(peer), probe_state(), probe_video()]
}

/// One receive, retried until `timeout` runs out. The retry is there for
/// Windows: WSAECONNRESET surfaces an earlier ICMP port-unreachable on the
/// NEXT recv, and reading that as "nothing arrived" fails the preflight of a
/// link that is perfectly healthy.
fn recv_within(sock: &UdpSocket, timeout: Duration, buf: &mut [u8]) -> Option<usize> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        // A zero read timeout means "block forever" to the OS, so the deadline
        // has to be tested before it is ever set.
        if left.is_zero() || sock.set_read_timeout(Some(left)).is_err() {
            return None;
        }
        match sock.recv_from(buf) {
            Ok((n, _)) => return Some(n),
            Err(e) if e.kind() == ErrorKind::ConnectionReset => continue,
            Err(_) => return None,
        }
    }
}

/// The only end-to-end reachability proof available without starting a
/// session: bind the command port, say `command`, and see whether anything
/// answers. It doubles as proof that 8889 is free, which catches a second copy
/// of this app here instead of seconds into a connect.
fn probe_command(peer: SocketAddrV4) -> serde_json::Value {
    const ID: &str = "command";
    const LABEL: &str = "명령 응답";

    let sock = match UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, tello::CMD_PORT)) {
        Ok(s) => s,
        Err(e) => {
            let detail = format!("udp/{} 바인드 실패: {e}", tello::CMD_PORT);
            return probe(ID, LABEL, &detail, false);
        }
    };
    if let Err(e) = sock.send_to(b"command", peer) {
        return probe(ID, LABEL, &format!("{peer} 전송 실패: {e}"), false);
    }

    let mut buf = [0u8; 256];
    match recv_within(&sock, PROBE_TIMEOUT, &mut buf) {
        // Verbatim, trimmed: `ok` and `error` are both answers, and which one
        // came back is the whole content of this probe.
        Some(n) => {
            let reply = String::from_utf8_lossy(&buf[..n]);
            probe(ID, LABEL, &format!("{peer} -> \"{}\"", reply.trim()), true)
        }
        None => probe(ID, LABEL, &format!("{peer} -> 응답 없음"), false),
    }
}

/// Listens and sends nothing: probe 1 already sent the `command` that starts
/// the broadcast. Silence here after a green probe 1 means the drone took the
/// command and the state path is blocked somewhere between it and this host.
fn probe_state() -> serde_json::Value {
    const ID: &str = "state";
    const LABEL: &str = "상태 수신";

    let sock = match UdpSocket::bind(("0.0.0.0", STATE_PORT)) {
        Ok(s) => s,
        Err(e) => {
            return probe(
                ID,
                LABEL,
                &format!("udp/{STATE_PORT} 바인드 실패: {e}"),
                false,
            )
        }
    };

    let mut buf = [0u8; 2048];
    match recv_within(&sock, PROBE_TIMEOUT, &mut buf) {
        // Counted, not parsed: this proves a line arrived and roughly what
        // shape it is. state.rs owns the parse, and duplicating it here would
        // give the probe its own way to be wrong.
        Some(n) => {
            let line = String::from_utf8_lossy(&buf[..n]);
            let fields = line.split(';').filter(|p| p.contains(':')).count();
            probe(
                ID,
                LABEL,
                &format!("udp/{STATE_PORT} <- {fields}개 필드"),
                true,
            )
        }
        None => probe(ID, LABEL, &format!("udp/{STATE_PORT} <- 수신 없음"), false),
    }
}

/// Availability only. Video flows after `streamon`, which preflight will not
/// send: it would leave the drone streaming at a socket about to be dropped -
/// precisely the wedged state `ensure_stream_flowing` then spends seconds
/// undoing. AddrInUse is the failure that matters here.
fn probe_video() -> serde_json::Value {
    const ID: &str = "video";
    const LABEL: &str = "영상 포트";

    match UdpSocket::bind(("0.0.0.0", VIDEO_PORT)) {
        Ok(_) => {
            let detail = format!("udp/{VIDEO_PORT} 사용 가능 (streamon 전에는 무신호)");
            probe(ID, LABEL, &detail, true)
        }
        Err(e) => probe(
            ID,
            LABEL,
            &format!("udp/{VIDEO_PORT} 사용 불가: {e}"),
            false,
        ),
    }
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
                    .expect("session lock")
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
