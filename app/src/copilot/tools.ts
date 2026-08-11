/**
 * The copilot's entire vocabulary: what the model is allowed to ask for, how
 * that is described to Gemini, and how one of its answers is turned back into
 * something this app will act on.
 *
 * The decoder is deliberately unforgiving. A clamp or a default would let a
 * wrong number reach a real airframe silently; an error goes back to the model
 * as that call's result, which is the one correction channel that actually
 * works - the next turn sees exactly what it got wrong.
 */
import type { ControlMode } from "../control-mode.ts";

export const FLY_ACTIONS = [
  "takeoff",
  "land",
  "hover",
  "emergency",
  "up",
  "down",
  "left",
  "right",
  "forward",
  "back",
] as const;
export type FlyAction = (typeof FLY_ACTIONS)[number];

/** The `fly` actions that travel, and therefore cannot be flown without `cm`. */
const FLY_MOVES: ReadonlySet<FlyAction> = new Set<FlyAction>([
  "up",
  "down",
  "left",
  "right",
  "forward",
  "back",
]);

export const ROTATE_DIRECTIONS = ["cw", "ccw"] as const;
export type RotateDirection = (typeof ROTATE_DIRECTIONS)[number];

export const FLIP_DIRECTIONS = ["l", "r", "f", "b"] as const;
export type FlipDirection = (typeof FLIP_DIRECTIONS)[number];

/** Same three surfaces as `control-mode.ts`; named here so the schema owns them. */
export const COPILOT_MODES: readonly ControlMode[] = ["key", "person", "aruco"];

/** Ranges are the Tello SDK's own limits, except `maxRc`, which is `follow.ts`'s. */
export const LIMITS = {
  cm: { min: 20, max: 500 },
  degrees: { min: 1, max: 360 },
  speedCms: { min: 10, max: 100 },
  maxRc: { min: 12, max: 60 },
  waitSeconds: { min: 0.1, max: 20 },
} as const;

export type ToolCall =
  | { readonly tool: "fly"; readonly action: FlyAction; readonly cm: number | null }
  | { readonly tool: "rotate"; readonly direction: RotateDirection; readonly degrees: number }
  | { readonly tool: "flip"; readonly direction: FlipDirection }
  | { readonly tool: "speed"; readonly cms: number }
  | { readonly tool: "set_mode"; readonly mode: ControlMode }
  | { readonly tool: "lock"; readonly id: number }
  | { readonly tool: "unlock" }
  | { readonly tool: "observe" }
  | { readonly tool: "wait"; readonly seconds: number }
  | { readonly tool: "done"; readonly summary: string };

export type ToolName = ToolCall["tool"];

/** Not a `ToolCall`: the reason one could not be built, phrased for the model. */
export type ToolCallError = { readonly error: string };

export function isToolCall(decoded: ToolCall | ToolCallError): decoded is ToolCall {
  return "tool" in decoded;
}

// ---------------------------------------------------------------------------
// Tool declarations, in the JSON Schema subset OpenAI-compatible endpoints
// accept: lower-case type names, and an object schema even for the tools that
// take nothing.
// ---------------------------------------------------------------------------

type SchemaType = "string" | "number" | "integer";

type ParameterSchema = Readonly<{
  type: SchemaType;
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
}>;

export type FunctionDeclaration = Readonly<{
  name: ToolName;
  description: string;
  /** Absent for the tools that take no arguments. */
  parameters?: Readonly<{
    type: "object";
    properties: Readonly<Record<string, ParameterSchema>>;
    required: readonly string[];
  }>;
}>;

export const TOOL_DECLARATIONS: readonly FunctionDeclaration[] = [
  {
    name: "fly",
    description:
      "Issue one Tello flight action. 'takeoff' and 'land' are the only way to get airborne and back down. " +
      "'hover' stops all motion and holds position. 'emergency' cuts the motors instantly and the drone drops - " +
      "only to stop a crash in progress. The six directional actions up/down/left/right/forward/back each travel " +
      "'cm' centimetres relative to the drone's current heading and block until the movement has finished.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Which action to fly.",
          enum: FLY_ACTIONS,
        },
        cm: {
          type: "integer",
          description:
            "Distance to travel in centimetres. Required for up/down/left/right/forward/back, and must be omitted for takeoff/land/hover/emergency.",
          minimum: LIMITS.cm.min,
          maximum: LIMITS.cm.max,
        },
      },
      required: ["action"],
    },
  },
  {
    name: "rotate",
    description:
      "Yaw in place, without moving. 'cw' is clockwise seen from above, 'ccw' counter-clockwise. The drone cannot " +
      "report what it passes while turning, so to search a room turn a slice, observe, and repeat instead of " +
      "spinning 360 degrees in one call.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", description: "Turn direction.", enum: ROTATE_DIRECTIONS },
        degrees: {
          type: "integer",
          description: "How far to turn, in degrees.",
          minimum: LIMITS.degrees.min,
          maximum: LIMITS.degrees.max,
        },
      },
      required: ["direction", "degrees"],
    },
  },
  {
    name: "flip",
    description:
      "Perform an acrobatic flip: 'l' left, 'r' right, 'f' forward, 'b' back. The drone refuses this below roughly " +
      "50% battery and needs about 1.5 m of clear space in that direction.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", description: "Flip direction.", enum: FLIP_DIRECTIONS },
      },
      required: ["direction"],
    },
  },
  {
    name: "speed",
    description:
      "Set the cruise speed, in cm/s, used by fly's directional moves and by rotate. It does not affect autonomous follow.",
    parameters: {
      type: "object",
      properties: {
        cms: {
          type: "integer",
          description: "Cruise speed in centimetres per second.",
          minimum: LIMITS.speedCms.min,
          maximum: LIMITS.speedCms.max,
        },
      },
      required: ["cms"],
    },
  },
  {
    name: "set_mode",
    description:
      "Choose which detector runs on the video: 'key' none (manual flight only), 'person' person detection, " +
      "'aruco' ArUco marker detection. observe can only report targets the currently selected detector produces, " +
      "so switch mode first and observe afterwards.",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Detector to run.", enum: COPILOT_MODES },
      },
      required: ["mode"],
    },
  },
  {
    name: "lock",
    description:
      "Lock onto one target by id and START AUTONOMOUS FOLLOWING: from this call on the drone steers itself, " +
      "yawing and moving to keep that target centred and at its current apparent size, and it keeps doing so until " +
      "unlock. The id must come from a fresh observe - a marker id in aruco mode, a track id in person mode.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Target id reported by the most recent observe.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "unlock",
    description: "Release the lock and stop autonomous following. The drone stays airborne and hovers.",
  },
  {
    name: "observe",
    description:
      "Look at the world. This is the ONLY way to learn what is actually in frame: battery, height, flight time, " +
      "the active detector mode, every target the detector can see right now with its id, the current lock and the " +
      "follow phase. Never assume a target exists and never reuse an id from an earlier observe - observe again.",
  },
  {
    name: "wait",
    description:
      "Do nothing for a while. Use it to let a manoeuvre settle, or to give autonomous following time to work " +
      "before observing the result.",
    parameters: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description: "How long to wait, in seconds.",
          minimum: LIMITS.waitSeconds.min,
          maximum: LIMITS.waitSeconds.max,
        },
      },
      required: ["seconds"],
    },
  },
  {
    name: "done",
    description:
      "End the task. Call this as soon as the goal has been achieved, or as soon as you have established from " +
      "observe that it cannot be, with a short summary in KOREAN of what you actually did and saw.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One or two sentences, in Korean, on what was done and what was observed.",
        },
      },
      required: ["summary"],
    },
  },
];

const TOOL_NAMES: readonly string[] = TOOL_DECLARATIONS.map((declaration) => declaration.name);

/**
 * The `tools` array the endpoint wants. A tool with no arguments still needs a
 * schema - an omitted `parameters` makes some backends drop the tool silently,
 * which shows up as a model insisting it has no drone controls - so the empty
 * case is sent as an object with no properties rather than left out.
 */
export const TOOL_SCHEMA: readonly unknown[] = TOOL_DECLARATIONS.map((declaration) => ({
  type: "function",
  function: {
    name: declaration.name,
    description: declaration.description,
    parameters: declaration.parameters ?? { type: "object", properties: {}, required: [] },
  },
}));

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** How a rejected value is named back to the model: enough to fix it, no dumps. */
function show(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

function isError<T>(value: T | ToolCallError): value is ToolCallError {
  return typeof value === "object" && value !== null && "error" in value;
}

function enumArg<T extends string>(
  tool: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | ToolCallError {
  if (typeof value !== "string") {
    return { error: `${tool}: "${field}" is required and must be one of ${allowed.join(", ")}; got ${show(value)}` };
  }
  if (!allowed.includes(value as T)) {
    return { error: `${tool}: "${field}" must be one of ${allowed.join(", ")}; got ${show(value)}` };
  }
  return value as T;
}

/**
 * What to do about a value the SDK will not take.
 *
 * A refusal that only states the range leaves the model to invent a workaround,
 * and the ones it invents are wrong: it clamps 1000 cm to 500 and flies half
 * the distance silently, or gives up on a 60 s wait entirely. Naming the
 * remedy is the difference between a corrected second attempt and a stalled
 * plan, and it costs one sentence.
 */
const OVER_RANGE_REMEDY: Readonly<Record<string, string>> = {
  cm: "1 m = 100 cm. A single move is capped at 500 cm, so cover a longer distance with repeated calls rather than one big one.",
  degrees: "A single rotate is capped at 360 degrees; repeat the call to turn further.",
  seconds: "A single wait is capped at 20 s; repeat the call for a longer pause.",
  cms: "Cruise speed only, in cm/s. It does not move the drone by itself.",
};

function outOfRange(tool: string, field: string, value: number, range: { min: number; max: number }): ToolCallError {
  const remedy = OVER_RANGE_REMEDY[field];
  const advice = remedy === undefined || value <= range.max ? "" : ` ${remedy}`;
  return { error: `${tool}: "${field}" must be between ${range.min} and ${range.max}; got ${value}.${advice}` };
}

function integerArg(
  tool: string,
  field: string,
  value: unknown,
  range: { min: number; max: number } | null,
): number | ToolCallError {
  const bounds = range === null ? "" : ` between ${range.min} and ${range.max}`;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: `${tool}: "${field}" is required and must be a whole number${bounds}; got ${show(value)}` };
  }
  if (!Number.isSafeInteger(value)) {
    return { error: `${tool}: "${field}" must be a whole number${bounds}; got ${value}` };
  }
  if (range !== null && (value < range.min || value > range.max)) {
    return outOfRange(tool, field, value, range);
  }
  return value;
}

function numberArg(
  tool: string,
  field: string,
  value: unknown,
  range: { min: number; max: number },
): number | ToolCallError {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      error: `${tool}: "${field}" is required and must be a number between ${range.min} and ${range.max}; got ${show(value)}`,
    };
  }
  if (value < range.min || value > range.max) {
    return outOfRange(tool, field, value, range);
  }
  return value;
}

function stringArg(tool: string, field: string, value: unknown): string | ToolCallError {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `${tool}: "${field}" is required and must be a non-empty string; got ${show(value)}` };
  }
  return value;
}

/** A key the schema does not declare is a misremembered call, not a spelling to
 *  guess at - naming it is usually the fastest way for the model to self-correct. */
function onlyKeys(tool: string, args: Record<string, unknown>, known: readonly string[]): ToolCallError | null {
  const extra = Object.keys(args).filter((key) => !known.includes(key) && args[key] !== undefined);
  if (extra.length === 0) return null;
  const accepted = known.length === 0 ? "no arguments" : known.join(", ");
  return { error: `${tool}: unknown argument${extra.length > 1 ? "s" : ""} ${extra.join(", ")}; it accepts ${accepted}` };
}

function argRecord(args: unknown): Record<string, unknown> | null {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

/**
 * Turns one Gemini `functionCall` into a `ToolCall`, or into the reason it is
 * not one. Never clamps, never fills in a default, never guesses a tool name.
 */
export function decodeToolCall(name: unknown, args: unknown): ToolCall | ToolCallError {
  if (typeof name !== "string" || name === "") {
    return { error: `tool name must be a string; got ${show(name)}. Available tools: ${TOOL_NAMES.join(", ")}` };
  }
  const fields = argRecord(args);
  if (fields === null) {
    return { error: `${name}: arguments must be an object; got ${show(args)}` };
  }

  switch (name) {
    case "fly": {
      const action = enumArg("fly", "action", fields["action"], FLY_ACTIONS);
      if (isError(action)) return action;
      const travels = FLY_MOVES.has(action);
      const raw = fields["cm"];
      if (travels && raw === undefined) {
        return {
          error: `fly: "${action}" needs "cm", the distance to travel in centimetres (${LIMITS.cm.min}-${LIMITS.cm.max})`,
        };
      }
      if (!travels && raw !== undefined) {
        return { error: `fly: "${action}" takes no "cm"; it does not travel a distance` };
      }
      let cm: number | null = null;
      if (travels) {
        const decoded = integerArg("fly", "cm", raw, LIMITS.cm);
        if (isError(decoded)) return decoded;
        cm = decoded;
      }
      const extra = onlyKeys("fly", fields, ["action", "cm"]);
      if (extra !== null) return extra;
      return { tool: "fly", action, cm };
    }
    case "rotate": {
      const direction = enumArg("rotate", "direction", fields["direction"], ROTATE_DIRECTIONS);
      if (isError(direction)) return direction;
      const degrees = integerArg("rotate", "degrees", fields["degrees"], LIMITS.degrees);
      if (isError(degrees)) return degrees;
      const extra = onlyKeys("rotate", fields, ["direction", "degrees"]);
      if (extra !== null) return extra;
      return { tool: "rotate", direction, degrees };
    }
    case "flip": {
      const direction = enumArg("flip", "direction", fields["direction"], FLIP_DIRECTIONS);
      if (isError(direction)) return direction;
      const extra = onlyKeys("flip", fields, ["direction"]);
      if (extra !== null) return extra;
      return { tool: "flip", direction };
    }
    case "speed": {
      const cms = integerArg("speed", "cms", fields["cms"], LIMITS.speedCms);
      if (isError(cms)) return cms;
      const extra = onlyKeys("speed", fields, ["cms"]);
      if (extra !== null) return extra;
      return { tool: "speed", cms };
    }
    case "set_mode": {
      const mode = enumArg("set_mode", "mode", fields["mode"], COPILOT_MODES);
      if (isError(mode)) return mode;
      const extra = onlyKeys("set_mode", fields, ["mode"]);
      if (extra !== null) return extra;
      return { tool: "set_mode", mode };
    }
    case "lock": {
      const id = integerArg("lock", "id", fields["id"], null);
      if (isError(id)) return id;
      const extra = onlyKeys("lock", fields, ["id"]);
      if (extra !== null) return extra;
      return { tool: "lock", id };
    }
    case "unlock": {
      const extra = onlyKeys("unlock", fields, []);
      if (extra !== null) return extra;
      return { tool: "unlock" };
    }
    case "observe": {
      const extra = onlyKeys("observe", fields, []);
      if (extra !== null) return extra;
      return { tool: "observe" };
    }
    case "wait": {
      const seconds = numberArg("wait", "seconds", fields["seconds"], LIMITS.waitSeconds);
      if (isError(seconds)) return seconds;
      const extra = onlyKeys("wait", fields, ["seconds"]);
      if (extra !== null) return extra;
      return { tool: "wait", seconds };
    }
    case "done": {
      const summary = stringArg("done", "summary", fields["summary"]);
      if (isError(summary)) return summary;
      const extra = onlyKeys("done", fields, ["summary"]);
      if (extra !== null) return extra;
      return { tool: "done", summary };
    }
    default:
      return { error: `unknown tool "${name}". Available tools: ${TOOL_NAMES.join(", ")}` };
  }
}
