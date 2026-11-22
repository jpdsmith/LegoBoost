// SPDX-License-Identifier: MIT
// Phase 3 Unit Tests: Live 2D RoomMapper & IntelligentExplorer Autonomous Brain.

import { describe, expect, it } from "vitest";
import { IntelligentExplorer } from "./rover/intelligentExplorer";
import { RoomMapper } from "./rover/roomMap";

describe("Phase 3 — 2D RoomMapper Odometry, Obstacles, Frontier & Return-Home", () => {
  it("integrates wheel encoder odometry, records obstacles, and guides Return Home", () => {
    const mapper = new RoomMapper();
    // Initial sample initializes encoder baseline
    mapper.update({
      encA: 0,
      encB: 0,
      gyroHeadingDeg: 0,
      frontDistancePct: 90,
      corridors: [0.9, 0.9, 0.9, 0.9, 0.9],
    });
    // Roll forward ~38 cm (1000 degrees on both wheels) heading North (0°)
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
      frontDistancePct: 25, // Hit obstacle in front
      corridors: [0.9, 0.9, 0.1, 0.9, 0.9],
    });

    const pose = mapper.getPoseCm();
    expect(pose.y).toBeGreaterThan(30);
    const snap = mapper.getSnapshot();
    expect(snap.visited.length).toBeGreaterThanOrEqual(2);
    expect(snap.obstacles.length).toBeGreaterThanOrEqual(1);
    expect(snap.distanceMeters).toBeGreaterThan(0.3);

    // Facing North (0°) while north of origin -> Return Home requires ~180° turn!
    const home = mapper.getReturnHomeGuidance();
    expect(home.arrived).toBe(false);
    expect(Math.abs(home.turnErrorDeg)).toBeGreaterThan(165);
  });

  it("biases frontier steering toward unexplored side when one side has obstacles", () => {
    const mapper = new RoomMapper();
    // Paint obstacles on the left (-26° / -13° sectors)
    mapper.update({
      encA: 0,
      encB: 0,
      gyroHeadingDeg: 0,
      frontDistancePct: 80,
      corridors: [0.05, 0.05, 0.9, 0.95, 0.95],
      explicitPoseCm: { x: 0, y: 0, headingDeg: 0 },
    });
    // Frontier bias should point positively (right) away from mapped left obstacles
    expect(mapper.getFrontierBias()).toBeGreaterThan(0.2);
  });
});

describe("Phase 3 — IntelligentExplorer Finite State Machine", () => {
  it("cruises toward open corridor, avoids close obstacles, and recovers from visual snag", () => {
    const mapper = new RoomMapper();
    const explorer = new IntelligentExplorer();

    // 1. Wide-open right corridor -> cruises forward curving right
    const cruise = explorer.step({
      nowMs: 1000,
      mission: "explore-room",
      speedCap: 60,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 90,
      corridors: [0.3, 0.4, 0.85, 0.95, 0.95],
      bestSteer: 0.45,
      flowForward: 1.4,
      encA: 50,
      encB: 50,
      objects: [],
      mapper,
    });
    expect(cruise.state).toBe("CRUISING");
    expect(cruise.left).toBeGreaterThan(cruise.right);

    // 2. Sudden close bumper obstacle -> switches to AVOIDING and reverses away first
    const avoid = explorer.step({
      nowMs: 1100,
      mission: "explore-room",
      speedCap: 60,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 20,
      corridors: [0.2, 0.2, 0.1, 0.8, 0.9],
      bestSteer: 0.6,
      flowForward: 0.1,
      encA: 55,
      encB: 55,
      objects: [],
      mapper,
    });
    expect(avoid.state).toBe("AVOIDING");
    expect(avoid.throttle).toBeLessThan(0);

    // 3. Fresh explorer encountering sustained visual + encoder stall -> enters UNSTICKING!
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
    for (let t = 150; t <= 2200; t += 150) {
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

  it("logs curious object discovery once per cooldown and completes find-person mission", () => {
    const mapper = new RoomMapper();
    const explorer = new IntelligentExplorer();

    const spot = explorer.step({
      nowMs: 1000,
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
    expect(spot.state).toBe("INSPECTING");
    expect(spot.discovery?.label).toBe("person");
    expect(spot.synthSfx).toBe(2);

    // After 1.4s inspection window, find-person finishes cleanly with victory chime!
    const done = explorer.step({
      nowMs: 2500,
      mission: "find-person",
      speedCap: 55,
      pickedUp: false,
      safeMode: false,
      bump: false,
      frontDistancePct: 80,
      corridors: [0.8, 0.8, 0.8, 0.8, 0.8],
      bestSteer: 0,
      flowForward: 0,
      encA: 100,
      encB: 100,
      objects: [],
      mapper,
    });
    expect(done.state).toBe("MISSION_COMPLETE");
    expect(done.left).toBe(0);
    expect(done.right).toBe(0);
    expect(done.synthSfx).toBe(7);
  });
});
