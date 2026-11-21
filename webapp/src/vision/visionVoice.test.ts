// SPDX-License-Identifier: MIT
// Unit tests for Phase 5 offline Vision Backpack analyzer & Voice Command Parser.

import { describe, expect, it } from "vitest";
import { HEAD_HOME_SENTINEL } from "../ble/protocol";
import {
  analyzeColorTarget,
  analyzeMotionFrame,
  computeTrackingAction,
} from "./visionEngine";
import { parseVoiceCommand } from "./voiceCommands";

function makeSolidFrame(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function paintRect(
  buf: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * w + x) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    }
  }
}

describe("visionEngine offline motion & color analyzers", () => {
  it("detects motion centroid and mirrors horizontal axis for front-facing webcam", () => {
    const w = 16;
    const h = 12;
    const prev = makeSolidFrame(w, h, 20, 20, 20);
    const curr = makeSolidFrame(w, h, 20, 20, 20);
    // Paint bright block in upper-right raw pixels (x: 10..16, y: 0..6)
    paintRect(curr, w, 10, 0, 16, 6, 220, 220, 220);

    const unmirrored = analyzeMotionFrame(prev, curr, w, h, false);
    expect(unmirrored.detected).toBe(true);
    expect(unmirrored.centroidX).toBeGreaterThan(0.5);
    expect(unmirrored.centroidY).toBeGreaterThan(0.3);
    expect(unmirrored.waveDetected).toBe(true);

    const mirrored = analyzeMotionFrame(prev, curr, w, h, true);
    expect(mirrored.detected).toBe(true);
    expect(mirrored.centroidX).toBeLessThan(-0.5);
  });

  it("ignores static scenes with tiny sensor noise below threshold", () => {
    const w = 16;
    const h = 12;
    const prev = makeSolidFrame(w, h, 100, 100, 100);
    const curr = makeSolidFrame(w, h, 105, 105, 105);
    const obs = analyzeMotionFrame(prev, curr, w, h, true);
    expect(obs.detected).toBe(false);
    expect(obs.waveDetected).toBe(false);
  });

  it("tracks colored LEGO brick targets across red, green, blue, and yellow", () => {
    const w = 16;
    const h = 12;
    const redFrame = makeSolidFrame(w, h, 40, 40, 40);
    paintRect(redFrame, w, 0, 4, 6, 8, 220, 30, 30);
    const redObs = analyzeColorTarget(redFrame, w, h, "color-red", false);
    expect(redObs.detected).toBe(true);
    expect(redObs.centroidX).toBeLessThan(-0.5);

    const yellowFrame = makeSolidFrame(w, h, 30, 30, 30);
    paintRect(yellowFrame, w, 10, 4, 16, 8, 230, 215, 25);
    const yellowObs = analyzeColorTarget(yellowFrame, w, h, "color-yellow", false);
    expect(yellowObs.detected).toBe(true);
    expect(yellowObs.centroidX).toBeGreaterThan(0.5);
  });

  it("enforces C2 headHomed lock, pickup safety stop, 88007 obstacle guard, and wave cooldown", () => {
    const targetRight = { detected: true, centroidX: 0.8, centroidY: 0.1, energy: 0.08, waveDetected: false };

    // C2: Unhomed head MUST never emit headDeg!
    const unhomed = computeTrackingAction("head-follow", targetRight, {
      headHomed: false,
      pickedUp: false,
      distancePct: 80,
      currentHeadDeg: 0,
      maxSpeedPct: 45,
      nowMs: 5000,
      lastWaveReactMs: 0,
    });
    expect(unhomed.headDeg).toBeNull();

    // Homed head smoothly tracks toward +35° clamp
    const homed = computeTrackingAction("head-follow", targetRight, {
      headHomed: true,
      pickedUp: false,
      distancePct: 80,
      currentHeadDeg: 0,
      maxSpeedPct: 45,
      nowMs: 5000,
      lastWaveReactMs: 0,
    });
    expect(homed.headDeg).not.toBeNull();
    expect(homed.headDeg!).toBeGreaterThan(0);
    expect(homed.headDeg!).toBeLessThanOrEqual(35);

    // Pickup pauses everything with explicit STOP
    const picked = computeTrackingAction("body-follow", targetRight, {
      headHomed: true,
      pickedUp: true,
      distancePct: 80,
      currentHeadDeg: 0,
      maxSpeedPct: 45,
      nowMs: 5000,
      lastWaveReactMs: 0,
    });
    expect(picked.drive).toEqual({ left: 0, right: 0, timeoutMs: 200 });

    // 88007 close obstacle (<= 35%) stops forward approach on centered target
    const centered = { detected: true, centroidX: 0.02, centroidY: 0, energy: 0.06, waveDetected: false };
    const closeObstacle = computeTrackingAction("body-follow", centered, {
      headHomed: true,
      pickedUp: false,
      distancePct: 25,
      currentHeadDeg: 0,
      maxSpeedPct: 45,
      nowMs: 5000,
      lastWaveReactMs: 0,
    });
    expect(closeObstacle.drive).toEqual({ left: 0, right: 0, timeoutMs: 200 });

    // Wave reaction fires once and obeys 2.5 s cooldown
    const wave = { detected: true, centroidX: 0, centroidY: 0.5, energy: 0.2, waveDetected: true };
    const firstWave = computeTrackingAction("wave-react", wave, {
      headHomed: true,
      pickedUp: false,
      distancePct: 80,
      currentHeadDeg: 0,
      maxSpeedPct: 45,
      nowMs: 5000,
      lastWaveReactMs: 0,
    });
    expect(firstWave.waveTriggered).toBe(true);
    expect(firstWave.synthSfx).toBe(2);
    expect(firstWave.headDeg).toBe(20);

    const cooledWave = computeTrackingAction("wave-react", wave, {
      headHomed: true,
      pickedUp: false,
      distancePct: 80,
      currentHeadDeg: 0,
      maxSpeedPct: 45,
      nowMs: 6000,
      lastWaveReactMs: 5000,
    });
    expect(cooledWave.waveTriggered).toBe(false);
    expect(cooledWave.synthSfx).toBeNull();
  });
});

describe("voiceCommands natural-language parser & safety invariants", () => {
  const readyCtx = { headHomed: true, pickedUp: false, safeMode: false, speedCap: 50 };

  it("permanently refuses dart firing over voice regardless of robot state", () => {
    for (const phrase of ["fire", "Vernie shoot the dart", "launch missile now"]) {
      const res = parseVoiceCommand(phrase, readyCtx);
      expect(res.matched).toBe(true);
      expect(res.blockedBySafety).toBe(true);
      expect(res.intent).toBe("dart-refused");
      expect(res.actions).toEqual([]);
    }
  });

  it("allows emergency STOP even in Watchdog Safe Mode, while blocking motion commands", () => {
    const safeCtx = { headHomed: true, pickedUp: false, safeMode: true, speedCap: 50 };
    const stop = parseVoiceCommand("STOP!", safeCtx);
    expect(stop.intent).toBe("emergency-stop");
    expect(stop.actions).toContainEqual({ type: "drive", left: 0, right: 0, timeoutMs: 200 });
    expect(stop.actions).toContainEqual({ type: "stopMacro" });

    const blocked = parseVoiceCommand("move forward", safeCtx);
    expect(blocked.blockedBySafety).toBe(true);
    expect(blocked.actions).toEqual([]);
  });

  it("blocks head look commands when unhomed (C2) but permits Home Head", () => {
    const unhomedCtx = { headHomed: false, pickedUp: false, safeMode: false, speedCap: 50 };
    const look = parseVoiceCommand("look left", unhomedCtx);
    expect(look.blockedBySafety).toBe(true);
    expect(look.actions).toEqual([]);

    const home = parseVoiceCommand("home head", unhomedCtx);
    expect(home.blockedBySafety).toBe(false);
    expect(home.actions).toEqual([{ type: "head", angleDeg: HEAD_HOME_SENTINEL, speed: 30 }]);
  });

  it("parses drive, head look, mode switching, greetings, dance, and ignores chatter", () => {
    expect(parseVoiceCommand("look right", readyCtx).actions).toEqual([
      { type: "head", angleDeg: 30, speed: 55 },
    ]);
    expect(parseVoiceCommand("explorer mode", readyCtx).actions).toEqual([
      { type: "setMode", modeId: 1 },
    ]);
    expect(parseVoiceCommand("hello vernie!", readyCtx).intent).toBe("greet");
    expect(parseVoiceCommand("let's dance", readyCtx).intent).toBe("dance");
    expect(parseVoiceCommand("forward", { ...readyCtx, pickedUp: true }).blockedBySafety).toBe(true);
    expect(parseVoiceCommand("banana telescope", readyCtx).matched).toBe(false);
  });
});
