// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// Comprehensive Unit & UI Tests for Pixel Fold (2023) 90° On-Board Auto-Pilot,
// Left-Offset Vision Calibration, Gimbal-Lock-Free Gyro Heading, Encoder Saturation Fallback,
// Escalating Unstick / Semantic AI Fusion, and Black-Box Flight Recorder ZIP Export.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";
import { App } from "./App";
import {
  analyzeFloorCorridors,
  computeOpticalFlow,
  computeSweptBumperBounds,
  createFloorModel,
  extractLuma,
  PIXEL_FOLD_DEFAULT_CALIBRATION,
} from "./vision/roverVision";
import { computeMatrixHeadingDeg, FoldHeadingTracker } from "./rover/foldHeading";
import { RoomMapper } from "./rover/roomMap";
import { IntelligentExplorer } from "./rover/intelligentExplorer";
import { crc32Bytes, createStoreZip, FlightRecorder } from "./rover/flightRecorder";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

describe("Pixel Fold Left-Offset Vision, Shadow Tolerance, Floor Freeze & Chair-Leg Detection", () => {
  it("projects left-offset camera chassis rails asymmetrically to protect the protruding right tread", () => {
    const centered = computeSweptBumperBounds(
      { camOffsetCm: 0, robotWidthCm: 17, fovDeg: 78 },
      0.1
    );
    const leftOffset = computeSweptBumperBounds(PIXEL_FOLD_DEFAULT_CALIBRATION, 0.1);

    expect(centered.uCenter).toBeCloseTo(0.5, 2);
    // Camera offset -4 cm left -> robot centerline shifts RIGHT in image (uCenter > 0.5)
    expect(leftOffset.uCenter).toBeGreaterThan(0.55);
    expect(leftOffset.uRight - 0.5).toBeGreaterThan(0.5 - leftOffset.uLeft);

    // Paint an obstacle right in front of the protruding right tread (x = 64..76% of frame)
    const w = 160;
    const h = 120;
    const frame = fillSolidFrame(w, h, 200, 185, 160);
    paintRect(frame, w, h, 102, 60, 128, 108, 25, 35, 65);

    const resCentered = analyzeFloorCorridors(frame, w, h, {
      calibration: { ...PIXEL_FOLD_DEFAULT_CALIBRATION, camOffsetCm: 0 },
    });
    const resLeftCam = analyzeFloorCorridors(frame, w, h, {
      calibration: { ...PIXEL_FOLD_DEFAULT_CALIBRATION, camOffsetCm: -5.5 },
    });

    // Left-offset calibration detects the right-tread obstacle in sweptClear immediately!
    expect(resLeftCam.sweptClear).toBeLessThan(0.3);
    expect(resLeftCam.sweptClear).toBeLessThan(resCentered.sweptClear);
  });

  it("tolerates soft same-chromaticity shadows on flat floor while catching narrow vertical chair legs", () => {
    const w = 160;
    const h = 120;
    // Warm beige hardwood floor
    const shadowFrame = fillSolidFrame(w, h, 196, 178, 152);
    // Cast a soft shadow across the middle (same chromaticity ratio, ~22% darker)
    paintRect(shadowFrame, w, h, 40, 56, 120, 96, 154, 140, 119);
    const shadowRes = analyzeFloorCorridors(shadowFrame, w, h, {
      calibration: { ...PIXEL_FOLD_DEFAULT_CALIBRATION, camOffsetCm: 0 },
    });
    expect(shadowRes.corridors[2]).toBeGreaterThan(0.8);

    // Now paint a narrow dark vertical chair leg (only 6 px wide inside 32 px center sector = 19% width!)
    const legFrame = fillSolidFrame(w, h, 196, 178, 152);
    paintRect(legFrame, w, h, 77, 50, 83, 106, 28, 24, 22);
    const legRes = analyzeFloorCorridors(legFrame, w, h, {
      calibration: { ...PIXEL_FOLD_DEFAULT_CALIBRATION, camOffsetCm: 0 },
    });
    expect(legRes.corridors[2]).toBeLessThan(0.35);
    expect(legRes.sweptClear).toBeLessThan(0.35);
  });

  it("freezes persistent EMA floor model near walls so close obstacles never poison floor color", () => {
    const w = 80;
    const h = 60;
    const model = createFloorModel();

    // Step 1: Learn warm tan floor on open frame
    const openFloor = fillSolidFrame(w, h, 200, 185, 155);
    const res1 = analyzeFloorCorridors(openFloor, w, h, {
      floorModel: model,
      allowFloorUpdate: true,
    });
    expect(res1.corridors[2]).toBeGreaterThan(0.9);
    expect(model.samples).toBe(1);

    // Step 2: Robot drives right up to a solid navy wall filling the entire frame,
    // with allowFloorUpdate=false (simulating 88007 front sensor <= 28%)
    const closeWall = fillSolidFrame(w, h, 28, 42, 78);
    const res2 = analyzeFloorCorridors(closeWall, w, h, {
      floorModel: model,
      allowFloorUpdate: false,
    });
    // Frozen floor model recognizes the entire wall as blocked instead of re-learning navy as "floor"!
    expect(res2.corridors[2]).toBeLessThan(0.15);
    expect(res2.sweptClear).toBeLessThan(0.15);
  });

  it("reports optical flow texture confidence to separate textured stiction from blank walls", () => {
    const w = 160;
    const h = 120;
    const blank1 = fillSolidFrame(w, h, 180, 180, 180);
    const blank2 = fillSolidFrame(w, h, 180, 180, 180);
    const flowBlank = computeOpticalFlow(extractLuma(blank1, w, h), blank2, w, h);
    expect(flowBlank.validPatches).toBe(0);
    expect(flowBlank.confidence).toBe(0);

    // Textured stationary scene (simulated rug/furniture)
    const tex = fillSolidFrame(w, h, 160, 160, 160);
    for (let y = 30; y < 110; y += 8) {
      paintRect(tex, w, h, 10, y, 150, y + 4, 65, 65, 65);
    }
    const flowStuckOnRug = computeOpticalFlow(extractLuma(tex, w, h), tex, w, h);
    expect(flowStuckOnRug.validPatches).toBeGreaterThanOrEqual(5);
    expect(flowStuckOnRug.confidence).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(flowStuckOnRug.flowForward)).toBeLessThan(0.05);
  });

  it("detects smooth white skirting board on plush textured beige carpet without poisoning floorModel", () => {
    const w = 160;
    const h = 120;
    const fillCarpet = (): Uint8ClampedArray => {
      const buf = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // Deterministic carpet pile micro-texture matching real Pixel Fold carpet readings (~13 tex)
          const grain = (((x * 37 + y * 17) ^ (x * 13 - y * 29)) & 31) - 16;
          const idx = (y * w + x) * 4;
          buf[idx] = Math.max(0, Math.min(255, 114 + grain));
          buf[idx + 1] = Math.max(0, Math.min(255, 97 + grain));
          buf[idx + 2] = Math.max(0, Math.min(255, 81 + grain));
          buf[idx + 3] = 255;
        }
      }
      return buf;
    };

    const model = createFloorModel();
    // Frame 1: open plush beige carpet -> learns carpet color & high 4x4 micro-texture
    const openCarpet = fillCarpet();
    const resOpen = analyzeFloorCorridors(openCarpet, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model,
      allowFloorUpdate: true,
    });
    expect(resOpen.sweptClear).toBeGreaterThan(0.85);
    expect(model.tex).toBeGreaterThanOrEqual(8);

    // Frame 2: smooth painted white skirting board / doorframe on right half (low-chroma neutral white!)
    const skirtingFrame = fillCarpet();
    paintRect(skirtingFrame, w, h, 82, 30, 160, 112, 136, 131, 124);
    const resWall = analyzeFloorCorridors(skirtingFrame, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model,
      allowFloorUpdate: true,
    });
    expect(resWall.corridors[3]).toBeLessThan(0.15);
    expect(resWall.corridors[4]).toBeLessThan(0.15);
    expect(resWall.sweptClear).toBeLessThan(0.25);
    expect(resWall.bestSteer).toBeLessThan(-0.4); // Steers strongly left away from doorframe!

    // Frame 3: smooth white wall fills entire bottom floor patch -> texture guard rejects poisoning!
    const allWall = fillSolidFrame(w, h, 136, 131, 124);
    const prevSamples = model.samples;
    const resClose = analyzeFloorCorridors(allWall, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model,
      allowFloorUpdate: true,
    });
    expect(model.samples).toBe(prevSamples);
    expect(resClose.sweptClear).toBeLessThan(0.1);
  });

  it("adapts smoothly to +70 luma Pixel Fold AE bright-carpet jumps while still blocking smooth grey ottomans", () => {
    const w = 160;
    const h = 120;
    const makeCarpet = (baseR: number, baseG: number, baseB: number): Uint8ClampedArray => {
      const buf = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const grain = (((x * 37 + y * 17) ^ (x * 13 - y * 29)) & 15) - 8;
          const idx = (y * w + x) * 4;
          buf[idx] = Math.max(0, Math.min(255, baseR + grain));
          buf[idx + 1] = Math.max(0, Math.min(255, baseG + grain));
          buf[idx + 2] = Math.max(0, Math.min(255, baseB + grain));
          buf[idx + 3] = 255;
        }
      }
      return buf;
    };

    const model = createFloorModel();
    // Frame 1: shaded beige carpet (Y ≈ 100)
    const shaded = makeCarpet(116, 97, 82);
    const res1 = analyzeFloorCorridors(shaded, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model,
      allowFloorUpdate: true,
    });
    expect(res1.sweptClear).toBeGreaterThan(0.85);

    // Frame 2: sudden Pixel Fold AE jump (+70 luma, same beige chroma!) -> stays open & adapts!
    const sunlit = makeCarpet(189, 168, 150);
    const res2 = analyzeFloorCorridors(sunlit, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model,
      allowFloorUpdate: true,
    });
    expect(res2.sweptClear).toBeGreaterThan(0.85);
    expect(res2.corridors[2]).toBeGreaterThan(0.85);

    // Frame 3: smooth grey fabric ottoman occupying left-center on carpet -> blocked cleanly!
    const ottoman = makeCarpet(116, 97, 82);
    paintRect(ottoman, w, h, 20, 35, 130, 110, 136, 119, 111);
    const model2 = createFloorModel();
    analyzeFloorCorridors(shaded, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model2,
      allowFloorUpdate: true,
    });
    const resOtt = analyzeFloorCorridors(ottoman, w, h, {
      calibration: PIXEL_FOLD_DEFAULT_CALIBRATION,
      floorModel: model2,
      allowFloorUpdate: true,
    });
    expect(resOtt.sweptClear).toBeLessThan(0.25);
  });
});

describe("Gimbal-Lock-Free Gravity-Projected Gyro Heading (90° Pixel Fold Mount)", () => {
  it("integrates clockwise ground-plane yaw accurately at both 90° upright and 0° flat postures", () => {
    // Posture A: Phone standing vertically upright at 90° (ay = +9.81 up)
    const upright = new FoldHeadingTracker();
    upright.reset(0);
    for (let t = 0; t <= 1000; t += 100) {
      // Right turn (clockwise from above) -> negative rotation around +Y (rotGamma = -90 deg/s)
      upright.ingestMotion({
        nowMs: t,
        ax: 0,
        ay: 9.81,
        az: 0,
        rotBeta: 0,
        rotGamma: -90,
        rotAlpha: 0,
      });
    }
    const upSnap = upright.getSnapshot();
    expect(upSnap.source).toBe("gyro-gravity");
    expect(upSnap.headingDeg).toBeGreaterThanOrEqual(85);
    expect(upSnap.headingDeg).toBeLessThanOrEqual(95);

    // Posture B: Phone lying completely flat (az = +9.81 up)
    const flat = new FoldHeadingTracker();
    flat.reset(0);
    for (let t = 0; t <= 1000; t += 100) {
      // Right turn -> negative rotation around +Z (rotAlpha = -90 deg/s)
      flat.ingestMotion({
        nowMs: t,
        ax: 0,
        ay: 0,
        az: 9.81,
        rotBeta: 0,
        rotGamma: 0,
        rotAlpha: -90,
      });
    }
    const flatSnap = flat.getSnapshot();
    expect(flatSnap.source).toBe("gyro-gravity");
    expect(flatSnap.headingDeg).toBeGreaterThanOrEqual(85);
    expect(flatSnap.headingDeg).toBeLessThanOrEqual(95);
  });

  it("orientation matrix fallback stays continuous at beta = 90° vertical mount", () => {
    expect(computeMatrixHeadingDeg(0, 90, 0)).toBeCloseTo(0, 0);
    expect(computeMatrixHeadingDeg(270, 90, 0)).toBeCloseTo(90, 0);
    expect(computeMatrixHeadingDeg(180, 90, 0)).toBeCloseTo(180, 0);
    expect(computeMatrixHeadingDeg(90, 90, 0)).toBeCloseTo(270, 0);
  });
});

describe("RoomMapper Encoder Saturation Fallback & IntelligentExplorer Upgrades", () => {
  it("keeps integrating odometry via speedA/speedB after Move Hub int16 encoders clamp at 32767", () => {
    const mapper = new RoomMapper();
    mapper.update({
      encA: 32767,
      encB: 32767,
      speedA: 50,
      speedB: 50,
      dtMs: 100,
      gyroHeadingDeg: 0,
      frontDistancePct: 90,
      corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
    });
    for (let i = 0; i < 10; i++) {
      mapper.update({
        encA: 32767,
        encB: 32767,
        speedA: 50,
        speedB: 50,
        dtMs: 100,
        gyroHeadingDeg: 0,
        frontDistancePct: 90,
        corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
      });
    }
    expect(mapper.isEncoderSaturated()).toBe(true);
    // 1.0 s @ 600 deg/s * 0.038 cm/deg = ~22.8 cm
    expect(mapper.getPoseCm().y).toBeGreaterThan(20);
  });

  it("triggers wheel-spin UNSTICKING even when treads keep spinning on a rug, and escalates Tier 1 -> Tier 2", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    let enc = 0;
    let firstUnstick: ReturnType<IntelligentExplorer["step"]> | null = null;

    // Treads spinning freely (enc += 40, speed = 45), yet textured optical flow is 0!
    for (let t = 0; t <= 2800; t += 150) {
      enc += 40;
      const out = exp.step({
        nowMs: t,
        mission: "explore-room",
        speedCap: 65,
        pickedUp: false,
        safeMode: false,
        bump: false,
        frontDistancePct: 80,
        corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
        sweptClear: 0.8,
        bestSteer: 0,
        flowForward: 0.01,
        flowTurn: 0,
        flowConfidence: 0.85,
        encA: enc,
        encB: enc,
        speedA: 45,
        speedB: 45,
        objects: [],
        mapper,
      });
      if (out.state === "UNSTICKING") {
        firstUnstick = out;
        break;
      }
    }
    expect(firstUnstick).not.toBeNull();
    expect(firstUnstick!.stuckReason).toBe("wheel-spin");
    expect(firstUnstick!.statusNote).toMatch(/Tier 1/i);

    // Finish Tier 1 unstick (~1200 ms) then immediately get snagged again -> must escalate to Tier 2!
    let secondUnstick: ReturnType<IntelligentExplorer["step"]> | null = null;
    for (let t = 3000; t <= 8500; t += 150) {
      enc += 40;
      const out = exp.step({
        nowMs: t,
        mission: "explore-room",
        speedCap: 65,
        pickedUp: false,
        safeMode: false,
        bump: false,
        frontDistancePct: 80,
        corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
        sweptClear: 0.8,
        bestSteer: 0,
        flowForward: 0,
        flowTurn: 0,
        flowConfidence: 0.9,
        encA: enc,
        encB: enc,
        speedA: 45,
        speedB: 45,
        objects: [],
        mapper,
      });
      if (out.state === "UNSTICKING" && out.recoveries === 2) {
        secondUnstick = out;
        break;
      }
    }
    expect(secondUnstick).not.toBeNull();
    expect(secondUnstick!.statusNote).toMatch(/Tier 2/i);
  });

  it("fuses close AI chair detections into obstacle avoidance even when floor corridors look open", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    const res = exp.step({
      nowMs: 1000,
      mission: "explore-room",
      speedCap: 65,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 85,
      corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
      sweptClear: 0.9,
      bestSteer: 0,
      flowForward: 1.0,
      flowConfidence: 0.8,
      encA: 100,
      encB: 100,
      speedA: 40,
      speedB: 40,
      objects: [
        // Close chair occupying left-center sectors (bottom y+h = 0.86)
        { id: "c1", label: "chair", score: 0.82, x: 0.12, y: 0.36, w: 0.44, h: 0.5, source: "ai" },
      ],
      mapper,
    });
    expect(res.state).toBe("CRUISING");
    // Steers smoothly RIGHT (left > right) away from the chair on the left-center!
    expect(res.left).toBeGreaterThan(res.right);
  });

  it("ignores transient 400 ms carpet pickedUp/bump jolts while pausing on >= 900 ms lift or instant safeMode", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    const base = {
      mission: "explore-room" as const,
      speedCap: 65,
      safeMode: false,
      frontDistancePct: 100,
      corridors: [0.95, 0.95, 0.95, 0.95, 0.95] as [number, number, number, number, number],
      sweptClear: 0.95,
      bestSteer: 0,
      flowForward: 1.2,
      flowConfidence: 0.9,
      headingDeg: 10,
      encA: 200,
      encB: 200,
      speedA: 42,
      speedB: 54,
      objects: [],
      mapper,
    };

    // 400 ms carpet jolt (pickedUp=true & bump=true while briskly rolling across open floor) -> stays CRUISING!
    for (let t = 100; t <= 400; t += 100) {
      const out = exp.step({ ...base, nowMs: t, pickedUp: true, bump: true });
      expect(out.state).toBe("CRUISING");
      expect(out.left).toBeGreaterThan(20);
      expect(out.right).toBeGreaterThan(20);
    }

    // Clear jolt for 300 ms, then simulate a genuine continuous lift (>= 900 ms) -> pauses cleanly!
    for (let t = 500; t <= 700; t += 100) {
      exp.step({ ...base, nowMs: t, pickedUp: false, bump: false });
    }
    let liftOut = exp.step({ ...base, nowMs: 800, pickedUp: true, bump: false });
    for (let t = 900; t <= 1800; t += 100) {
      liftOut = exp.step({ ...base, nowMs: t, pickedUp: true, bump: false });
    }
    expect(liftOut.state).toBe("PAUSED");
    expect(liftOut.left).toBe(0);
    expect(liftOut.right).toBe(0);

    // safeMode must ALWAYS pause on tick 1 (0 ms)!
    const expSafe = new IntelligentExplorer();
    const safeOut = expSafe.step({ ...base, nowMs: 100, pickedUp: false, bump: false, safeMode: true });
    expect(safeOut.state).toBe("PAUSED");
    expect(safeOut.left).toBe(0);
    expect(safeOut.right).toBe(0);
  });

  it("snaps immediately into dual-tread reverse and counter-rotating carpet spin on AVOIDING entry", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    const base = {
      mission: "explore-room" as const,
      speedCap: 65,
      pickedUp: false,
      safeMode: false,
      bump: false,
      flowForward: 1.0,
      flowConfidence: 0.9,
      headingDeg: 0,
      encA: 100,
      encB: 100,
      speedA: 45,
      speedB: 45,
      objects: [],
      mapper,
    };

    // Prime forward cruise momentum
    exp.step({
      ...base,
      nowMs: 1000,
      frontDistancePct: 90,
      corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
      sweptClear: 0.9,
      bestSteer: 0,
    });

    // Hit close wall (frontDistancePct=20, open on left) -> MUST snap BOTH treads strongly negative immediately!
    const revTick = exp.step({
      ...base,
      nowMs: 1100,
      frontDistancePct: 20,
      corridors: [0.7, 0.6, 0.05, 0.0, 0.0],
      sweptClear: 0.0,
      bestSteer: -0.9,
    });
    expect(revTick.state).toBe("AVOIDING");
    expect(revTick.left).toBeLessThanOrEqual(-35);
    expect(revTick.right).toBeLessThanOrEqual(-35);

    // After backing clear (~700 ms), Phase B executes a counter-rotating carpet spin (left * right < 0)!
    let spinTick = revTick;
    for (let t = 1200; t <= 1900; t += 100) {
      spinTick = exp.step({
        ...base,
        nowMs: t,
        frontDistancePct: 50,
        corridors: [0.75, 0.65, 0.35, 0.1, 0.0],
        sweptClear: 0.35,
        bestSteer: -0.7,
      });
      if (spinTick.left * spinTick.right < 0) break;
    }
    expect(spinTick.state).toBe("AVOIDING");
    expect(spinTick.left * spinTick.right).toBeLessThan(0);
    expect(Math.abs(spinTick.left)).toBeGreaterThanOrEqual(45);
    expect(Math.abs(spinTick.right)).toBeGreaterThanOrEqual(45);
  });

  it("triggers UNSTICKING via net-progress gyro+flow window when rocking in place against a doorframe", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    let encB = 1000;
    let unstickTick: ReturnType<IntelligentExplorer["step"]> | null = null;

    // Simulate Run #1 doorframe pin: right tread spinning freely, left pinned, phone rocking ±1° & ±0.25 flow!
    for (let i = 0; i < 24; i++) {
      const t = 1000 + i * 100;
      encB += 45;
      const out = exp.step({
        nowMs: t,
        mission: "explore-room",
        speedCap: 65,
        pickedUp: false,
        safeMode: false,
        bump: false,
        frontDistancePct: 45,
        corridors: [0.7, 0.6, 0.3, 0.1, 0.0],
        sweptClear: 0.3,
        bestSteer: -0.8,
        flowForward: i % 2 === 0 ? 0.22 : -0.2,
        flowTurn: 0,
        flowConfidence: 0.95,
        headingDeg: 338 + (i % 2 === 0 ? 1 : -1),
        yawRateDegS: i % 2 === 0 ? 12 : -12,
        encA: 1000,
        encB,
        speedA: 0,
        speedB: 60,
        objects: [],
        mapper,
      });
      if (out.state === "UNSTICKING") {
        unstickTick = out;
        break;
      }
    }
    expect(unstickTick).not.toBeNull();
    expect(unstickTick!.recoveries).toBe(1);
    expect(unstickTick!.left).toBeLessThanOrEqual(-35);
    expect(unstickTick!.right).toBeLessThanOrEqual(-35);
  });

  it("never blindly reverses when front >= 65% and immediately aborts reverse on rear bump with cooldown", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    const base = {
      mission: "explore-room" as const,
      speedCap: 65,
      pickedUp: false,
      safeMode: false,
      bump: false,
      flowForward: 0.5,
      flowConfidence: 0.9,
      headingDeg: 160,
      encA: 100,
      encB: 100,
      speedA: 40,
      speedB: 40,
      objects: [],
      mapper,
    };

    // Case A: Vision sees distant obstacle (sweptClear=0) yet front 88007 is 100% -> skips reverse, rolls forward arc!
    let distantOut = exp.step({
      ...base,
      nowMs: 1000,
      frontDistancePct: 100,
      corridors: [0.0, 0.0, 0.0, 0.0, 0.6],
      sweptClear: 0.0,
      bestSteer: 0.6,
    });
    for (let t = 1100; t <= 1400; t += 100) {
      distantOut = exp.step({
        ...base,
        nowMs: t,
        frontDistancePct: 100,
        corridors: [0.0, 0.0, 0.0, 0.0, 0.6],
        sweptClear: 0.0,
        bestSteer: 0.6,
      });
      expect(distantOut.throttle).toBeGreaterThanOrEqual(0);
    }
    expect(distantOut.state).toBe("AVOIDING");

    // Case B: Close front obstacle (frontDistancePct=20) enters short reverse, then a REAR BUMP at +200 ms
    // MUST abort reverse immediately and prevent reversing again on back-to-back AVOIDING!
    const expRear = new IntelligentExplorer();
    const rev1 = expRear.step({
      ...base,
      nowMs: 1000,
      frontDistancePct: 20,
      corridors: [0.7, 0.6, 0.05, 0.0, 0.0],
      sweptClear: 0.0,
      bestSteer: -0.8,
    });
    expect(rev1.state).toBe("AVOIDING");
    expect(rev1.throttle).toBeLessThan(-0.5);

    // At +200 ms while reversing, back of tank hits rear wall (bump=true) -> immediately aborts reverse!
    const aborted = expRear.step({
      ...base,
      nowMs: 1200,
      bump: true,
      frontDistancePct: 35,
      corridors: [0.7, 0.6, 0.05, 0.0, 0.0],
      sweptClear: 0.0,
      bestSteer: -0.8,
    });
    expect(aborted.state).toBe("AVOIDING");
    expect(aborted.throttle).toBeGreaterThanOrEqual(0);
  });

  it("switches from stationary pivot to rolling carpet-grip forward arc when gyro detects tire slip", () => {
    const mapper = new RoomMapper();
    const exp = new IntelligentExplorer();
    const base = {
      mission: "explore-room" as const,
      speedCap: 65,
      pickedUp: false,
      safeMode: false,
      bump: false,
      flowForward: 0.05,
      flowConfidence: 0.9,
      headingDeg: 162, // frozen heading -> wheels slipping on carpet!
      encA: 100,
      encB: 100,
      speedA: 40,
      speedB: -40,
      objects: [],
      mapper,
    };

    // Enter AVOIDING via close wall (front=20), then move to front=48 while gyro stays stuck at 162°
    exp.step({
      ...base,
      nowMs: 1000,
      frontDistancePct: 20,
      corridors: [0.8, 0.7, 0.05, 0.0, 0.0],
      sweptClear: 0.0,
      bestSteer: -0.8,
    });

    let pivotSeen = false;
    let rollingFallbackSeen = false;
    for (let t = 1100; t <= 3100; t += 100) {
      const out = exp.step({
        ...base,
        nowMs: t,
        frontDistancePct: 48,
        corridors: [0.8, 0.7, 0.2, 0.0, 0.0],
        sweptClear: 0.2,
        bestSteer: -0.8,
      });
      if (out.state === "AVOIDING" && out.left * out.right < 0) pivotSeen = true;
      if (pivotSeen && out.state === "AVOIDING" && out.throttle > 0.25 && out.left > 0 && out.right > 0) {
        rollingFallbackSeen = true;
        break;
      }
    }
    expect(pivotSeen).toBe(true);
    expect(rollingFallbackSeen).toBe(true);
  });
});

describe("Black-Box FlightRecorder & Zero-Dependency ZIP Exporter", () => {
  it("computes standard IEEE CRC-32 and builds a valid PKWARE STORE ZIP bundle", async () => {
    const checkBytes = new TextEncoder().encode("123456789");
    expect(crc32Bytes(checkBytes)).toBe(0xcbf43926);

    const zipBytes = createStoreZip([
      { name: "hello.txt", data: new TextEncoder().encode("Vernie Pixel Fold") },
      { name: "dir/data.json", data: new TextEncoder().encode('{"ok":true}') },
    ]);
    const view = new DataView(zipBytes.buffer);
    // Local file header magic PK\x03\x04
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // End of Central Directory magic PK\x05\x06 at tail - 22
    expect(view.getUint32(zipBytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zipBytes.length - 12, true)).toBe(2);

    const rec = new FlightRecorder(PIXEL_FOLD_DEFAULT_CALIBRATION);
    rec.start();
    rec.recordTick(
      {
        assistMode: "explorer",
        mission: "explore-room",
        fsmState: "CRUISING",
        statusNote: "Cruising open floor",
        corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
        horizonYs: [0.46, 0.46, 0.46, 0.46, 0.46],
        sweptClear: 0.8,
        bestSteer: 0,
        floorRgb: [190, 175, 150],
        floorNoise: 10,
        avgLuma: 140,
        flowForward: 1.1,
        flowTurn: 0,
        flowConfidence: 0.8,
        validPatches: 6,
        objects: [],
        hw: {
          bleConnected: true,
          batteryMv: 8100,
          distPct: 80,
          colorId: 0,
          pitch: 0,
          roll: 0,
          flags: TelemetryFlag.SENSOR_OK,
          bump: false,
          pickedUp: false,
          safeMode: false,
          sensorOk: true,
          encA: 120,
          encB: 120,
          speedA: 42,
          speedB: 42,
        },
        phone: {
          headingDeg: 15,
          yawRateDegS: 0,
          headingSource: "gyro-gravity",
          mountPitchDeg: 88,
          mountRollDeg: 1,
          rawAlpha: 10,
          rawBeta: 88,
          rawGamma: 1,
          torchOn: false,
          visionMs: 7.2,
          aiReady: false,
        },
        map: {
          xCm: 5,
          yCm: 35,
          headingDeg: 15,
          frontierBias: 0.1,
          coveragePct: 4,
          distanceM: 0.36,
          encSaturated: false,
        },
        cmd: { left: 45, right: 45, steer: 0, throttle: 0.65, recoveries: 0 },
      },
      null
    );
    rec.markProblem("clipped-right", null, "touched table leg");
    rec.stop(null);

    const stats = rec.getStats();
    expect(stats.tickCount).toBe(1);
    expect(stats.userTagCount).toBe(1);
    expect(stats.headingSource).toBe("gyro-gravity");

    const md = rec.buildSummaryMarkdown();
    expect(md).toContain("camOffset=-4cm");
    expect(md).toContain("TAG:clipped-right");

    const bundle = await rec.buildZipBundle();
    expect(bundle.filename).toMatch(/^vernie-fold-run-.*\.zip$/);
    expect(bundle.bytes.length).toBeGreaterThan(200);
  });
});

describe("On-Board Auto-Pilot (Fold 90°) UI Integration", () => {
  it("switches to Fold 90° view, tags a real-life problem, opens calibration drawer, and adjusts left offset", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const sampleTelem: TelemetryFrame = {
      batteryMv: 8200,
      distancePct: 60,
      colorId: 0,
      pitchDeg: 0,
      rollDeg: 0,
      flags: TelemetryFlag.SENSOR_OK,
      modeId: 4,
      encA: 0,
      encB: 0,
      headDeg: 0,
      speedA: 0,
      speedB: 0,
      seq: 1,
    };
    expect(sampleTelem.distancePct).toBe(60);

    const { unmount } = render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /FPV Rover/i }));
    fireEvent.click(screen.getByRole("tab", { name: /On-Board Auto-Pilot \(Fold 90°\)/i }));

    expect(screen.getByText(/Pixel Fold 90° On-Board Auto-Pilot/i)).toBeTruthy();

    // 1-tap Problem Tag works immediately and creates exportable run data
    fireEvent.click(screen.getByRole("button", { name: /Clipped Right/i }));
    expect(screen.getByText(/Marked "Clipped Right"/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Share Run \(\.zip\)/i }) as HTMLButtonElement).disabled).toBe(false);

    // Open Mount Calibration drawer and adjust Camera Left/Right Offset slider
    fireEvent.click(screen.getByRole("button", { name: /Mount \(-4cm\)/i }));
    const slider = document.getElementById("slider-cam-offset") as HTMLInputElement;
    expect(slider).toBeTruthy();
    fireEvent.change(slider, { target: { value: "-5.5" } });
    expect(screen.getAllByText(/-5\.5 cm/i).length).toBeGreaterThanOrEqual(1);

    // Toggle 90° Full Fold split screen
    fireEvent.click(screen.getByRole("button", { name: /90° Full Fold/i }));
    expect(screen.getByRole("button", { name: /Exit 90° Split/i })).toBeTruthy();

    unmount();
  });
});
