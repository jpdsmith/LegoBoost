// SPDX-License-Identifier: MIT
// Pure natural-language Voice Command Parser & Spoken Reply Planner for Vernie OS Phase 5.
// Safety invariant: voice commands NEVER arm or fire the dart launcher.

import { HEAD_HOME_SENTINEL } from "../ble/protocol";

export type VoiceAction =
  | { type: "drive"; left: number; right: number; timeoutMs: number }
  | { type: "head"; angleDeg: number; speed: number }
  | { type: "synth"; voice: number; presetOrNote: number; durMs: number }
  | { type: "hubLed"; r: number; g: number; b: number }
  | { type: "setMode"; modeId: number }
  | { type: "playMacro" }
  | { type: "stopMacro" };

export interface VoiceContext {
  headHomed: boolean;
  pickedUp: boolean;
  safeMode: boolean;
  speedCap: number;
}

export interface VoiceParseResult {
  matched: boolean;
  blockedBySafety: boolean;
  intent: string;
  reply: string | null;
  actions: VoiceAction[];
}

function clampSpeed(speedCap: number): number {
  return Math.max(25, Math.min(80, Math.round(speedCap)));
}

/**
 * Parse a Web Speech API transcript or manual text command into safe Vernie OS actions.
 */
export function parseVoiceCommand(rawTranscript: string, ctx: VoiceContext): VoiceParseResult {
  const text = rawTranscript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return { matched: false, blockedBySafety: false, intent: "empty", reply: null, actions: [] };
  }

  // 1. Emergency STOP always works — even in Safe Mode or while picked up!
  if (/\b(stop|halt|freeze|brake|quiet|silence)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "emergency-stop",
      reply: "Stopping right away.",
      actions: [
        { type: "drive", left: 0, right: 0, timeoutMs: 200 },
        { type: "stopMacro" },
        { type: "synth", voice: 0, presetOrNote: 0, durMs: 0 },
      ],
    };
  }

  // 2. Dart launcher is ALWAYS refused over voice (strict manual 2-step interlock only).
  if (/\b(fire|shoot|launch|dart|missile)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: true,
      intent: "dart-refused",
      reply: "Dart firing is disabled for voice control. Use the manual two-step Arm and Fire interlock.",
      actions: [],
    };
  }

  // 3. Watchdog Safe Mode locks out all non-stop actions.
  if (ctx.safeMode) {
    return {
      matched: true,
      blockedBySafety: true,
      intent: "safe-mode-lockout",
      reply: "Watchdog Safe Mode is active. Only stop commands are allowed until reboot.",
      actions: [],
    };
  }

  const spd = clampSpeed(ctx.speedCap);

  // 4. Head calibration & eyebrow poses (C2: never command angles before HEAD_HOMED).
  if (/\b(home|calibrate)\b.*\bhead\b|\bhead\b.*\b(home|calibrate)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "home-head",
      reply: "Homing my head safely away from the dart trigger.",
      actions: [{ type: "head", angleDeg: HEAD_HOME_SENTINEL, speed: 30 }],
    };
  }

  if (/\blook left\b/.test(text)) {
    if (!ctx.headHomed) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "head-unhomed",
        reply: "Please home my head first before asking me to look around.",
        actions: [],
      };
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "look-left",
      reply: "Looking left.",
      actions: [{ type: "head", angleDeg: -30, speed: 55 }],
    };
  }

  if (/\blook right\b/.test(text)) {
    if (!ctx.headHomed) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "head-unhomed",
        reply: "Please home my head first before asking me to look around.",
        actions: [],
      };
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "look-right",
      reply: "Looking right.",
      actions: [{ type: "head", angleDeg: 30, speed: 55 }],
    };
  }

  if (/\blook (center|centre|straight|ahead)\b/.test(text)) {
    if (!ctx.headHomed) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "head-unhomed",
        reply: "Please home my head first before centering it.",
        actions: [],
      };
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "look-center",
      reply: "Looking straight ahead.",
      actions: [{ type: "head", angleDeg: 0, speed: 55 }],
    };
  }

  // 5. Autonomous Mode switching
  if (/\b(pet mode|living pet|be a pet)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "mode-pet",
      reply: "Switching to Living Pet mode.",
      actions: [{ type: "setMode", modeId: 0 }],
    };
  }
  if (/\b(explore|explorer|roam)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "mode-explorer",
      reply: "Switching to Room Explorer mode.",
      actions: [{ type: "setMode", modeId: 1 }],
    };
  }
  if (/\b(sentry|guard|watch)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "mode-sentry",
      reply: "Switching to Desk Sentry mode. Dart remains disarmed.",
      actions: [{ type: "setMode", modeId: 2 }],
    };
  }
  if (/\b(color|colour|card)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "mode-color",
      reply: "Switching to Color Card Commander mode.",
      actions: [{ type: "setMode", modeId: 3 }],
    };
  }
  if (/\b(remote|manual|cockpit)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "mode-remote",
      reply: "Switching to Remote Cockpit mode.",
      actions: [{ type: "setMode", modeId: 4 }],
    };
  }

  // 6. Drive pulses (blocked when picked up)
  if (/\b(forward|ahead|advance|go)\b/.test(text)) {
    if (ctx.pickedUp) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "pickup-lockout",
        reply: "Put me back on the floor before driving.",
        actions: [],
      };
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "drive-forward",
      reply: "Moving forward.",
      actions: [
        { type: "hubLed", r: 0, g: 168, b: 232 },
        { type: "drive", left: spd, right: spd, timeoutMs: 550 },
      ],
    };
  }

  if (/\b(back|backward|reverse)\b/.test(text)) {
    if (ctx.pickedUp) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "pickup-lockout",
        reply: "Put me back on the floor before driving.",
        actions: [],
      };
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "drive-reverse",
      reply: "Backing up.",
      actions: [
        { type: "hubLed", r: 255, g: 122, b: 0 },
        { type: "drive", left: -spd, right: -spd, timeoutMs: 550 },
      ],
    };
  }

  if (/\b(turn left|spin left|left)\b/.test(text)) {
    if (ctx.pickedUp) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "pickup-lockout",
        reply: "Put me back on the floor before turning.",
        actions: [],
      };
    }
    const turn = Math.round(spd * 0.85);
    return {
      matched: true,
      blockedBySafety: false,
      intent: "turn-left",
      reply: "Turning left.",
      actions: [{ type: "drive", left: -turn, right: turn, timeoutMs: 450 }],
    };
  }

  if (/\b(turn right|spin right|right)\b/.test(text)) {
    if (ctx.pickedUp) {
      return {
        matched: true,
        blockedBySafety: true,
        intent: "pickup-lockout",
        reply: "Put me back on the floor before turning.",
        actions: [],
      };
    }
    const turn = Math.round(spd * 0.85);
    return {
      matched: true,
      blockedBySafety: false,
      intent: "turn-right",
      reply: "Turning right.",
      actions: [{ type: "drive", left: turn, right: -turn, timeoutMs: 450 }],
    };
  }

  // 7. Expressive reactions, audio & macros
  if (/\b(hello|hi|hey vernie|greet|happy|chirp)\b/.test(text)) {
    const actions: VoiceAction[] = [
      { type: "hubLed", r: 16, g: 220, b: 96 },
      { type: "synth", voice: 0, presetOrNote: 2, durMs: 0 },
    ];
    if (ctx.headHomed) {
      actions.push({ type: "head", angleDeg: 20, speed: 60 });
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "greet",
      reply: "Hello! Vernie is online and ready to roll.",
      actions,
    };
  }

  if (/\b(dance|party|celebrate|victory|sing)\b/.test(text)) {
    const actions: VoiceAction[] = [
      { type: "hubLed", r: 16, g: 220, b: 96 },
      { type: "synth", voice: 0, presetOrNote: 7, durMs: 0 },
    ];
    if (!ctx.pickedUp) {
      actions.push({ type: "drive", left: 45, right: -45, timeoutMs: 400 });
    }
    return {
      matched: true,
      blockedBySafety: false,
      intent: "dance",
      reply: "Time to celebrate!",
      actions,
    };
  }

  if (/\b(laser|zap)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "sfx-laser",
      reply: "Laser sound effect!",
      actions: [
        { type: "hubLed", r: 255, g: 122, b: 0 },
        { type: "synth", voice: 0, presetOrNote: 6, durMs: 0 },
      ],
    };
  }

  if (/\b(alarm|siren|alert)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "sfx-siren",
      reply: "Sounding warning siren.",
      actions: [
        { type: "hubLed", r: 255, g: 24, b: 24 },
        { type: "synth", voice: 0, presetOrNote: 5, durMs: 0 },
      ],
    };
  }

  if (/\b(macro|routine|saved)\b/.test(text)) {
    return {
      matched: true,
      blockedBySafety: false,
      intent: "play-macro",
      reply: "Running your saved flash macro.",
      actions: [{ type: "playMacro" }],
    };
  }

  return {
    matched: false,
    blockedBySafety: false,
    intent: "unrecognized",
    reply: null,
    actions: [],
  };
}
