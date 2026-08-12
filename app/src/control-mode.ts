/**
 * The three control surfaces the supplied station design exposes.
 *
 * `key` is the only SDK/RC control path. `person` and `aruco` select native
 * detectors that publish observations to the UI; neither mode can issue
 * automatic RC or SDK commands.
 */
export const CONTROL_MODES = [
  {
    id: "key",
    label: "키보드 수동 조종",
    key: "F1",
    color: "accent",
    stageTag: "MANUAL / KEYBOARD",
    capability: "ready",
  },
  {
    id: "person",
    label: "사람 추적",
    key: "F2",
    color: "ok",
    stageTag: "PERSON / NATIVE DETECTOR",
    capability: "native-detector",
  },
  {
    id: "aruco",
    label: "마커 추적",
    key: "F3",
    color: "warn",
    stageTag: "ARUCO / NATIVE DETECTOR",
    capability: "native-detector",
  },
] as const;

export type ControlMode = (typeof CONTROL_MODES)[number]["id"];
export type ControlModeSpec = (typeof CONTROL_MODES)[number];

export function controlMode(id: ControlMode): ControlModeSpec {
  return CONTROL_MODES.find((candidate) => candidate.id === id)!;
}
