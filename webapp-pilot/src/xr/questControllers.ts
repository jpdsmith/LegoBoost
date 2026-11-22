// SPDX-License-Identifier: MIT
// Meta Quest 1 / 2 / 3 (Oculus Touch) WebXR Hand Controller Engine.
// Follows the W3C WebXR "xr-standard" gamepad mapping:
//   axes[2], axes[3] = Thumbstick X / Y  (fallback axes[0], axes[1] if axes.length < 4)
//   buttons[0] = Index Trigger (analog 0..1)
//   buttons[1] = Grip / Squeeze (analog 0..1)
//   buttons[3] = Thumbstick Click
//   buttons[4] = Primary Button (Left = X, Right = A)
//   buttons[5] = Secondary Button (Left = Y, Right = B)

import { mixXboxToTank, shapeAxis } from "../input/xboxController";

export type QuestDriveStyle = "arcade" | "twin-stick";

export type QuestButtonAction =
  | "stop"
  | "horn"
  | "headlights"
  | "cycle-assist"
  | "speed-down"
  | "speed-up"
  | "toggle-drive-style"
  | "recenter";

export interface XrGamepadButtonLike {
  pressed: boolean;
  value: number;
}

export interface XrHapticActuatorLike {
  pulse?: (value: number, duration: number) => Promise<boolean> | void;
}

export interface XrGamepadLike {
  axes: readonly number[];
  buttons: readonly XrGamepadButtonLike[];
  hapticActuators?: readonly XrHapticActuatorLike[];
}

export interface XrInputSourceLike {
  handedness: "left" | "right" | "none" | string;
  gamepad?: XrGamepadLike | null;
}

export interface QuestControlSample {
  leftConnected: boolean;
  rightConnected: boolean;
  driveStyle: QuestDriveStyle;
  /** Mixed arcade steer [-1..+1] and throttle [-1..+1] (for HUD & Co-Pilot) */
  steer: number;
  throttle: number;
  /** Direct motor speeds [-speedCap..+speedCap] */
  leftMotor: number;
  rightMotor: number;
  /** Optional Port C camera turret pan [-1..+1] from Right Thumbstick X (arcade mode) */
  turretX: number;
  usingTriggers: boolean;
  actions: QuestButtonAction[];
}

export function readXrThumbstick(gp: XrGamepadLike | null | undefined): { x: number; y: number } {
  if (!gp || !gp.axes) return { x: 0, y: 0 };
  // W3C xr-standard puts thumbstick on axes[2], axes[3] (axes[0..1] are touchpad placeholder)
  const rawX = gp.axes.length >= 4 ? gp.axes[2] ?? 0 : gp.axes[0] ?? 0;
  const rawY = gp.axes.length >= 4 ? gp.axes[3] ?? 0 : gp.axes[1] ?? 0;
  return {
    x: shapeAxis(rawX, 0.14),
    // WebXR / Gamepad API: pushing thumbstick UP gives -1 -> invert to +1 forward
    y: shapeAxis(-rawY, 0.14),
  };
}

function btnPressed(gp: XrGamepadLike | null | undefined, idx: number, threshold = 0.5): boolean {
  const b = gp?.buttons?.[idx];
  if (!b) return false;
  return Boolean(b.pressed || b.value >= threshold);
}

function btnAnalog(gp: XrGamepadLike | null | undefined, idx: number): number {
  const b = gp?.buttons?.[idx];
  if (!b) return 0;
  const v = typeof b.value === "number" ? b.value : b.pressed ? 1 : 0;
  return v < 0.08 ? 0 : Math.min(1, v);
}

/**
 * Mix Quest hand controllers into smooth tank drive outputs.
 * - "arcade": Left stick arcade OR Right Trigger gas / Left Trigger reverse + Left stick steer.
 * - "twin-stick": Left thumbstick Y controls Left tread, Right thumbstick Y controls Right tread.
 */
export function mixQuestToTank(params: {
  driveStyle: QuestDriveStyle;
  leftStickX: number;
  leftStickY: number;
  rightStickX: number;
  rightStickY: number;
  leftTrigger: number;
  rightTrigger: number;
  speedCap: number;
}): {
  leftMotor: number;
  rightMotor: number;
  steer: number;
  throttle: number;
  turretX: number;
  usingTriggers: boolean;
} {
  const cap = Math.max(0, Math.min(100, params.speedCap));

  if (params.driveStyle === "twin-stick") {
    const l = Math.round(Math.max(-1, Math.min(1, params.leftStickY)) * cap);
    const r = Math.round(Math.max(-1, Math.min(1, params.rightStickY)) * cap);
    const throttle = Math.max(-1, Math.min(1, (params.leftStickY + params.rightStickY) / 2));
    const steer = Math.max(-1, Math.min(1, (params.leftStickY - params.rightStickY) / 2));
    return {
      leftMotor: l,
      rightMotor: r,
      steer,
      throttle,
      turretX: 0,
      usingTriggers: false,
    };
  }

  // Arcade / Trigger Car Mode
  const triggerThrottle = params.rightTrigger - params.leftTrigger;
  const usingTriggers = params.rightTrigger > 0 || params.leftTrigger > 0;
  const throttle = usingTriggers ? triggerThrottle : params.leftStickY;
  const steer = params.leftStickX;
  const mixed = mixXboxToTank(steer, throttle, cap);

  return {
    leftMotor: mixed.left,
    rightMotor: mixed.right,
    steer,
    throttle,
    turretX: params.rightStickX,
    usingTriggers,
  };
}

export class QuestControllerReader {
  private prevEdge = new Map<string, boolean>();
  private driveStyle: QuestDriveStyle = "arcade";

  getDriveStyle(): QuestDriveStyle {
    return this.driveStyle;
  }

  setDriveStyle(style: QuestDriveStyle): void {
    this.driveStyle = style;
  }

  reset(): void {
    this.prevEdge.clear();
  }

  private edge(key: string, pressed: boolean): boolean {
    const prev = this.prevEdge.get(key) ?? false;
    this.prevEdge.set(key, pressed);
    return pressed && !prev;
  }

  /**
   * Poll WebXR session.inputSources for Left & Right Meta Quest Touch controllers.
   */
  poll(inputSources: Iterable<XrInputSourceLike>, speedCap: number): QuestControlSample {
    let leftGp: XrGamepadLike | null = null;
    let rightGp: XrGamepadLike | null = null;

    for (const src of inputSources) {
      if (!src || !src.gamepad) continue;
      if (src.handedness === "left") leftGp = src.gamepad;
      else if (src.handedness === "right") rightGp = src.gamepad;
    }

    const leftStick = readXrThumbstick(leftGp);
    const rightStick = readXrThumbstick(rightGp);
    const leftTrigger = btnAnalog(leftGp, 0);
    const rightTrigger = btnAnalog(rightGp, 0);

    const actions: QuestButtonAction[] = [];

    // Right controller: B (5) = Emergency STOP, A (4) = Horn, Grip (1) = Speed+, Stick Click (3) = Recenter
    if (this.edge("r_b", btnPressed(rightGp, 5))) actions.push("stop");
    if (this.edge("r_a", btnPressed(rightGp, 4))) actions.push("horn");
    if (this.edge("r_grip", btnPressed(rightGp, 1, 0.72))) actions.push("speed-up");
    if (this.edge("r_stick", btnPressed(rightGp, 3))) actions.push("recenter");

    // Left controller: X (4) = Headlights, Y (5) = Cycle Pilot Mode, Grip (1) = Speed-, Stick Click (3) = Arcade/Tank toggle
    if (this.edge("l_x", btnPressed(leftGp, 4))) actions.push("headlights");
    if (this.edge("l_y", btnPressed(leftGp, 5))) actions.push("cycle-assist");
    if (this.edge("l_grip", btnPressed(leftGp, 1, 0.72))) actions.push("speed-down");
    if (this.edge("l_stick", btnPressed(leftGp, 3))) {
      this.driveStyle = this.driveStyle === "arcade" ? "twin-stick" : "arcade";
      actions.push("toggle-drive-style");
    }

    const mixed = mixQuestToTank({
      driveStyle: this.driveStyle,
      leftStickX: leftStick.x,
      leftStickY: leftStick.y,
      rightStickX: rightStick.x,
      rightStickY: rightStick.y,
      leftTrigger,
      rightTrigger,
      speedCap,
    });

    return {
      leftConnected: Boolean(leftGp),
      rightConnected: Boolean(rightGp),
      driveStyle: this.driveStyle,
      steer: mixed.steer,
      throttle: mixed.throttle,
      leftMotor: mixed.leftMotor,
      rightMotor: mixed.rightMotor,
      turretX: mixed.turretX,
      usingTriggers: mixed.usingTriggers,
      actions,
    };
  }

  /**
   * Fire subtle tactile vibration on Oculus Touch controllers (e.g., on STOP or obstacle alert).
   */
  pulseHaptics(
    inputSources: Iterable<XrInputSourceLike>,
    hand: "left" | "right" | "both",
    intensity = 0.45,
    durationMs = 55
  ): void {
    for (const src of inputSources) {
      if (!src?.gamepad?.hapticActuators?.length) continue;
      if (hand !== "both" && src.handedness !== hand) continue;
      try {
        void src.gamepad.hapticActuators[0]?.pulse?.(intensity, durationMs);
      } catch {
        // ignore unsupported haptics
      }
    }
  }
}
