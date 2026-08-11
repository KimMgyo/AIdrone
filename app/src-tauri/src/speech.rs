// Speech to text for the copilot's input box.
//
// Why this is native rather than a WebView API: the app ships on Windows and
// on Ubuntu. WebKitGTK - what Tauri embeds on Linux - has no
// `SpeechRecognition` implementation at all, and WebView2's is not something
// to bet a feature on either. A cloud transcription would need a provider the
// router has no credentials for. whisper.cpp runs identically on both, offline
// and without a key, so the same code path serves both platforms.
//
// It transcribes on stop, not while speaking: whisper is not a streaming
// recogniser, and a drone operator says one instruction and lets go. The text
// lands in the input box and the operator presses send - nothing here reaches
// the aircraft, which is the point. A misheard "팔 미터" must be readable
// before it is flown.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::path::BaseDirectory;
use tauri::Manager;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// What whisper wants, and what every capture is resampled to.
const TARGET_RATE: u32 = 16_000;

/// Past this a "dictation" is a stuck button, not an instruction. It also caps
/// the memory a forgotten recording can take: 2 minutes of f32 mono is ~7 MB.
const MAX_SECONDS: usize = 120;

/// The recording in progress. `None` between dictations.
#[derive(Default)]
pub struct Dictation {
    active: Mutex<Option<Recording>>,
}

struct Recording {
    /// Kept alive for the duration; dropping it stops the device.
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    channels: u16,
}

// `cpal::Stream` is not `Send` on every backend, but it is only ever created
// and dropped while the mutex is held on one thread's command invocation.
unsafe impl Send for Recording {}

/// Resolve the packaged model first; the manifest fallback keeps `tauri dev`
/// working. Mirrors `yolo_model_path` so both models are found the same way.
fn model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = std::env::var("AIDRONE_WHISPER_MODEL").unwrap_or_else(|_| "ggml-base-q5_1.bin".to_owned());
    let resource = app
        .path()
        .resolve(format!("models/{name}"), BaseDirectory::Resource)
        .ok();
    if resource.as_ref().is_some_and(|path| path.is_file()) {
        return resource;
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("models/{name}"));
    development.is_file().then_some(development)
}

/// Averages channels and resamples to 16 kHz by linear interpolation.
///
/// Good enough on purpose: whisper's own front end is far lossier than the
/// interpolation error, and pulling in a resampling crate to beat an error
/// nobody can hear would be weight for its own sake.
fn to_whisper_pcm(input: &[f32], rate: u32, channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    let mono: Vec<f32> = if channels == 1 {
        input.to_vec()
    } else {
        input
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };
    if rate == TARGET_RATE || mono.is_empty() {
        return mono;
    }

    let ratio = f64::from(rate) / f64::from(TARGET_RATE);
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let at = i as f64 * ratio;
        let left = at.floor() as usize;
        let frac = (at - at.floor()) as f32;
        let a = mono[left.min(mono.len() - 1)];
        let b = mono[(left + 1).min(mono.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

/// Whether dictation can work at all: a microphone and a model on disk.
/// Answered by looking, because the button's disabled state has to say why.
#[tauri::command]
pub fn dictate_ready(app: tauri::AppHandle) -> Result<String, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "마이크를 찾지 못했습니다".to_owned())?;
    let name = device.name().unwrap_or_else(|_| "입력 장치".to_owned());
    if model_path(&app).is_none() {
        let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/ggml-base-q5_1.bin");
        return Err(format!(
            "음성 모델이 없습니다. ggml-base-q5_1.bin 을 {} 에 두세요 (huggingface.co/ggerganov/whisper.cpp)",
            expected.display()
        ));
    }
    Ok(name)
}

#[tauri::command]
pub fn dictate_start(state: tauri::State<'_, Dictation>) -> Result<(), String> {
    let mut slot = state.active.lock().map_err(|_| "dictation lock".to_owned())?;
    if slot.is_some() {
        return Ok(()); // already listening; starting twice is not an error
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "마이크를 찾지 못했습니다".to_owned())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("마이크 설정을 읽지 못했습니다: {e}"))?;
    let rate = config.sample_rate().0;
    let channels = config.channels();
    let cap = MAX_SECONDS * rate as usize * channels as usize;

    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&samples);
    let on_error = |err: cpal::StreamError| eprintln!("[speech] input stream: {err}");

    // Only f32 and i16 are worth carrying: between them they cover every
    // default config WASAPI and ALSA have produced on the bench.
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &_| {
                let Ok(mut buf) = sink.lock() else { return };
                if buf.len() < cap {
                    buf.extend_from_slice(data);
                }
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _: &_| {
                let Ok(mut buf) = sink.lock() else { return };
                if buf.len() < cap {
                    buf.extend(data.iter().map(|s| f32::from(*s) / f32::from(i16::MAX)));
                }
            },
            on_error,
            None,
        ),
        other => return Err(format!("지원하지 않는 오디오 형식입니다: {other:?}")),
    }
    .map_err(|e| format!("마이크를 열지 못했습니다: {e}"))?;

    stream.play().map_err(|e| format!("녹음을 시작하지 못했습니다: {e}"))?;
    *slot = Some(Recording { stream, samples, rate, channels });
    Ok(())
}

/// Whisper marks anything it did not hear as speech with a bracketed
/// annotation - `[음악]`, `(박수)`, `[BLANK_AUDIO]` - and on ambient room noise
/// it will happily produce a whole plausible-looking sentence inside brackets.
/// Handing that to the operator as a transcript is worse than silence, because
/// it looks like something they said.
fn is_non_speech(said: &str) -> bool {
    let trimmed = said.trim();
    if trimmed.is_empty() {
        return true;
    }
    // Only when the WHOLE transcript is one annotation: a real sentence that
    // happens to contain a parenthesis is still a real sentence.
    //
    // strip_prefix/strip_suffix rather than slicing off the first and last
    // byte: every bracket here is ASCII but the text between them is not, and
    // `trimmed[1..]` panics the moment a transcript opens with a Hangul
    // syllable rather than a bracket.
    for (open, close) in [('[', ']'), ('(', ')'), ('（', '）')] {
        let Some(inner) = trimmed.strip_prefix(open).and_then(|rest| rest.strip_suffix(close))
        else {
            continue;
        };
        return !inner.contains(['[', '(', '（']);
    }
    false
}

/// Stops the recording and returns what was said. An empty string means the
/// model heard nothing worth reporting, which is not an error.
#[tauri::command]
pub async fn dictate_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Dictation>,
) -> Result<String, String> {
    let recorded = {
        let mut slot = state.active.lock().map_err(|_| "dictation lock".to_owned())?;
        let Some(recording) = slot.take() else {
            return Ok(String::new());
        };
        drop(recording.stream); // stops the device
        let captured = recording
            .samples
            .lock()
            .map_err(|_| "sample lock".to_owned())?
            .clone();
        to_whisper_pcm(&captured, recording.rate, recording.channels)
    };

    // Under a third of a second is a mis-click, and whisper hallucinates a
    // sentence out of near-silence rather than returning nothing.
    if recorded.len() < TARGET_RATE as usize / 3 {
        return Ok(String::new());
    }
    let Some(model) = model_path(&app) else {
        return Err("음성 모델이 없습니다".to_owned());
    };

    // Whisper is CPU-bound for seconds at a time; on the UI runtime that would
    // freeze the panel that is showing the drone's video.
    tauri::async_runtime::spawn_blocking(move || transcribe(&model, &recorded))
        .await
        .map_err(|e| format!("음성 인식 작업 실패: {e}"))?
}

fn transcribe(model: &PathBuf, pcm: &[f32]) -> Result<String, String> {
    let context = WhisperContext::new_with_params(
        &model.to_string_lossy(),
        WhisperContextParameters::default(),
    )
    .map_err(|e| format!("음성 모델을 열지 못했습니다: {e}"))?;
    let mut session = context
        .create_state()
        .map_err(|e| format!("음성 인식 준비 실패: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // Korean, stated rather than detected: the operator speaks one language and
    // auto-detection on two seconds of noisy audio guesses wrong.
    params.set_language(Some("ko"));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    session
        .full(params, pcm)
        .map_err(|e| format!("음성 인식 실패: {e}"))?;

    let segments = session.full_n_segments().map_err(|e| format!("음성 인식 결과 없음: {e}"))?;
    let mut said = String::new();
    for i in 0..segments {
        if let Ok(text) = session.full_get_segment_text(i) {
            said.push_str(&text);
        }
    }
    let said = said.trim();
    Ok(if is_non_speech(said) { String::new() } else { said.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_is_averaged_and_left_alone_at_the_target_rate() {
        // L/R interleaved; the mean is what whisper should see.
        let pcm = to_whisper_pcm(&[1.0, -1.0, 0.5, 0.5], TARGET_RATE, 2);
        assert_eq!(pcm, vec![0.0, 0.5]);
    }

    #[test]
    fn a_higher_rate_is_resampled_down_by_the_right_factor() {
        // 48 kHz mono -> 16 kHz keeps a third of the samples.
        let input: Vec<f32> = (0..48_000).map(|i| i as f32 / 48_000.0).collect();
        let out = to_whisper_pcm(&input, 48_000, 1);
        assert_eq!(out.len(), 16_000);
        // Still a ramp from 0 to ~1: interpolation must not shuffle the signal.
        assert!(out[0].abs() < 1e-6, "{}", out[0]);
        assert!((out[out.len() - 1] - 1.0).abs() < 0.01, "{}", out[out.len() - 1]);
    }

    #[test]
    fn empty_input_is_empty_output_rather_than_a_panic() {
        assert!(to_whisper_pcm(&[], 44_100, 2).is_empty());
        assert!(to_whisper_pcm(&[], TARGET_RATE, 1).is_empty());
    }

    #[test]
    fn a_mono_capture_at_the_target_rate_is_passed_through_untouched() {
        let pcm = vec![0.1, -0.2, 0.3];
        assert_eq!(to_whisper_pcm(&pcm, TARGET_RATE, 1), pcm);
    }

    #[test]
    fn a_bracketed_annotation_is_not_a_transcript() {
        // What the microphone actually produced on an empty room: a whole
        // plausible Korean sentence, wrapped, meaning "this was not speech".
        assert!(is_non_speech("[두 번째 영상은 전혀 안 돼]"));
        assert!(is_non_speech("[BLANK_AUDIO]"));
        assert!(is_non_speech("(박수)"));
        assert!(is_non_speech("（음악）"));
        assert!(is_non_speech("   "));
        assert!(is_non_speech(""));
    }

    #[test]
    fn a_real_instruction_survives_even_with_a_parenthesis_in_it() {
        assert!(!is_non_speech("이륙해서 앞으로 3미터 가"));
        assert!(!is_non_speech("마커 (0번) 따라가"));
        // Two annotations are not one wrapper, so this is not swallowed whole.
        assert!(!is_non_speech("[음악] 이륙해 [박수]"));
    }
}
