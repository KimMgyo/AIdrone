import { describe, expect, test } from "bun:test";
import { runCopilotTask, type AgentActivity, type AgentStep, type CopilotPort, type DroneScene } from "./agent.ts";
import { decodeToolCall, isToolCall, type ToolCall } from "./tools.ts";

const SCENE: DroneScene = {
  battery: 82,
  heightCm: 90,
  flightSeconds: 12,
  mode: "aruco",
  airborne: true,
  targets: [{ id: 0, kind: "marker", widthPx: 140, centerX: 500 }],
  lockedId: null,
  followPhase: "idle",
  frame: { width: 960, height: 720 },
};

/** One model turn: the tool calls it would emit, in order. */
function turnOf(...calls: { name: string; args?: Record<string, unknown> }[]): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map((call, index) => ({
            id: `call_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        },
      },
    ],
  };
}

/** A turn that carries prose but no calls - what a backend that lost the tools returns. */
function proseTurn(text: string): unknown {
  return { choices: [{ message: { role: "assistant", content: text } }] };
}

type Harness = {
  port: CopilotPort;
  ran: ToolCall[];
  steps: AgentStep[];
  activity: AgentActivity[];
  bodies: unknown[];
  cancel: () => void;
};

function harness(turns: unknown[], options: { failOn?: string } = {}): Harness {
  const ran: ToolCall[] = [];
  const steps: AgentStep[] = [];
  const activity: AgentActivity[] = [];
  const bodies: unknown[] = [];
  let cancelled = false;
  let index = 0;

  return {
    ran,
    steps,
    activity,
    bodies,
    cancel: () => {
      cancelled = true;
    },
    port: {
      async turn(body) {
        // The loop mutates one `messages` array in place, so a stored
        // reference would show every turn the final state. Snapshot what was
        // actually on the wire at this moment.
        bodies.push(structuredClone(body));
        const next = turns[index++];
        // Running past the script is a test bug, not a model behaviour.
        if (next === undefined) throw new Error(`no scripted turn ${index}`);
        return next;
      },
      async run(call) {
        if (options.failOn === call.tool) throw new Error(`${call.tool} refused by the drone`);
        ran.push(call);
        return { ok: true, reply: "ok" };
      },
      async observe() {
        ran.push({ tool: "observe" });
        return SCENE;
      },
      onStep(step) {
        steps.push(step);
      },
      onActivity(next) {
        activity.push(next);
      },
      cancelled: () => cancelled,
      // Pacing is real in the app and instant here; the tests assert what was
      // sent, not how long the loop politely waited between asks.
      sleep: async () => {},
    },
  };
}

/** The `messages` array the loop sent on a given turn. */
function messagesOf(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null || !("messages" in body)) throw new Error("no messages");
  const { messages } = body;
  if (!Array.isArray(messages)) throw new Error("messages is not an array");
  return messages;
}

describe("runCopilotTask", () => {
  test("runs every call of a multi-call turn, in the order the model wrote them", async () => {
    const h = harness([
      turnOf({ name: "fly", args: { action: "takeoff" } }, { name: "rotate", args: { direction: "cw", degrees: 360 } }, { name: "observe" }),
      turnOf({ name: "done", args: { summary: "한 바퀴 돌고 관측 완료" } }),
    ]);

    const outcome = await runCopilotTask("이륙하고 한 바퀴 돌면서 봐", h.port);

    expect(h.ran.map((call) => call.tool)).toEqual(["fly", "rotate", "observe"]);
    expect(outcome.summary).toBe("한 바퀴 돌고 관측 완료");
  });

  test("feeds results back as tool messages, paired to their call", async () => {
    const h = harness([turnOf({ name: "observe" }), turnOf({ name: "done", args: { summary: "봤다" } })]);
    await runCopilotTask("뭐 보여?", h.port);

    // [system, user, assistant(tool_calls), tool(result)]
    const sent = messagesOf(h.bodies[1]);
    expect(sent).toHaveLength(4);
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "call_0", content: JSON.stringify(SCENE) });
  });

  test("puts the instruction in a system message", async () => {
    const h = harness([turnOf({ name: "done", args: { summary: "끝" } })]);
    await runCopilotTask("이륙", h.port);

    const sent = messagesOf(h.bodies[0]);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0])).toContain('"role":"system"');
    expect(JSON.stringify(sent[0])).toContain("observe");
    expect(sent[1]).toEqual({ role: "user", content: "이륙" });
  });

  test("carries earlier tasks as their outcome, and says the scene has moved on", async () => {
    const h = harness([turnOf({ name: "done", args: { summary: "끝" } })]);
    await runCopilotTask("그 마커 다시 찾아줘", h.port, {
      history: [{ instruction: "마커 0 따라가", summary: "마커 0을 잠그고 추적했습니다." }],
    });

    const sent = messagesOf(h.bodies[0]);
    const wire = JSON.stringify(sent);
    expect(wire).toContain("마커 0 따라가");
    expect(wire).toContain("마커 0을 잠그고 추적했습니다.");
    // A summary is a memory; a transcript would be an invitation to re-run it.
    expect(wire).not.toContain("tool_call");
    // And the model must be told the remembered scene is stale.
    expect(wire).toContain("observe로 다시 확인");
    // The live instruction is still the last thing it reads.
    expect(sent[sent.length - 1]).toEqual({ role: "user", content: "그 마커 다시 찾아줘" });
  });

  test("sends no history preamble when there is nothing to remember", async () => {
    const h = harness([turnOf({ name: "done", args: { summary: "끝" } })]);
    await runCopilotTask("이륙", h.port);
    expect(JSON.stringify(messagesOf(h.bodies[0]))).not.toContain("지난 작업의 기록");
  });

  test("hands a malformed call back to the model instead of aborting", async () => {
    const h = harness([
      // 900 cm is past the SDK's limit, so the decoder must refuse it outright.
      turnOf({ name: "fly", args: { action: "forward", cm: 900 } }),
      turnOf({ name: "fly", args: { action: "forward", cm: 200 } }),
      turnOf({ name: "done", args: { summary: "정정 후 전진" } }),
    ]);

    const outcome = await runCopilotTask("앞으로 가", h.port);

    expect(h.ran.map((call) => call.tool)).toEqual(["fly"]);
    const failed = h.steps.filter((step) => step.state === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail ?? "").toContain("500");
    const sent = messagesOf(h.bodies[1]);
    expect(JSON.stringify(sent[sent.length - 1])).toContain("error");
    expect(outcome.summary).toBe("정정 후 전진");
  });

  test("a tool that throws is reported and the task continues", async () => {
    const h = harness(
      [turnOf({ name: "fly", args: { action: "takeoff" } }), turnOf({ name: "done", args: { summary: "이륙 실패 확인" } })],
      { failOn: "fly" },
    );

    const outcome = await runCopilotTask("이륙", h.port);

    expect(h.steps.some((step) => step.state === "failed" && (step.detail ?? "").includes("refused"))).toBe(true);
    expect(outcome.summary).toBe("이륙 실패 확인");
  });

  test("cancelling stops mid-plan and leaves the rest of the calls unrun", async () => {
    const h = harness([
      turnOf({ name: "fly", args: { action: "takeoff" } }, { name: "fly", args: { action: "forward", cm: 200 } }),
    ]);
    const port: CopilotPort = {
      ...h.port,
      async run(call) {
        const result = await h.port.run(call);
        h.cancel(); // the operator hits cancel while the first tool is in flight
        return result;
      },
    };

    const outcome = await runCopilotTask("이륙하고 전진", port);

    expect(h.ran.map((call) => call.tool)).toEqual(["fly"]);
    expect(outcome.summary).toContain("중단");
    expect(h.steps.some((step) => step.state === "cancelled")).toBe(true);
  });

  test("stops at the turn cap and says so rather than claiming success", async () => {
    const forever = Array.from({ length: 5 }, () => turnOf({ name: "observe" }));
    const h = harness(forever);

    const outcome = await runCopilotTask("계속 봐", h.port, { maxTurns: 3 });

    expect(h.ran).toHaveLength(3);
    expect(outcome.summary).toContain("3턴");
    expect(outcome.summary).not.toContain("완료");
  });

  test("re-asks with a nudge when the backend answers prose instead of tool calls", async () => {
    // Measured behaviour of `cgpt-web/gpt-5.6-pro`: ~1 reply in 4 loses the
    // tools and apologises. Ending the task there would strand the drone.
    const h = harness([
      proseTurn("드론 제어 도구가 연결되어 있지 않아 실행할 수 없습니다."),
      turnOf({ name: "fly", args: { action: "takeoff" } }),
      turnOf({ name: "done", args: { summary: "이륙 완료" } }),
    ]);

    const outcome = await runCopilotTask("이륙", h.port);

    expect(h.ran.map((call) => call.tool)).toEqual(["fly"]);
    expect(outcome.summary).toBe("이륙 완료");
    // The retry must actually say something new, or the backend repeats itself.
    const retried = messagesOf(h.bodies[1]);
    expect(JSON.stringify(retried[retried.length - 1])).toContain("tool call");
  });

  test("announces the wait before it starts, and names a re-ask as a re-ask", async () => {
    // A turn costs 8-19 s against this backend. If the panel is told nothing
    // until the answer lands, the operator is looking at a dead screen for
    // longer than it takes to decide the app has crashed.
    const h = harness([
      proseTurn("드론 제어 도구가 연결되어 있지 않습니다."),
      turnOf({ name: "fly", args: { action: "takeoff" } }),
      turnOf({ name: "done", args: { summary: "끝" } }),
    ]);

    await runCopilotTask("이륙", h.port);

    // Something is reported BEFORE the first request goes out.
    expect(h.activity[0]).toEqual({ kind: "thinking", attempt: 1, of: 2 });
    // The second ask is distinguishable from the first, which is what lets the
    // panel say "다시 요청 중" instead of letting the clock run in silence.
    const asks = h.activity.filter((a) => a.kind === "thinking");
    expect(asks.some((a) => a.kind === "thinking" && a.attempt === 2)).toBe(true);
    // And the pause between asks is announced rather than just slept through.
    expect(h.activity.some((a) => a.kind === "waiting")).toBe(true);
    // Once calls arrive the pending row must be taken down.
    expect(h.activity.some((a) => a.kind === "running")).toBe(true);
  });

  test("blames the backend, not the app, once the re-asks are spent", async () => {
    const h = harness(Array.from({ length: 6 }, () => proseTurn("그건 못 합니다.")));
    const outcome = await runCopilotTask("커피 타와", h.port);
    // The model's stock excuse is "I have no drone tools", which is false -
    // the schema went out every time. Parroting it sends the operator hunting
    // a wiring fault that does not exist.
    expect(outcome.summary).toContain("도구 호출 없이");
    expect(outcome.summary).toContain("앱 설정 문제가 아니라");
    // The model's own line is still there, as evidence rather than as verdict.
    expect(outcome.summary).toContain("그건 못 합니다.");
    expect(h.ran).toEqual([]);
    // Bounded: it re-asks a fixed number of times, then reports. Not one
    // attempt, and not an unbounded loop against a rate-limited session.
    expect(h.bodies.length).toBeGreaterThan(1);
    expect(h.bodies.length).toBeLessThanOrEqual(5);
  });

  test("a throttle notice stops immediately instead of retrying into the block", async () => {
    // The upstream ChatGPT session reports throttling as ordinary reply text,
    // not an HTTP status. Re-asking is what earns the block, so the one thing
    // this must never do is spend its retries here.
    const h = harness([
      proseTurn("웹에서 요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다."),
      turnOf({ name: "fly", args: { action: "takeoff" } }),
    ]);

    const outcome = await runCopilotTask("이륙", h.port);

    expect(h.bodies).toHaveLength(1);
    expect(h.ran).toEqual([]);
    expect(outcome.summary).toContain("속도 제한");
    // The pilot must be told the aircraft is still up, because nothing landed it.
    expect(outcome.summary).toContain("떠 있");
  });
});

describe("decodeToolCall", () => {
  test("refuses out-of-range and unknown calls with a reason the model can act on", () => {
    const tooFar = decodeToolCall("fly", { action: "forward", cm: 900 });
    expect(isToolCall(tooFar)).toBe(false);

    const noDistance = decodeToolCall("fly", { action: "forward" });
    expect(isToolCall(noDistance)).toBe(false);

    const unknown = decodeToolCall("teleport", {});
    expect(isToolCall(unknown)).toBe(false);

    // A no-argument tool must still decode when Gemini omits `args` entirely.
    expect(isToolCall(decodeToolCall("observe", undefined))).toBe(true);
  });

  test("a no-argument tool ignores what a model attaches to it", () => {
    // Models in the chain like to hang a rationale off `observe`, and refusing
    // it burned the first turn of most tasks - a whole re-sent transcript to
    // learn what the empty schema already said. There is no argument to honour
    // here, so there is no wrong outcome to protect against.
    const observed = decodeToolCall("observe", { reason: "check the scene first" });
    expect(isToolCall(observed)).toBe(true);
    expect(isToolCall(observed) ? observed.tool : "").toBe("observe");

    const unlocked = decodeToolCall("unlock", { id: 3 });
    expect(isToolCall(unlocked)).toBe(true);

    // Tools that DO take arguments still refuse: an undeclared key there may be
    // the model asking for behaviour dropping it would silently deny.
    const misnamed = decodeToolCall("fly", { action: "forward", distance: 100 });
    expect(isToolCall(misnamed)).toBe(false);
    const why = isToolCall(misnamed) ? "" : misnamed.error;
    expect(why).toContain("distance");
    expect(why).toContain("cm");
  });

  test("an over-range value is refused with the way past it, not just the range", () => {
    // A bare range leaves the model to invent a workaround, and the one it
    // invents is to clamp - flying 5 m when 12 m was asked for, silently.
    const tooFar = decodeToolCall("fly", { action: "forward", cm: 1200 });
    expect(isToolCall(tooFar)).toBe(false);
    const far = isToolCall(tooFar) ? "" : tooFar.error;
    expect(far).toContain("500");
    expect(far).toContain("100 cm");
    expect(far).toContain("repeated calls");

    const tooLong = decodeToolCall("wait", { seconds: 60 });
    expect(isToolCall(tooLong)).toBe(false);
    const long = isToolCall(tooLong) ? "" : tooLong.error;
    expect(long).toContain("20");
    expect(long).toContain("repeat");

    // Under the floor is a different mistake - there is nothing to repeat -
    // so it gets the range and no misleading advice.
    const tooNear = decodeToolCall("fly", { action: "forward", cm: 5 });
    expect(isToolCall(tooNear)).toBe(false);
    expect(isToolCall(tooNear) ? "" : tooNear.error).not.toContain("repeated calls");
  });
});
