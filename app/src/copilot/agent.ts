/**
 * The copilot's turn loop.
 *
 * The shape that matters: Gemini answers one turn with **several** function
 * calls, not one. A loop that reads only the first would turn "take off, spin,
 * and look" into "take off", then need two more round trips to finish a plan
 * the model had already written. So every `functionCall` part is executed, in
 * order, and every result goes back in the same turn.
 *
 * Nothing here touches the DOM, the transport, or the drone. Everything arrives
 * through `CopilotPort`, which is what lets the tests fly a fake aircraft with
 * a scripted model.
 */
import { decodeToolCall, isToolCall, TOOL_SCHEMA, type ToolCall } from "./tools.ts";

/** What `observe` reports: the only source of scene truth the model has. */
export type DroneScene = Readonly<{
  battery: number | null;
  heightCm: number | null;
  flightSeconds: number | null;
  mode: "key" | "person" | "aruco";
  airborne: boolean | null;
  targets: readonly Readonly<{
    id: number;
    kind: "marker" | "person";
    widthPx: number;
    centerX: number;
    confidence?: number;
  }>[];
  lockedId: number | null;
  followPhase: "idle" | "following" | "searching" | "halted";
  frame: Readonly<{ width: number; height: number }> | null;
}>;

export type AgentStepState = "running" | "ok" | "failed" | "cancelled";

export type AgentStep = Readonly<{
  index: number;
  /** Null when the model asked for something that could not be decoded. */
  call: ToolCall | null;
  label: string;
  state: AgentStepState;
  detail?: string;
}>;

/**
 * What the loop is doing while nothing is on screen.
 *
 * A turn against this backend takes 8-19 s and a re-ask doubles it, so the
 * gap between pressing send and the first tool row is the single worst part
 * of using the copilot. The panel cannot invent this - only the loop knows
 * whether it is on its first ask or its third - so it is reported.
 */
export type AgentActivity =
  | { readonly kind: "thinking"; readonly attempt: number; readonly of: number }
  | { readonly kind: "running" }
  | { readonly kind: "waiting"; readonly ms: number };

export interface CopilotPort {
  /** Posts one turn body and returns the parsed response. */
  turn(body: unknown): Promise<unknown>;
  /** Runs one decoded tool. Rejecting is fine: the model is told and adapts. */
  run(call: ToolCall): Promise<Record<string, unknown>>;
  observe(): Promise<DroneScene>;
  onStep(step: AgentStep): void;
  /** Live progress for the panel. Fires often; the panel decides what to draw. */
  onActivity(activity: AgentActivity): void;
  /** Checked between calls, so a cancel lands within one tool rather than one turn. */
  cancelled(): boolean;
  /** Paces re-asks. Injected so tests do not spend real seconds waiting. */
  sleep(ms: number): Promise<void>;
}

export type CopilotOutcome = Readonly<{
  summary: string;
  steps: readonly AgentStep[];
}>;

/**
 * Deliberately explicit about the things a language model cannot see: that the
 * aircraft is real, that only `observe` reports the scene, that a lock is not a
 * note-to-self but the switch that starts the drone flying itself, and that the
 * pilot reading the result does so in Korean.
 */
export const SYSTEM_INSTRUCTION = [
  "You fly a real DJI Tello over a live radio link. Every tool call moves real hardware.",
  "You cannot see the video. `observe` is the only way to learn what is in frame, what the battery is, and whether the drone is airborne.",
  // Units and durations, because the model was observed guessing at both:
  // clamping a metre-scale move into one capped call, and treating `wait` as
  // if it could hold for a minute.
  "UNITS: distances are centimetres (1 m = 100 cm), rotations are degrees, `speed` is cm/s, `wait` is seconds. Convert before calling - a request in metres or minutes is still sent in cm and seconds.",
  "LIMITS are hard, and the way past one is REPETITION, never a smaller number in its place: one `fly` move is capped at 500 cm, one `rotate` at 360 degrees, one `wait` at 20 s. To go 12 m, call `fly forward 500`, `fly forward 500`, `fly forward 200` - do not quietly fly 5 m instead. To wait a minute, call `wait 20` three times.",
  "DURATION: a `fly` move travels a distance and blocks until it lands, and how long that takes is distance / `speed` (default 100 cm/s, settable 10-100). So \"go forward for 5 seconds\" is not a tool - it is `speed` plus a distance you calculate. `wait` is the only tool that spends time without moving.",
  "`lock` does not merely select a target - it starts autonomous following, and the drone flies itself toward that target until `unlock`. Marker ids exist only in aruco mode and track ids only in person mode, so `set_mode` first, then `observe`, then `lock` the id that observe reported.",
  // The three ways this model was observed to stall, each stated as a ban.
  // Without them it re-observed an unchanged scene four times, took off twice,
  // and never reached the rotation it had been asked for.
  "NEVER call `observe` twice without a real action between them. The scene does not change on its own; if the last observe already answered your question, act on it.",
  "NEVER call `fly takeoff` when the last `observe` reported `airborne: true`. It is already flying - move on to the next step.",
  "NEVER repeat a call that just succeeded. Repeating is how a plan stalls; if you are unsure what to do next, call `done` and say so.",
  "Emit every call you already know you need in the SAME reply, in order. A three-step plan you have already decided on is ONE reply with three calls, not three replies. Wait for a result only when the next step genuinely depends on it.",
  "If a tool reports an error, read it and adapt rather than repeating the same call.",
  "Call `done` as soon as the task is complete, or when it cannot be completed, and say plainly which of the two happened.",
  "`done`'s summary is read by the pilot as the record of the flight: describe only calls you actually made in THIS task and results you actually received. A step you skipped because it was already true - the drone was already airborne, the marker was already locked - was not an action you performed, and reporting it as one is a false flight record.",
  "Write every word the pilot reads in Korean - `done`'s summary and any prose you return alongside your calls. Tool names, tool arguments and SDK strings stay exactly as specified: they are protocol, not prose.",
].join(" ");

const DEFAULT_MAX_TURNS = 8;


/**
 * How many times one turn is re-asked when the reply carries no tool calls.
 *
 * One, now. Rust already walks a chain of tool-capable models and only returns
 * a reply that carries calls, so by the time an empty one reaches here every
 * provider has declined - and asking the last of them a fifth time is not the
 * remedy, it is just four more seconds of hover. The single re-ask is kept
 * because a nudge does occasionally shake one loose, and because a model that
 * answers prose twice in a row is a fact worth reporting rather than a fluke.
 *
 * The pause stays: a tight loop against a free provider is indistinguishable
 * from abuse, and the throttle it earns costs minutes.
 */
const TOOL_RETRIES = 1;
const RETRY_PAUSE_MS = 3_000;

const NUDGE =
  "도구를 실제로 호출하세요. 설명이나 사과 대신 tool call만 내보내세요. 도구는 지금 연결되어 있습니다.";

/**
 * The upstream session's own throttle notice, which arrives as ordinary reply
 * text rather than an HTTP status - so nothing below the model layer can see
 * it. Matching on the stable fragments of both wordings.
 */
const THROTTLE_MARKERS = [
  "너무 빠르게",
  "일시적으로 제한",
  "too many requests",
  "rate limit",
  "temporarily",
] as const;

function isThrottleNotice(said: string): boolean {
  const text = said.toLowerCase();
  return THROTTLE_MARKERS.some((marker) => text.includes(marker));
}

/** Reads one property off an unknown value, or null if it is not there. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const record: Record<string, unknown> = { ...value };
  return record[key];
}

/**
 * The model's reply is external input, so it is narrowed rather than asserted:
 * every field below is checked before it is read, and anything unexpected
 * simply yields no calls instead of a plausible-looking wrong one.
 */
function replyMessage(response: unknown): unknown {
  const choices = field(response, "choices");
  if (!Array.isArray(choices) || choices.length === 0) return null;
  return field(choices[0], "message");
}

/** One `tool_calls` entry, still unvalidated - `decodeToolCall` judges it. */
type RawCall = { id: string; name: unknown; args: unknown };

/**
 * Reads every call the model emitted, in order. `arguments` arrives as a JSON
 * *string*, and a model that writes malformed JSON has made a mistake worth
 * reporting, so a parse failure becomes an undecodable call rather than a
 * silently dropped one.
 */
function toolCalls(response: unknown): RawCall[] {
  const message = replyMessage(response);
  const raw = field(message, "tool_calls");
  if (!Array.isArray(raw)) return [];

  const calls: RawCall[] = [];
  for (const [index, entry] of raw.entries()) {
    const fn = field(entry, "function");
    if (fn === null) continue;
    const rawId = field(entry, "id");
    const id = typeof rawId === "string" && rawId !== "" ? rawId : `call_${index}`;
    const text = field(fn, "arguments");
    let args: unknown = {};
    if (typeof text === "string" && text.trim() !== "") {
      try {
        args = JSON.parse(text);
      } catch {
        args = text; // not an object -> the decoder refuses it with a reason
      }
    }
    calls.push({ id, name: field(fn, "name"), args });
  }
  return calls;
}

/** Any prose the model returned alongside its calls, for the transcript. */
function spokenText(response: unknown): string {
  const said = field(replyMessage(response), "content");
  return typeof said === "string" ? said.trim() : "";
}

function label(call: ToolCall): string {
  switch (call.tool) {
    case "fly":
      return call.cm === null ? call.action : `${call.action} ${call.cm}cm`;
    case "rotate":
      return `${call.direction} ${call.degrees}°`;
    case "flip":
      return `flip ${call.direction}`;
    case "speed":
      return `speed ${call.cms}`;
    case "set_mode":
      return `mode ${call.mode}`;
    case "lock":
      return `lock ${call.id}`;
    case "wait":
      return `wait ${call.seconds}s`;
    case "done":
      return "done";
    default:
      return call.tool;
  }
}

/** One finished task, kept so the next one can refer back to it. */
export type TaskMemory = Readonly<{ instruction: string; summary: string }>;

export async function runCopilotTask(
  instruction: string,
  port: CopilotPort,
  options: { maxTurns?: number; history?: readonly TaskMemory[] } = {},
): Promise<CopilotOutcome> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const steps: AgentStep[] = [];

  // Earlier tasks come back as their instruction and their outcome, never
  // their tool traffic. Two reasons, both about safety rather than tokens:
  // a replayed `observe` result is a scene that no longer exists, and this
  // model has a demonstrated appetite for re-running a plan it can still see.
  // A summary is a memory; a transcript is an invitation.
  const messages: unknown[] = [{ role: "system", content: SYSTEM_INSTRUCTION }];
  for (const past of options.history ?? []) {
    messages.push({ role: "user", content: past.instruction });
    messages.push({ role: "assistant", content: past.summary });
  }
  if ((options.history ?? []).length > 0) {
    // Said once, plainly: everything above is history, and the drone has moved
    // since. Without this the model treats the last summary as current state.
    messages.push({
      role: "user",
      content:
        "위 대화는 지난 작업의 기록입니다. 드론과 주변 상황은 그 뒤로 바뀌었을 수 있으니, " +
        "장면에 의존하는 판단은 반드시 observe로 다시 확인하세요.",
    });
  }
  messages.push({ role: "user", content: instruction });

  const emit = (step: AgentStep): void => {
    steps.push(step);
    port.onStep(step);
  };
  /** Replaces the last emitted step in place, so the UI shows one row settle. */
  const settle = (step: AgentStep, state: AgentStepState, detail?: string): AgentStep => {
    const done: AgentStep = detail === undefined ? { ...step, state } : { ...step, state, detail };
    steps[steps.length - 1] = done;
    port.onStep(done);
    return done;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (port.cancelled()) return { summary: "조종자가 중단했습니다.", steps };

    // Ask, and re-ask when the reply carries no calls. The nudge is appended
    // rather than the same bytes resent, because a backend that has dropped
    // the tools once tends to answer the identical request the same way;
    // naming the failure is what breaks it out.
    let response: unknown = null;
    let calls: RawCall[] = [];
    let throttled = false;
    for (let attempt = 0; attempt <= TOOL_RETRIES; attempt++) {
      if (port.cancelled()) return { summary: "조종자가 중단했습니다.", steps };
      port.onActivity({ kind: "thinking", attempt: attempt + 1, of: TOOL_RETRIES + 1 });
      response = await port.turn({ messages, tools: TOOL_SCHEMA });
      calls = toolCalls(response);
      if (calls.length > 0) break;
      if (isThrottleNotice(spokenText(response))) {
        throttled = true;
        break;
      }
      if (attempt < TOOL_RETRIES) {
        messages.push({ role: "user", content: NUDGE });
        port.onActivity({ kind: "waiting", ms: RETRY_PAUSE_MS });
        await port.sleep(RETRY_PAUSE_MS);
      }
    }
    port.onActivity({ kind: "running" });

    if (throttled) {
      // Retrying is what caused this, and the block lasts minutes, so the loop
      // stops and hands the aircraft back. Saying it is still flying is the
      // point: nothing below has landed it.
      return {
        summary: "모델 계정이 요청 속도 제한에 걸렸습니다. 드론은 그대로 떠 있으니 착륙시키고 몇 분 뒤 다시 시도하세요.",
        steps,
      };
    }

    if (calls.length === 0) {
      // Out of re-asks. The model's own words here are almost always "I have
      // no drone tools", which is FALSE - the schema was sent every time and
      // the backend dropped it. Repeating that verbatim sends the operator
      // looking for a wiring fault that does not exist, so the panel gets the
      // real diagnosis and the model's line is kept only as evidence.
      const said = spokenText(response);
      const cause = `모델이 ${TOOL_RETRIES + 1}번 모두 도구 호출 없이 답했습니다. 도구는 매번 함께 보냈으므로 앱 설정 문제가 아니라 모델 쪽 문제입니다. 잠시 후 다시 시도하세요.`;
      return { summary: said === "" ? cause : `${cause}\n\n모델의 답: ${said}`, steps };
    }

    // The standard protocol: the model's own `tool_calls`, then one `tool`
    // message per result keyed by `tool_call_id`. An earlier build restated
    // all of this as plain user text, because the web-scraping provider it
    // then pointed at discarded `tool` messages outright and so learned
    // nothing from its own actions. The providers in the chain now report
    // `tool_calling: true` and were verified reading a value back out of a
    // `tool` message, so the workaround is gone.
    messages.push({
      role: "assistant",
      content: spokenText(response),
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: String(call.name), arguments: JSON.stringify(call.args ?? {}) },
      })),
    });

    const results: unknown[] = [];
    for (const raw of calls) {
      if (port.cancelled()) {
        const stopped: AgentStep = {
          index: steps.length,
          call: null,
          label: String(raw.name ?? "?"),
          state: "cancelled",
        };
        emit(stopped);
        return { summary: "조종자가 중단했습니다.", steps };
      }

      const decoded = decodeToolCall(raw.name, raw.args);
      if (!isToolCall(decoded)) {
        // A malformed call is a correctable mistake, not the end of the task:
        // hand the reason back and let the next turn fix it.
        const step: AgentStep = { index: steps.length, call: null, label: String(raw.name ?? "?"), state: "running" };
        emit(step);
        settle(step, "failed", decoded.error);
        results.push({ role: "tool", tool_call_id: raw.id, content: JSON.stringify({ error: decoded.error }) });
        continue;
      }

      if (decoded.tool === "done") {
        const step: AgentStep = { index: steps.length, call: decoded, label: "done", state: "ok" };
        emit(step);
        return { summary: decoded.summary, steps };
      }

      const step: AgentStep = { index: steps.length, call: decoded, label: label(decoded), state: "running" };
      emit(step);
      try {
        // Split rather than unioned: the two results carry different shapes,
        // and branching here keeps both statically typed instead of asking a
        // runtime check to tell them apart.
        if (decoded.tool === "observe") {
          const scene = await port.observe();
          settle(step, "ok", describeScene(scene));
          results.push({ role: "tool", tool_call_id: raw.id, content: JSON.stringify(scene) });
        } else {
          const result = await port.run(decoded);
          settle(step, "ok", describeResult(result));
          results.push({ role: "tool", tool_call_id: raw.id, content: JSON.stringify(result) });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        settle(step, "failed", message);
        results.push({ role: "tool", tool_call_id: raw.id, content: JSON.stringify({ error: message }) });
      }
    }

    // Each result is its own message, paired to its call by `tool_call_id`.
    messages.push(...results);
  }

  return {
    summary: `${maxTurns}턴 안에 끝내지 못해 중단했습니다. 남은 작업은 지시를 나눠서 다시 요청해 주세요.`,
    steps,
  };
}

/** One short line for the step row; the model still receives the full object. */
function describeScene(scene: DroneScene): string {
  const seen = scene.targets.map((target) => `${target.kind[0]}${target.id}`).join(" ");
  return `bat ${scene.battery ?? "--"} · ${scene.mode} · ${scene.targets.length > 0 ? seen : "대상 없음"}`;
}

function describeResult(result: Record<string, unknown>): string {
  const reply = result["reply"];
  if (typeof reply === "string" && reply !== "") return reply;
  const ok = result["ok"];
  if (typeof ok === "boolean") return ok ? "ok" : "실패";
  return "";
}
