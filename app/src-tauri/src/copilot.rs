// OpenAI-compatible model proxy for the copilot panel.
//
// The one reason this lives in Rust: the API key must never be reachable from
// the webview. Everything else about a turn - the tool schema, the transcript,
// the executor - stays in TypeScript, so this file forwards `messages` and
// `tools` it does not interpret. Adding a tool is a frontend-only change.
//
// It owns exactly two transport facts the frontend should not have to know.
// First, the model id and the endpoint, which are configuration. Second, and
// load-bearing: **this router only emits `tool_calls` when streaming.** With
// `stream: false` the same request comes back as prose apologising that no
// drone tools are connected - verified against `cgpt-web/gpt-5.6-pro`. So the
// request is always streamed and the deltas are reassembled here into the
// single non-streaming response shape the loop expects.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::Manager;

/// The router this app was measured against. It is OpenAI-shaped, so
/// `COPILOT_BASE_URL` can point the whole copilot at any other compatible
/// endpoint without touching code.
const API_BASE: &str = "https://omni.xenv.cc/v1";

/// The models to try, in order, and the reason there is more than one.
///
/// The router labels every model with a `tool_calling` capability, and the
/// whole copilot is function calls - so a provider that reports `false` is not
/// a slower option, it is a broken one. These are the free providers that
/// report `true` AND were measured actually returning calls.
///
/// Ordered by **calls per reply, not by model speed**, which is the
/// counter-intuitive part. Upstream model time is 1-4 s, but the router queues
/// each request for anywhere from 2.7 s to 25.6 s, so a round trip costs far
/// more than the thinking inside it. A model that plans the whole task in one
/// reply is therefore the fast one:
///
/// | model | thinking | calls in one reply | upstream |
/// |---|---|---|---|
/// | `oc/big-pickle` | yes | 4 - the entire plan | 3.3 s |
/// | `oc/deepseek-v4-flash-free` | yes | 2 | 13.4 s |
/// | `oc/nemotron-3-ultra-free` | no | 1 | 3.5 s |
/// | `oc/mimo-v2.5-free` | no | 1 | 0.8 s |
///
/// `oc/mimo-v2.5-free` has the fastest model by a wide margin and is last of
/// the working four, because one call per reply turns a four-step task into
/// four queue waits. Turning thinking off on `big-pickle` via its
/// `effort_tiers` was tried and is worse than either: at `effort: none` the
/// tool calls come back as unassemblable fragments, or not at all.
///
/// `aug/gpt5.6-luna` is last overall because it is the model this app was
/// originally pointed at: it answers 502 in 0.4 s while its provider is
/// disconnected, so carrying it costs almost nothing and the chain picks it up
/// by itself the day that provider is connected.
///
/// Deliberately absent: `oc/hy3-free` and `oc/north-mini-code-free` (report
/// `true`, returned no calls when asked), and every `*-web` provider, which
/// the router itself reports as `tool_calling: false`.
const DEFAULT_MODELS: &[&str] = &[
    "oc/big-pickle",
    "oc/deepseek-v4-flash-free",
    "oc/nemotron-3-ultra-free",
    "oc/mimo-v2.5-free",
    "aug/gpt5.6-luna",
];

/// How often reasoning fragments are forwarded. Fast enough to read as live
/// text, slow enough that a 705-fragment turn costs eight messages a second
/// rather than seven hundred.
const THOUGHT_FLUSH: Duration = Duration::from_millis(120);

/// Bounds a single attempt. Upstream model time is 1-13 s, but the router
/// queues: the same request measured 2.7 s and 25.6 s of wall time on one
/// model. The window is therefore generous; past it the connection is wedged
/// rather than slow, and the panel should say so while the operator is still
/// looking at it.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(90);

/// Three attempts total. The backoff starts at seconds, not milliseconds: the
/// upstream here is a real web session, and a sub-second retry loop is what
/// gets an account throttled for minutes. Speed is worth nothing if the next
/// turn is blocked.
const MAX_RETRIES: u32 = 2;
const FIRST_BACKOFF: Duration = Duration::from_secs(3);

/// How long a turn may stall waiting out a quota. Minutes-long throttles are
/// reported as reply text and handled in the loop; this covers a real HTTP 429
/// with a server-supplied delay. A plan that stops halfway leaves a drone in
/// the air, which is worse than a pause - but past this the wait is no longer
/// a hiccup and the operator gets the aircraft back.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(65);

/// A place the key may live, or the reason its location could not be worked
/// out. The failure is a candidate too: an operator who cannot find the key
/// needs to be told every place that was tried, including the one that did not
/// even resolve to a path.
type KeyLocation = Result<PathBuf, String>;

/// Reused across turns so an agent loop does not pay a TLS handshake per step.
/// The `Result` is stored rather than unwrapped because a client that cannot be
/// built is an operator-visible failure, not a panic.
static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(ATTEMPT_TIMEOUT)
        .build()
        .map_err(|e| format!("could not build the HTTPS client: {e}"))
});

/// The stored build error is cloned rather than re-run: a client that failed
/// to build once will fail identically every turn.
fn client() -> Result<&'static reqwest::Client, String> {
    CLIENT.as_ref().map_err(Clone::clone)
}

/// Split from the env lookup so precedence is testable without mutating
/// process-wide state.
fn resolve_key_from(env_value: Option<String>, locations: &[KeyLocation]) -> Result<String, String> {
    if let Some(raw) = env_value {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    for location in locations {
        let Ok(path) = location else { continue };
        // An unreadable or absent file is not an error, it is just not the
        // place this machine keeps the key.
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    let places = locations
        .iter()
        .map(|location| match location {
            Ok(path) => path.display().to_string(),
            Err(why) => why.clone(),
        })
        .collect::<Vec<_>>()
        .join(", or in ");
    Err(format!(
        "no copilot API key. Set the COPILOT_API_KEY environment variable, \
         or save the key as a single line in {places}."
    ))
}

/// Order is precedence: an env var overrides the installed key, and the
/// manifest-directory file is the dev fallback `.gitignore` already covers.
fn key_locations(app: &tauri::AppHandle) -> Vec<KeyLocation> {
    vec![
        app.path()
            .app_config_dir()
            .map(|dir| dir.join("copilot-key"))
            .map_err(|e| format!("the per-user config directory (unavailable: {e})")),
        Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join(".copilot-key")),
    ]
}

/// The key itself is never logged, echoed, or included in any error - not even
/// a prefix. A wrong key is diagnosed from the router's own 401/403 text.
fn api_key(app: &tauri::AppHandle) -> Result<String, String> {
    resolve_key_from(std::env::var("COPILOT_API_KEY").ok(), &key_locations(app))
}

/// `COPILOT_MODEL` pins one model and disables the chain, because an operator
/// naming a model means that model. `COPILOT_MODELS` replaces the chain with
/// a comma-separated list. Blank entries are dropped rather than turned into
/// a request for a model called "".
fn models_from(single: Option<String>, list: Option<String>) -> Vec<String> {
    if let Some(raw) = single {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return vec![trimmed.to_owned()];
        }
    }
    if let Some(raw) = list {
        let picked: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect();
        if !picked.is_empty() {
            return picked;
        }
    }
    DEFAULT_MODELS.iter().map(|m| (*m).to_owned()).collect()
}

fn model_chain() -> Vec<String> {
    models_from(std::env::var("COPILOT_MODEL").ok(), std::env::var("COPILOT_MODELS").ok())
}

/// The router is OpenAI-shaped, so pointing this at any other OpenAI-compatible
/// endpoint - including a local one - is a single environment variable.
fn base_url() -> String {
    match std::env::var("COPILOT_BASE_URL") {
        Ok(raw) if !raw.trim().is_empty() => raw.trim().trim_end_matches('/').to_owned(),
        _ => API_BASE.to_owned(),
    }
}

/// Gemini reports every refusal as `{"error":{"message":...}}`, and that text
/// is the only thing that distinguishes a malformed tool schema from a revoked
/// key. Surfacing it verbatim is worth more than any wording of ours.
fn server_message(body: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    parsed
        .get("error")?
        .get("message")?
        .as_str()
        .map(str::to_owned)
}

/// Google answers a quota 429 with the exact wait it wants, as a `RetryInfo`
/// detail carrying `retryDelay: "53.6s"`. Guessing instead - the doubling
/// backoff below starts at a fraction of a second - burns all the retries
/// inside the window and reports failure for a request that would have
/// succeeded. So the server's own number wins whenever it sends one.
fn retry_after(body: &str) -> Option<Duration> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let details = parsed.get("error")?.get("details")?.as_array()?;
    for detail in details {
        let Some(delay) = detail.get("retryDelay").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let seconds: f64 = delay.strip_suffix('s')?.parse().ok()?;
        if seconds.is_finite() && seconds >= 0.0 {
            return Some(Duration::from_secs_f64(seconds));
        }
    }
    None
}

/// The one place this file writes Korean. Everything else it returns is a
/// developer-facing transport fault, but these land in the copilot panel and
/// are read mid-flight by a pilot deciding whether to keep the drone up. The
/// quota case in particular arrives as ~400 characters of English billing
/// advice, which is the wrong thing to hand someone holding a live airframe.
fn operator_error(status: u16, body: &str) -> String {
    match status {
        429 => "모델 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.".to_owned(),
        401 | 403 => "API 키가 거부됐습니다. 키를 확인하세요.".to_owned(),
        502 | 503 | 504 => "모델 공급자가 응답하지 않습니다. 다른 모델을 고르거나 잠시 후 다시 시도하세요.".to_owned(),
        // Anything else is rare enough that the server's own words are more
        // use than a category we invented.
        _ => {
            let detail = server_message(body).map_or_else(|| body.to_owned(), |d| d);
            format!("모델 오류 {status}: {detail}")
        }
    }
}

/// Folds an SSE transcript back into one `choices[0].message`.
///
/// Deltas arrive in pieces: content as a string per chunk, and each tool call
/// as an `index`-keyed fragment whose `arguments` are concatenated across
/// chunks. Indexing by the delta's own `index` - rather than appending in
/// arrival order - is what keeps a batch of five calls in the order the model
/// wrote them when their fragments interleave.
fn assemble_stream(sse: &str) -> serde_json::Value {
    let mut content = String::new();
    let mut calls: Vec<(String, String, String)> = Vec::new();

    for line in sse.lines() {
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            continue;
        };
        // A non-streaming server may answer a streamed request anyway; taking
        // `message` when there is no `delta` costs nothing and covers it.
        let Some(delta) = choice.get("delta").or_else(|| choice.get("message")) else {
            continue;
        };

        if let Some(text) = delta.get("content").and_then(serde_json::Value::as_str) {
            content.push_str(text);
        }
        let Some(fragments) = delta.get("tool_calls").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for fragment in fragments {
            let index = fragment
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .map_or(calls.len(), |i| i as usize);
            if calls.len() <= index {
                calls.resize(index + 1, (String::new(), String::new(), String::new()));
            }
            let slot = &mut calls[index];
            if let Some(id) = fragment.get("id").and_then(serde_json::Value::as_str) {
                slot.0 = id.to_owned();
            }
            let Some(function) = fragment.get("function") else {
                continue;
            };
            if let Some(name) = function.get("name").and_then(serde_json::Value::as_str) {
                slot.1.push_str(name);
            }
            if let Some(args) = function.get("arguments").and_then(serde_json::Value::as_str) {
                slot.2.push_str(args);
            }
        }
    }

    let tool_calls: Vec<serde_json::Value> = calls
        .into_iter()
        .enumerate()
        .filter(|(_, (_, name, _))| !name.is_empty())
        .map(|(index, (id, name, arguments))| {
            // A server that never sends ids still needs them: the next turn
            // pairs each result to its call by `tool_call_id`.
            let id = if id.is_empty() { format!("call_{index}") } else { id };
            json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } })
        })
        .collect();

    json!({ "choices": [{ "message": { "role": "assistant", "content": content, "tool_calls": tool_calls } }] })
}

/// Whether an assembled reply is one the agent loop can act on.
///
/// A reply with no `tool_calls` is the failure this chain exists for: the
/// model understood the request and answered in prose anyway. Judged here, and
/// not in the loop, because only this layer can do anything about it - the
/// remedy is a different model, and the loop does not know there are others.
fn has_calls(assembled: &serde_json::Value) -> bool {
    assembled["choices"][0]["message"]["tool_calls"]
        .as_array()
        .is_some_and(|calls| !calls.is_empty())
}

/// Drains the response, reporting each tool call the moment it is named and
/// each fragment of `done`'s summary as it is written.
///
/// Measured on `oc/big-pickle`: a reply is silent while the model thinks, then
/// its 72 argument fragments arrive across half a second, and a long prose
/// answer streams over seven. None of that was visible while the body was read
/// with `.text()`, which waits for the last byte before anything is shown. The
/// thinking pause is still a pause - nothing can invent output that does not
/// exist yet - but everything after it now lands as it is produced.
async fn drain_stream(
    response: reqwest::Response,
    notice: &Channel<serde_json::Value>,
) -> Result<String, String> {
    let mut body = response.bytes_stream();
    let mut raw = String::new();
    let mut pending = String::new();
    // Named as they are seen, so a row can appear before its arguments finish.
    let mut announced = 0usize;
    let mut summary_seen = false;
    // The model's reasoning arrives as hundreds of tiny fragments - 705 on one
    // measured turn - and one IPC message each would cost more than it shows.
    // They are coalesced and flushed on a human-readable cadence instead.
    let mut thought = String::new();
    let mut flushed = std::time::Instant::now();

    while let Some(chunk) = body.next().await {
        let bytes = chunk.map_err(|e| format!("모델 응답이 끊겼습니다: {e}"))?;
        pending.push_str(&String::from_utf8_lossy(&bytes));
        raw.push_str(&String::from_utf8_lossy(&bytes));

        // Only whole lines are parseable; a split frame waits for its rest.
        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            let Some(payload) = line.trim_end().strip_prefix("data: ") else {
                continue;
            };
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            let delta = &frame["choices"][0]["delta"];

            // Whatever the provider calls its reasoning channel. The router's
            // own readiness check accepts all four spellings, so all four are
            // read here rather than betting on one.
            for key in ["reasoning_content", "reasoning", "thinking"] {
                if let Some(text) = delta[key].as_str() {
                    thought.push_str(text);
                }
            }
            if !thought.is_empty() && flushed.elapsed() >= THOUGHT_FLUSH {
                let _ = notice.send(json!({ "thinking": thought }));
                thought.clear();
                flushed = std::time::Instant::now();
            }

            let Some(fragments) = delta["tool_calls"].as_array() else {
                continue;
            };
            for fragment in fragments {
                if let Some(name) = fragment["function"]["name"].as_str() {
                    if !name.is_empty() {
                        announced += 1;
                        let _ = notice.send(json!({ "calling": name, "index": announced }));
                        summary_seen = name == "done";
                    }
                }
                // `done`'s argument fragments are the summary the pilot reads,
                // so they are forwarded verbatim and reassembled by the panel.
                if summary_seen {
                    if let Some(args) = fragment["function"]["arguments"].as_str() {
                        if !args.is_empty() {
                            let _ = notice.send(json!({ "summaryChunk": args }));
                        }
                    }
                }
            }
        }
    }
    if !thought.is_empty() {
        let _ = notice.send(json!({ "thinking": thought }));
    }
    Ok(raw)
}

/// One HTTP attempt against one model, with the transport retries.
async fn ask_model(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    payload: &[u8],
    notice: &Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut backoff = FIRST_BACKOFF;
    for attempt in 0..=MAX_RETRIES {
        let response = client
            .post(url)
            .bearer_auth(key)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(payload.to_vec())
            .send()
            .await
            .map_err(|e| format!("모델 요청 실패: {e}"))?;

        let status = response.status();
        // A failed status carries an error body, not a stream worth narrating.
        let text = if status.is_success() {
            drain_stream(response, notice).await?
        } else {
            response
                .text()
                .await
                .map_err(|e| format!("모델 응답을 읽지 못했습니다: {e}"))?
        };

        if status.is_success() {
            return Ok(assemble_stream(&text));
        }

        // A bad key, a malformed schema or a revoked project will fail exactly
        // the same way on the next try, and retrying only delays the message
        // the operator needs.
        let transient = status.as_u16() == 429 || status.is_server_error();
        if !transient || attempt == MAX_RETRIES {
            return Err(operator_error(status.as_u16(), &text));
        }
        let wait = retry_after(&text).unwrap_or(backoff);
        if wait > MAX_RETRY_WAIT {
            return Err(operator_error(status.as_u16(), &text));
        }
        // Only worth announcing when it is long enough to look like a hang;
        // the sub-second backoff is invisible either way.
        if wait >= Duration::from_secs(2) {
            let _ = notice.send(json!({ "waitingSeconds": wait.as_secs_f64() }));
        }
        tokio::time::sleep(wait).await;
        backoff *= 2;
    }
    // `0..=MAX_RETRIES` always returns or sleeps, so this is unreachable; it
    // exists because the compiler cannot see that.
    Err("모델 재시도를 모두 소진했습니다".to_owned())
}

/// One model turn. `body` carries the frontend's `messages` and `tools`; the
/// model id and `stream: true` are merged in here because both are transport
/// facts, and the streamed deltas are folded back into a single response so
/// the loop never sees SSE.
///
/// Each model in the chain is tried until one returns tool calls. A provider
/// being disconnected, rate-limited or simply unwilling to call a tool is
/// routine on a free router, and every one of those looks identical to the
/// loop above: a turn that did nothing. Trying the next model is cheaper than
/// asking the same one again, and far cheaper than stranding a drone.
///
/// `notice` carries what the operator cannot infer from a pending promise: a
/// deliberate wait, and which model ended up answering.
#[tauri::command]
pub async fn copilot_turn(
    app: tauri::AppHandle,
    body: serde_json::Value,
    notice: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let key = api_key(&app)?;
    let url = format!("{}/chat/completions", base_url());
    let chain = model_chain();

    let mut request = body;
    {
        let Some(fields) = request.as_object_mut() else {
            return Err("request body must be an object".to_owned());
        };
        // Not negotiable: the router drops `tool_calls` entirely when false.
        fields.insert("stream".to_owned(), json!(true));
    }

    let client = client()?;
    let mut last: Option<serde_json::Value> = None;
    let mut failure: Option<String> = None;

    for (index, model) in chain.iter().enumerate() {
        // Scoped so the body can be serialized again on the next model.
        if let Some(fields) = request.as_object_mut() {
            fields.insert("model".to_owned(), json!(model));
        }
        let payload = serde_json::to_vec(&request)
            .map_err(|e| format!("request body is not serializable: {e}"))?;

        match ask_model(client, &url, &key, &payload, &notice).await {
            Ok(assembled) => {
                if has_calls(&assembled) {
                    // Worth saying out loud: a plan flown by the fourth model
                    // in the chain is a different fact from one flown by the
                    // first, and only this layer knows which happened.
                    let _ = notice.send(json!({ "model": model, "fellBack": index > 0 }));
                    return Ok(assembled);
                }
                last = Some(assembled);
            }
            Err(message) => failure = Some(message),
        }
    }

    // Nothing in the chain produced a call. A prose reply is more use to the
    // loop than a transport error, because the model's own words are the only
    // clue left; a transport error is reported only when there is no reply.
    match last {
        Some(assembled) => {
            let _ = notice.send(json!({ "model": chain.last(), "fellBack": chain.len() > 1 }));
            Ok(assembled)
        }
        None => Err(failure.unwrap_or_else(|| "설정된 모델이 없습니다".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Per-test scratch file. The process id keeps concurrent `cargo test`
    /// runs apart; the counter keeps tests within one run apart.
    fn scratch(contents: &str) -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aidrone-copilot-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        let path = dir.join("copilot-key");
        fs::write(&path, contents).expect("scratch key");
        path
    }

    #[test]
    fn env_beats_every_file() {
        let installed = scratch("installed-key");
        let dev = scratch("dev-key");
        assert_eq!(
            resolve_key_from(Some("env-key".to_owned()), &[Ok(installed), Ok(dev)]),
            Ok("env-key".to_owned())
        );
    }

    #[test]
    fn installed_file_beats_dev_fallback_and_is_trimmed() {
        let installed = scratch("  installed-key\r\n");
        let dev = scratch("dev-key");
        assert_eq!(
            resolve_key_from(None, &[Ok(installed), Ok(dev)]),
            Ok("installed-key".to_owned())
        );
    }

    /// A blank env var or a file left behind by a half-finished setup is not a
    /// key; treating it as one would send an empty header and get an opaque 400.
    #[test]
    fn blank_candidates_fall_through_to_the_next_place() {
        let empty = scratch("\n  \n");
        let dev = scratch("dev-key");
        assert_eq!(
            resolve_key_from(Some("   ".to_owned()), &[Ok(empty), Ok(dev)]),
            Ok("dev-key".to_owned())
        );
    }

    #[test]
    fn an_absent_file_is_skipped_not_fatal() {
        let missing = std::env::temp_dir().join("aidrone-copilot-does-not-exist/copilot-key");
        let dev = scratch("dev-key");
        assert_eq!(
            resolve_key_from(None, &[Ok(missing), Ok(dev)]),
            Ok("dev-key".to_owned())
        );
    }

    /// The whole point of the failure message: an operator fixes the setup
    /// from the text alone, without opening this file.
    #[test]
    fn missing_key_names_all_three_places() {
        let unresolved = "the per-user config directory (unavailable: no home)".to_owned();
        let dev = PathBuf::from("D:/app/src-tauri/.copilot-key");
        let error = resolve_key_from(None, &[Err(unresolved.clone()), Ok(dev.clone())])
            .expect_err("no key anywhere");
        assert!(error.contains("COPILOT_API_KEY"), "{error}");
        assert!(error.contains(&unresolved), "{error}");
        assert!(error.contains(&dev.display().to_string()), "{error}");
    }

    #[test]
    fn no_error_ever_carries_the_key() {
        let error = resolve_key_from(None, &[Ok(scratch("   "))]).expect_err("blank file");
        assert!(!error.contains("copilot-key\":"), "{error}");
        assert!(error.contains("single line"), "{error}");
    }

    #[test]
    fn the_chain_defaults_to_every_verified_tool_capable_model() {
        assert_eq!(models_from(None, None), DEFAULT_MODELS);
        assert_eq!(models_from(Some(String::new()), None), DEFAULT_MODELS);
        assert_eq!(models_from(Some("  \n".to_owned()), None), DEFAULT_MODELS);
        // Every default must be a real router id, not a typo that silently
        // costs one link of the chain.
        for model in DEFAULT_MODELS {
            assert!(model.contains('/'), "{model} is not a provider-qualified id");
        }
    }

    #[test]
    fn naming_one_model_disables_the_chain() {
        // An operator who names a model means that model: falling back past it
        // would fly the drone on something they did not choose.
        assert_eq!(models_from(Some(" oc/big-pickle \n".to_owned()), None), vec!["oc/big-pickle"]);
        // COPILOT_MODEL wins over COPILOT_MODELS, being the more specific one.
        assert_eq!(
            models_from(Some("oc/big-pickle".to_owned()), Some("a/b,c/d".to_owned())),
            vec!["oc/big-pickle"]
        );
    }

    #[test]
    fn a_custom_chain_is_split_and_cleaned() {
        assert_eq!(models_from(None, Some("a/b, c/d ,e/f".to_owned())), vec!["a/b", "c/d", "e/f"]);
        // Trailing commas and blanks are punctuation, not a request for a
        // model called "".
        assert_eq!(models_from(None, Some("a/b,,  ,c/d,".to_owned())), vec!["a/b", "c/d"]);
        // An entirely empty list is not a chain of nothing; it is no opinion.
        assert_eq!(models_from(None, Some(" , ".to_owned())), DEFAULT_MODELS);
    }

    #[test]
    fn a_reply_is_usable_only_when_it_carries_calls() {
        // This is what decides whether the chain moves on, so an empty array
        // and a missing key must both read as "this model declined".
        let with = assemble_stream(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"observe\",\"arguments\":\"{}\"}}]}}]}\n",
        );
        assert!(has_calls(&with));

        let prose = assemble_stream("data: {\"choices\":[{\"delta\":{\"content\":\"못 합니다\"}}]}\n");
        assert!(!has_calls(&prose));
        assert!(!has_calls(&serde_json::json!({})));
    }

    #[test]
    fn server_error_message_is_extracted_from_the_google_envelope() {
        let body = r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}"#;
        assert_eq!(
            server_message(body).as_deref(),
            Some("API key not valid. Please pass a valid API key.")
        );
        assert_eq!(server_message("not json at all"), None);
        assert_eq!(server_message(r#"{"error":{"code":400}}"#), None);
    }

    #[test]
    fn quota_retry_delay_is_taken_from_the_server() {
        // The exact envelope a free-tier 429 returns, trimmed to the details.
        let body = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[
            {"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[]},
            {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"53.681565701s"}]}}"#;
        let wait = retry_after(body).expect("retry delay");
        assert!((wait.as_secs_f64() - 53.681_565_701).abs() < 1e-6, "{wait:?}");
        assert!(wait < MAX_RETRY_WAIT, "a free-tier wait must be worth sitting out");

        // Whole seconds are the documented form and must parse identically.
        let whole = r#"{"error":{"details":[{"retryDelay":"7s"}]}}"#;
        assert_eq!(retry_after(whole), Some(Duration::from_secs(7)));

        // No RetryInfo, no details, not JSON: the caller falls back to backoff.
        assert_eq!(retry_after(r#"{"error":{"details":[{"@type":"x"}]}}"#), None);
        assert_eq!(retry_after(r#"{"error":{"code":500}}"#), None);
        assert_eq!(retry_after("not json"), None);
        // A malformed duration is not a zero-second wait.
        assert_eq!(retry_after(r#"{"error":{"details":[{"retryDelay":"soon"}]}}"#), None);
    }

    #[test]
    fn the_pilot_gets_a_short_korean_line_for_the_two_routine_faults() {
        // The real free-tier body: 400-odd characters of billing advice.
        let quota = r#"{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.","status":"RESOURCE_EXHAUSTED"}}"#;
        let shown = operator_error(429, quota);
        assert!(shown.contains("한도"), "{shown}");
        assert!(!shown.contains("billing"), "the provider's copy must not reach the panel: {shown}");
        assert!(shown.chars().count() < 60, "a mid-flight line must be readable at a glance: {shown}");

        let bad_key = r#"{"error":{"code":403,"message":"API key not valid."}}"#;
        assert!(operator_error(403, bad_key).contains("키"), "{bad_key}");

        // A dead upstream provider is routine on this router - `aug/*` was
        // 502 on every probe - so it gets a line that says what to do.
        let gateway = operator_error(502, "<!DOCTYPE html><title>502 Bad gateway</title>");
        assert!(gateway.contains("공급자"), "{gateway}");
        assert!(!gateway.contains("DOCTYPE"), "an HTML error page must not reach the panel: {gateway}");

        // Anything unexpected still surfaces the server's own words verbatim,
        // because inventing a category would hide the only clue there is.
        let odd = r#"{"error":{"code":400,"message":"tool schema is malformed"}}"#;
        let passthrough = operator_error(400, odd);
        assert!(passthrough.contains("tool schema is malformed"), "{passthrough}");
        assert!(passthrough.contains("400"), "{passthrough}");
    }

    /// Reads the assembled shape the loop consumes.
    fn calls_of(v: &serde_json::Value) -> Vec<(String, String)> {
        v["choices"][0]["message"]["tool_calls"]
            .as_array()
            .expect("tool_calls")
            .iter()
            .map(|c| {
                (
                    c["function"]["name"].as_str().unwrap_or_default().to_owned(),
                    c["function"]["arguments"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn a_streamed_batch_is_folded_back_in_the_order_the_model_wrote_it() {
        // Arguments split across chunks, and the second call's fragments
        // interleaved with the first's - the case that breaks append-in-order.
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"fly\",\"arguments\":\"{\\\"action\\\"\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"b\",\"function\":{\"name\":\"rotate\",\"arguments\":\"{\\\"degrees\\\":90}\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"takeoff\\\"}\"}}]}}]}\n",
            "data: [DONE]\n"
        );
        let assembled = assemble_stream(sse);
        assert_eq!(
            calls_of(&assembled),
            vec![
                ("fly".to_owned(), r#"{"action":"takeoff"}"#.to_owned()),
                ("rotate".to_owned(), r#"{"degrees":90}"#.to_owned()),
            ]
        );
    }

    #[test]
    fn prose_only_and_junk_streams_yield_no_calls_rather_than_a_wrong_one() {
        // What the backend returns when it has lost the tools; the loop reads
        // the empty list as "re-ask", so inventing a call here would fly it.
        let prose = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"드론 제어 도구가 \"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"연결되어 있지 않습니다.\"}}]}\n",
            "data: [DONE]\n"
        );
        let assembled = assemble_stream(prose);
        assert!(calls_of(&assembled).is_empty());
        assert_eq!(
            assembled["choices"][0]["message"]["content"],
            "드론 제어 도구가 연결되어 있지 않습니다."
        );

        // Half-written lines and non-JSON must be skipped, not panic.
        assert!(calls_of(&assemble_stream("data: {oops\n\ndata: [DONE]\n")).is_empty());
        assert!(calls_of(&assemble_stream("")).is_empty());
    }

    #[test]
    fn a_call_without_an_id_still_gets_one_so_results_can_be_paired() {
        let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"observe\",\"arguments\":\"{}\"}}]}}]}\n";
        let assembled = assemble_stream(sse);
        let id = assembled["choices"][0]["message"]["tool_calls"][0]["id"]
            .as_str()
            .expect("id");
        assert!(!id.is_empty(), "a result with no tool_call_id cannot be matched to its call");
    }

    #[test]
    fn a_non_streaming_server_answering_a_streamed_request_still_parses() {
        // Some backends ignore `stream` and send one `message` chunk.
        let sse = "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"index\":0,\"id\":\"z\",\"function\":{\"name\":\"observe\",\"arguments\":\"{}\"}}]}}]}\n";
        assert_eq!(calls_of(&assemble_stream(sse)), vec![("observe".to_owned(), "{}".to_owned())]);
    }
}
