// SPDX-License-Identifier: MIT
// Phase 2 Unit Tests: Real-Time Rover Vision Engine & Smart Co-Pilot (ADAS) Controller.

import { describe, expect, it } from "vitest";
import { IntelligentDriveController } from "./rover/intelligentDrive";
import {
  analyzeFloorCorridors,
  computeOpticalFlow,
  detectFloorLaneOffset,
  extractLuma,
  rgbToHsv,
  sampleHsvTarget,
  trackHsvTarget,
} from "./vision/roverVision";

function fillSolidFrame(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
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
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number
): void {
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const idx = (y * w + x) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
    }
  }
}

describe("Phase 2 — Real-Time Rover Vision Engine", () => {
  it("converts primary RGB colors to accurate HSV", () => {
    const red = rgbToHsv(240, 20, 20);
    expect(red.h).toBeLessThan(10);
    expect(red.s).toBeGreaterThan(0.85);
    const blue = rgbToHsv(20, 60, 230);
    expect(blue.h).toBeGreaterThan(210);
    expect(blue.h).toBeLessThan(245);
  });

  it("detects a blocked left corridor and steers smoothly right into open floor", () => {
    const w = 80;
    const h = 60;
    // Uniform warm hardwood floor across entire frame
    const frame = fillSolidFrame(w, h, 205, 190, 165);
    // Paint a dark navy obstacle blocking the left half of the floor up close
    paintRect(frame, w, h, 0, 26, 36, 54, 24, 34, 52);

    const res = analyzeFloorCorridors(frame, w, h);
    expect(res.corridors[0]).toBeLessThan(0.3);
    expect(res.corridors[1]).toBeLessThan(0.3);
    expect(res.corridors[3]).toBeGreaterThan(0.85);
    expect(res.corridors[4]).toBeGreaterThan(0.85);
    expect(res.bestSteer).toBeGreaterThan(0.35);
  });

  it("samples and tracks a tapped bright red object in HSV space", () => {
    const w = 64;
    const h = 48;
    const frame = fillSolidFrame(w, h, 180, 175, 165);
    paintRect(frame, w, h, 40, 16, 54, 30, 225, 30, 35);

    const model = sampleHsvTarget(frame, w, h, 47 / w, 23 / h);
    expect(model).not.toBeNull();
    const box = trackHsvTarget(frame, w, h, model!);
    expect(box).not.toBeNull();
    expect(box!.x + box!.w / 2).toBeGreaterThan(0.62);
    expect(box!.source).toBe("hsv");
  });

  it("detects forward optical flow shift vs stationary frame", () => {
    const w = 64;
    const h = 48;
    const f1 = fillSolidFrame(w, h, 150, 150, 150);
    // Textured horizontal bands on floor
    for (let y = 18; y < 44; y += 6) {
      paintRect(f1, w, h, 4, y, 60, y + 3, 70, 70, 70);
    }
    const f2 = fillSolidFrame(w, h, 150, 150, 150);
    // Shift bands downward by 2 pixels (simulating rover driving forward)
    for (let y = 20; y < 46; y += 6) {
      paintRect(f2, w, h, 4, y, 60, y + 3, 70, 70, 70);
    }

    const luma1 = extractLuma(f1, w, h);
    const flowMoving = computeOpticalFlow(luma1, f2, w, h);
    const flowStill = computeOpticalFlow(luma1, f1, w, h);
    expect(flowMoving.flowForward).toBeGreaterThan(1.0);
    expect(Math.abs(flowStill.flowForward)).toBeLessThan(0.1);
  });

  it("detects floor painter's-tape lane offset accurately", () => {
    const w = 64;
    const h = 48;
    const frame = fillSolidFrame(w, h, 210, 200, 185);
    // Blue painter's tape stripe on right side of lower floor
    paintRect(frame, w, h, 46, 32, 53, 46, 20, 90, 235);
    const offset = detectFloorLaneOffset(frame, w, h);
    expect(offset).not.toBeNull();
    expect(offset!).toBeGreaterThan(0.35);
  });
});

describe("Phase 2 — IntelligentDriveController (Smart Co-Pilot ADAS)", () => {
  const baseInput = {
    rawSteer: 0,
    rawThrottle: 1,
    speedCap: 60,
    frontDistancePct: 80,
    corridors: [0.9, 0.9, 0.9, 0.9, 0.9] as [number, number, number, number, number],
    pickedUp: false,
    safeMode: false,
    headingDeg: 90,
    encA: 0,
    encB: 0,
    collisionGuard: "brake" as const,
    headingHold: false,
    laneAssist: false,
    laneOffset: null,
    lockedTarget: null,
  };

  it("auto-brakes on close front bumper obstacle while ALWAYS allowing reverse", () => {
    const ctrl = new IntelligentDriveController();
    const stopped = ctrl.step({ ...baseInput, frontDistancePct: 20, rawThrottle: 1 });
    expect(stopped.left).toBe(0);
    expect(stopped.right).toBe(0);
    expect(stopped.intervening).toBe("braking");

    // Reversing away from the obstacle must NEVER be blocked!
    const reversing = ctrl.step({ ...baseInput, frontDistancePct: 20, rawThrottle: -0.8 });
    expect(reversing.left).toBeLessThan(-30);
    expect(reversing.right).toBeLessThan(-30);
  });

  it("auto-dodges toward clearer corridor when collisionGuard is dodge", () => {
    const ctrl = new IntelligentDriveController();
    const dodged = ctrl.step({
      ...baseInput,
      collisionGuard: "dodge",
      corridors: [0.1, 0.15, 0.1, 0.85, 0.95],
      rawThrottle: 0.9,
    });
    expect(dodged.intervening).toBe("dodging");
    expect(dodged.left).toBeGreaterThan(dodged.right); // Turning right into open space!
  });

  it("applies straight-line gyro heading hold trim when robot drifts left", () => {
    const ctrl = new IntelligentDriveController();
    // Lock heading at 90°
    ctrl.step({ ...baseInput, headingHold: true, headingDeg: 90 });
    // Rover drifts left to 78° -> must trim right (left > right)
    const corrected = ctrl.step({ ...baseInput, headingHold: true, headingDeg: 78 });
    expect(corrected.intervening).toBe("heading");
    expect(corrected.left).toBeGreaterThan(corrected.right);
  });

  it("tracks a locked object hands-free and halts cleanly when close", () => {
    const ctrl = new IntelligentDriveController();
    const followRight = ctrl.step({
      ...baseInput,
      rawThrottle: 0,
      rawSteer: 0,
      lockedTarget: {
        id: "ball-1",
        label: "sports ball",
        score: 0.9,
        x: 0.72,
        y: 0.4,
        w: 0.14,
        h: 0.16,
        source: "sim",
      },
    });
    expect(followRight.intervening).toBe("following");
    expect(followRight.left).toBeGreaterThan(followRight.right);

    // Once target is centered & bumper is close -> holds position
    const closeHold = ctrl.step({
      ...baseInput,
      rawThrottle: 0,
      rawSteer: 0,
      frontDistancePct: 30,
      lockedTarget: {
        id: "ball-1",
        label: "sports ball",
        score: 0.92,
        x: 0.42,
        y: 0.35,
        w: 0.16,
        h: 0.18,
        source: "sim",
      },
    });
    expect(closeHold.left).toBe(0);
    expect(closeHold.right).toBe(0);
  });
});
