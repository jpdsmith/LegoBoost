// SPDX-License-Identifier: MIT
// First-class Xbox Controller (HTML5 Standard Gamepad API) input engine for ChromeOS & desktop.
// Supports both Arcade Left-Stick driving and Car Trigger (RT/LT + Left Stick X) driving,
// Right-Stick optional Port C turret pan, and edge-triggered A/B/X/Y/LB/RB/Menu actions.

export interface XboxDriveSample {
  connected: boolean;
  name: string | null;
  /** Normalized steering [-1 left .. +1 right] */
  steer: number;
  /** Normalized throttle [-1 reverse .. +1 forward] */
  throttle: number;
  /** Right stick horizontal [-1 .. +1] for optional Port C camera turret */
  turretX: number;
  /** True when driving via RT/LT triggers instead of Left Stick Y */
  usingTriggers: boolean;
  /** Raw visual telemetry for on-screen Xbox HUD */
  rt: number;
  lt: number;
  /** Edge-triggered single-press actions fired on this poll tick */
  actions: XboxAction[];
}

export type XboxAction =
  | "stop"            // B button
  | "horn"            // A button
  | "headlights"      // X button
  | "cycle-assist"    // Y button
  | "speed-down"      // LB button
  | "speed-up"        // RB button
  | "toggle-follow"   // Menu / Start button
  | "nudge-forward"   // D-pad Up
  | "nudge-reverse"   // D-pad Down
  | "nudge-left"      // D-pad Left
  | "nudge-right";    // D-pad Right

const STICK_DEADZONE = 0.14;
const TRIGGER_DEADZONE = 0.08;

/**
 * Apply deadzone + smooth cubic response curve so slow indoor driving is easy to feather
 * while full deflection still reaches 100%.
 */
export function shapeAxis(raw: number, deadzone = STICK_DEADZONE): number {
  const clamped = Math.max(-1, Math.min(1, raw));
  const abs = Math.abs(clamped);
  if (abs < deadzone) return 0;
  const norm = (abs - deadzone) / (1 - deadzone);
  const curved = 0.45 * norm + 0.55 * norm * norm;
  return Math.sign(clamped) * Math.min(1, curved);
}

/**
 * Mix shaped steering & throttle into differential tank speeds [-100..+100] scaled by speedCap.
 */
export function mixXboxToTank(
  steer: number,
  throttle: number,
  speedCap: number
): { left: number; right: number } {
  if (steer === 0 && throttle === 0) return { left: 0, right: 0 };
  const rawL = throttle + steer;
  const rawR = throttle - steer;
  const peak = Math.max(1, Math.abs(rawL), Math.abs(rawR));
  const cap = Math.max(15, Math.min(100, speedCap));
  return {
    left: Math.round((rawL / peak) * cap),
    right: Math.round((rawR / peak) * cap),
  };
}

export interface GamepadLike {
  id: string;
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

const BUTTON_ACTIONS: Array<{ index: number; action: XboxAction }> = [
  { index: 0, action: "horn" },          // A
  { index: 1, action: "stop" },          // B
  { index: 2, action: "headlights" },    // X
  { index: 3, action: "cycle-assist" },  // Y
  { index: 4, action: "speed-down" },    // LB
  { index: 5, action: "speed-up" },      // RB
  { index: 9, action: "toggle-follow" }, // Menu / Start
  { index: 12, action: "nudge-forward" },
  { index: 13, action: "nudge-reverse" },
  { index: 14, action: "nudge-left" },
  { index: 15, action: "nudge-right" },
];

export class XboxControllerReader {
  private prevPressed = new Set<number>();

  reset(): void {
    this.prevPressed.clear();
  }

  /**
   * Poll a GamepadLike (or navigator.getGamepads() when omitted) and emit shaped sticks +
   * edge-triggered button actions.
   */
  poll(explicitPad?: GamepadLike | null): XboxDriveSample {
    let pad: GamepadLike | null | undefined = explicitPad;
    if (pad === undefined && typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
      const pads = navigator.getGamepads();
      pad = pads ? Array.from(pads).find((p): p is Gamepad => Boolean(p && p.connected)) : null;
    }

    if (!pad || !pad.connected) {
      this.prevPressed.clear();
      return {
        connected: false,
        name: null,
        steer: 0,
        throttle: 0,
        turretX: 0,
        usingTriggers: false,
        rt: 0,
        lt: 0,
        actions: [],
      };
    }

    const ax0 = pad.axes[0] ?? 0;
    const ax1 = -(pad.axes[1] ?? 0); // Forward is -1 in Web Gamepad API
    const ax2 = pad.axes[2] ?? 0;

    const rtRaw = pad.buttons[7]?.value ?? 0;
    const ltRaw = pad.buttons[6]?.value ?? 0;
    const rt = rtRaw > TRIGGER_DEADZONE ? (rtRaw - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE) : 0;
    const lt = ltRaw > TRIGGER_DEADZONE ? (ltRaw - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE) : 0;

    const steer = shapeAxis(ax0);
    const stickThrottle = shapeAxis(ax1);
    const usingTriggers = rt > 0 || lt > 0;
    const throttle = usingTriggers
      ? Math.max(-1, Math.min(1, rt - lt))
      : stickThrottle;
    const turretX = shapeAxis(ax2, 0.18);

    // Edge-trigger buttons (fire once on rising press edge)
    const actions: XboxAction[] = [];
    for (const mapping of BUTTON_ACTIONS) {
      const isDown = Boolean(pad.buttons[mapping.index]?.pressed);
      const wasDown = this.prevPressed.has(mapping.index);
      if (isDown && !wasDown) {
        actions.push(mapping.action);
      }
      if (isDown) {
        this.prevPressed.add(mapping.index);
      } else {
        this.prevPressed.delete(mapping.index);
      }
    }

    const cleanName = pad.id
      .replace(/\(STANDARD GAMEPAD.*\)/i, "")
      .replace(/\(Vendor:.*\)/i, "")
      .trim()
      .slice(0, 32) || "Xbox Controller";

    return {
      connected: true,
      name: cleanName,
      steer,
      throttle,
      turretX,
      usingTriggers,
      rt,
      lt,
      actions,
    };
  }
}
