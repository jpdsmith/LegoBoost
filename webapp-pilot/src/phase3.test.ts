// SPDX-License-Identifier: MIT
// Phase 3 Unit Tests: Live 2D RoomMapper & Smooth Continuous IntelligentExplorer.

import { describe, expect, it } from "vitest";
import { IntelligentExplorer } from "./rover/intelligentExplorer";
import { RoomMapper } from "./rover/roomMap";

describe("Phase 3 — 2D RoomMapper Odometry, Obstacles, Frontier & Return-Home", () => {
  it("integrates wheel encoder odometry, records obstacles, and guides Return Home", () => {
    const mapper = new RoomMapper();
    mapper.update({
      encA: 0,
      encB: 0,
      gyroHeadingDeg: 0,
      frontDistancePct: 90,
      corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
    });
    mapper.update({
      encA: 500,
      encB: 500,
      gyroHeadingDeg: 0,
      frontDistancePct: 90,
      corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
    });
    mapper.update({
      encA: 1000,
      encB: 1000,
      gyroHeadingDeg: 0,
      frontDistancePct: 25,
      corridors: [0.9, 0.9, 0.1, 0.9, 0.9],
    });

    const pose = mapper.getPoseCm();
    expect(pose.y).toBeGreaterThan(30);
    const snap = mapper.getSnapshot();
    expect(snap.visited.length).toBeGreaterThanOrEqual(2);
    expect(snap.obstacles.length).toBeGreaterThanOrEqual(1);
    expect(snap.distanceMeters).toBeGreaterThan(0.3);

    const home = mapper.getReturnHomeGuidance();
    expect(home.arrived).toBe(false);
    expect(Math.abs(home.turnErrorDeg)).toBeGreaterThan(165);
  });

  it("biases frontier steering toward unexplored side when one side has obstacles", () => {
    const mapper = new RoomMapper();
    mapper.update({
      encA: 0,
      encB: 0,
      gyroHeadingDeg: 0,
      frontDistancePct: 80,
      corridors: [0.05, 0.05, 0.9, 0.95, 0.95],
      explicitPoseCm: { x: 0, y: 0, headingDeg: 0 },
    });
    expect(mapper.getFrontierBias()).toBeGreaterThan(0.2);
  });
});

describe("Phase 3 — Smooth Continuous IntelligentExplorer Navigation", () => {
  it("curves continuously forward around obstacles WITHOUT stopping unless genuinely blocked", () => {
    const mapper = new RoomMapper();
    const explorer = new IntelligentExplorer();

    // 1. Moderate obstacle ahead-left (centerClear=0.28, frontDistancePct=40, right wide open)
    //    MUST keep rolling forward in a smooth right curve — NOT stop-and-pivot!
    const curve = explorer.step({
      nowMs: 1000,
      mission: "explore-room",
      speedCap: 65,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 40,
      corridors: [0.2, 0.25, 0.28, 0.85, 0.95],
      bestSteer: 0.5,
      flowForward: 1.2,
      encA: 50,
      encB: 50,
      objects: [],
      mapper,
    });
    expect(curve.state).toBe("CRUISING");
    expect(curve.throttle).toBeGreaterThan(0.35);
    expect(curve.left).toBeGreaterThan(curve.right); // smoothly carving right!
    expect(curve.synthSfx).toBeUndefined(); // never interrupts drive coils while moving!

    // 2. Sudden bumper impact / inches from wall (frontDistancePct <= 18) -> enters AVOIDING and backs out
    const emergency = explorer.step({
      nowMs: 1100,
      mission: "explore-room",
      speedCap: 65,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 14,
      corridors: [0.1, 0.1, 0.08, 0.15, 0.2],
      bestSteer: 0.3,
      flowForward: 0.1,
      encA: 55,
      encB: 55,
      objects: [],
      mapper,
    });
    expect(emergency.state).toBe("AVOIDING");
    expect(emergency.throttle).toBeLessThan(0);

    // 3. Sustained visual + encoder snag (>= 2.1 s) -> enters UNSTICKING cleanly
    const stuckExp = new IntelligentExplorer();
    let res = stuckExp.step({
      nowMs: 0,
      mission: "explore-room",
      speedCap: 60,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 85,
      corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
      bestSteer: 0,
      flowForward: 0,
      encA: 10,
      encB: 10,
      objects: [],
      mapper,
    });
    for (let t = 150; t <= 2600; t += 150) {
      res = stuckExp.step({
        nowMs: t,
        mission: "explore-room",
        speedCap: 60,
        pickedUp: false,
        safeMode: false,
        bump: false,
        frontDistancePct: 85,
        corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
        bestSteer: 0,
        flowForward: 0,
        encA: 10,
        encB: 10,
        objects: [],
        mapper,
      });
      if (res.state === "UNSTICKING") break;
    }
    expect(res.state).toBe("UNSTICKING");
    expect(res.recoveries).toBe(1);
    expect(res.throttle).toBeLessThan(0);
  });

  it("logs discoveries on the fly WITHOUT stopping in explore-room, and stops on find-person completion", () => {
    const mapper = new RoomMapper();
    const explorer = new IntelligentExplorer();

    // In explore-room, spotting a chair logs it seamlessly while CONTINUING FORWARD!
    const onTheFly = explorer.step({
      nowMs: 1000,
      mission: "explore-room",
      speedCap: 60,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 80,
      corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
      bestSteer: 0,
      flowForward: 1.0,
      encA: 100,
      encB: 100,
      objects: [
        { id: "c1", label: "chair", score: 0.82, x: 0.4, y: 0.25, w: 0.2, h: 0.4, source: "ai" },
      ],
      mapper,
    });
    expect(onTheFly.state).toBe("CRUISING");
    expect(onTheFly.throttle).toBeGreaterThan(0.4);
    expect(onTheFly.discovery?.label).toBe("chair");
    expect(onTheFly.synthSfx).toBeUndefined();

    // In find-person mission, spotting a person completes the mission cleanly & halts with victory chime
    const expPerson = new IntelligentExplorer();
    const found = expPerson.step({
      nowMs: 5000,
      mission: "find-person",
      speedCap: 55,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 80,
      corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
      bestSteer: 0,
      flowForward: 1.0,
      encA: 100,
      encB: 100,
      objects: [
        { id: "p1", label: "person", score: 0.88, x: 0.4, y: 0.2, w: 0.2, h: 0.5, source: "ai" },
      ],
      mapper,
    });
    expect(found.state).toBe("MISSION_COMPLETE");
    expect(found.discovery?.label).toBe("person");
    expect(found.left).toBe(0);
    expect(found.right).toBe(0);
    expect(found.synthSfx).toBe(7);
  });
});
