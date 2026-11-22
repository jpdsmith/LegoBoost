// SPDX-License-Identifier: MIT
// Autonomous Vision Explorer Brain ("Mars Rover Explorer") for LEGO BOOST Tank/Car.
// Combines:
//   - 5-sector camera free-floor clearance steering (avoids obstacles meters ahead!)
//   - 2D occupancy grid frontier curiosity bias (explores new areas of the room)
//   - Optical-flow + wheel-encoder stuck detection & automatic unstick recovery
//   - Curious object discovery pauses (snaps Discovery Log thumbnails & chirps)
//   - Mission objectives: Explore Room, Find Person, Find Objects, Return to Start

import { DetectedObjectBox, ExplorerMission } from "../rtc/roverBridge";
import { mixXboxToTank } from "../input/xboxController";
import { RoomMapper } from "./roomMap";

export type ExplorerFsmState =
  | "CRUISING"
  | "AVOIDING"
  | "UNSTICKING"
  | "INSPECTING"
  | "RETURNING_HOME"
  | "MISSION_COMPLETE"
  | "PAUSED";

export interface ExplorerTickInput {
  nowMs: number;
  mission: ExplorerMission;
  speedCap: number;
  pickedUp: boolean;
  safeMode: boolean;
  bump: boolean;
  frontDistancePct: number;
  corridors: [number, number, number, number, number];
  bestSteer: number;
  flowForward: number;
  encA: number;
  encB: number;
  objects: DetectedObjectBox[];
  mapper: RoomMapper;
}

export interface ExplorerTickOutput {
  state: ExplorerFsmState;
  left: number;
  right: number;
  steer: number;
  throttle: number;
  statusNote: string;
  /** Emitted once when pausing to log a new discovery */
  discovery?: { label: string; confidence: number };
  /** Optional expressive robot synth SFX preset (e.g. 2=Happy Chirp, 3=Curious Beep, 7=Victory) */
  synthSfx?: number;
  recoveries: number;
}

const INTERESTING_LABELS = new Set([
  "person",
  "dog",
  "cat",
  "sports ball",
  "backpack",
  "potted plant",
  "chair",
  "cup",
  "bottle",
  "teddy bear",
]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class IntelligentExplorer {
  private state: ExplorerFsmState = "CRUISING";
  private stateUntilMs = 0;
  private avoidDir: -1 | 1 = 1;
  private stuckAccumMs = 0;
  private lastTickMs = 0;
  private lastEncSum: number | null = null;
  private recoveries = 0;
  private seenCooldowns = new Map<string, number>();
  private lastDiscoveryMs = -Infinity;
  private inspectingLabel: string | null = null;

  reset(): void {
    this.state = "CRUISING";
    this.stateUntilMs = 0;
    this.avoidDir = 1;
    this.stuckAccumMs = 0;
    this.lastTickMs = 0;
    this.lastEncSum = null;
    this.recoveries = 0;
    this.seenCooldowns.clear();
    this.lastDiscoveryMs = -Infinity;
    this.inspectingLabel = null;
  }

  getRecoveries(): number {
    return this.recoveries;
  }

  step(input: ExplorerTickInput): ExplorerTickOutput {
    const now = input.nowMs;
    const dtMs = this.lastTickMs > 0 ? clamp(now - this.lastTickMs, 20, 300) : 100;
    this.lastTickMs = now;

    // 1. Immediate hardware safety lockouts
    if (input.safeMode || input.pickedUp) {
      this.stuckAccumMs = 0;
      return {
        state: "PAUSED",
        left: 0,
        right: 0,
        steer: 0,
        throttle: 0,
        statusNote: input.safeMode
          ? "Explorer paused — Safety Mode active."
          : "Explorer paused — set tank back on floor.",
        recoveries: this.recoveries,
      };
    }

    const cap = clamp(input.speedCap, 25, 75); // Smooth autonomous speed cap
    const leftClear = (input.corridors[0] + input.corridors[1]) / 2;
    const centerClear = input.corridors[2];
    const rightClear = (input.corridors[3] + input.corridors[4]) / 2;

    // 2. Check encoder delta & visual optical flow for snag/stuck detection while cruising forward
    const encSum = Math.abs(input.encA) + Math.abs(input.encB);
    const encDelta = this.lastEncSum !== null ? Math.abs(encSum - this.lastEncSum) : 10;
    this.lastEncSum = encSum;

    if (this.state === "CRUISING" || this.state === "RETURNING_HOME") {
      const visuallyStalled = Math.abs(input.flowForward) < 0.08 && encDelta < 3;
      if (visuallyStalled) {
        this.stuckAccumMs += dtMs;
      } else {
        this.stuckAccumMs = Math.max(0, this.stuckAccumMs - dtMs * 1.5);
      }

      if (this.stuckAccumMs >= 1600) {
        this.stuckAccumMs = 0;
        this.recoveries += 1;
        this.avoidDir = rightClear >= leftClear ? 1 : -1;
        this.state = "UNSTICKING";
        this.stateUntilMs = now + 1500;
        return {
          state: "UNSTICKING",
          left: -Math.round(cap * 0.7),
          right: -Math.round(cap * 0.7),
          steer: 0,
          throttle: -0.7,
          statusNote: `Rug/obstacle snag detected — running Unstick Recovery #${this.recoveries}`,
          synthSfx: 3,
          recoveries: this.recoveries,
        };
      }
    }

    // 3. Handle active UNSTICKING maneuver (reverse 650 ms, then pivot 850 ms)
    if (this.state === "UNSTICKING") {
      const rem = this.stateUntilMs - now;
      if (rem > 850) {
        const m = mixXboxToTank(0, -0.7, cap);
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: 0,
          throttle: -0.7,
          statusNote: `Unstick Recovery #${this.recoveries} — backing clear…`,
          recoveries: this.recoveries,
        };
      }
      if (rem > 0) {
        const m = mixXboxToTank(this.avoidDir * 0.85, 0, cap);
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: this.avoidDir * 0.85,
          throttle: 0,
          statusNote: `Unstick Recovery #${this.recoveries} — pivoting toward open floor…`,
          recoveries: this.recoveries,
        };
      }
      this.state = input.mission === "return-home" ? "RETURNING_HOME" : "CRUISING";
    }

    // 4. Handle INSPECTING discovery pause
    if (this.state === "INSPECTING") {
      if (now < this.stateUntilMs) {
        return {
          state: "INSPECTING",
          left: 0,
          right: 0,
          steer: 0,
          throttle: 0,
          statusNote: `Inspecting discovery: ${this.inspectingLabel ?? "object"}!`,
          recoveries: this.recoveries,
        };
      }
      if (input.mission === "find-person" && this.inspectingLabel === "person") {
        this.state = "MISSION_COMPLETE";
        return {
          state: "MISSION_COMPLETE",
          left: 0,
          right: 0,
          steer: 0,
          throttle: 0,
          statusNote: "Mission complete — found a person!",
          synthSfx: 7,
          recoveries: this.recoveries,
        };
      }
      this.inspectingLabel = null;
      this.state = input.mission === "return-home" ? "RETURNING_HOME" : "CRUISING";
    }

    if (this.state === "MISSION_COMPLETE") {
      if (input.mission === "explore-room" || input.mission === "find-object") {
        this.state = "CRUISING";
      } else {
        return {
          state: "MISSION_COMPLETE",
          left: 0,
          right: 0,
          steer: 0,
          throttle: 0,
          statusNote:
            input.mission === "return-home"
              ? "Arrived back near start!"
              : "Mission complete!",
          recoveries: this.recoveries,
        };
      }
    }

    // 5. Check for well-framed new object discoveries (outside return-home, spaced by >= 2.8 s)
    if (
      input.mission !== "return-home" &&
      this.state === "CRUISING" &&
      now - this.lastDiscoveryMs > 2800
    ) {
      const candidate = input.objects.find((obj) => {
        if (obj.score < 0.56) return false;
        if (input.mission === "find-person" && obj.label !== "person") return false;
        if (!INTERESTING_LABELS.has(obj.label) && input.mission !== "find-object") return false;
        const cx = obj.x + obj.w / 2;
        if (input.mission !== "find-person" && (cx < 0.14 || cx > 0.86 || obj.w < 0.06)) {
          return false;
        }
        const lastSeen = this.seenCooldowns.get(obj.label) ?? -Infinity;
        return now - lastSeen > 18000;
      });
      if (candidate) {
        this.seenCooldowns.set(candidate.label, now);
        this.lastDiscoveryMs = now;
        this.inspectingLabel = candidate.label;
        this.state = "INSPECTING";
        this.stateUntilMs = now + 1300;
        return {
          state: "INSPECTING",
          left: 0,
          right: 0,
          steer: 0,
          throttle: 0,
          statusNote: `Spotted ${candidate.label}! Logging discovery…`,
          discovery: { label: candidate.label, confidence: candidate.score },
          synthSfx: candidate.label === "person" ? 2 : 3,
          recoveries: this.recoveries,
        };
      }
    }

    // 6. Proactive obstacle avoidance (bump, bumper <= 34%, or center floor clearance < 0.30)
    const obstacleNow = input.bump || input.frontDistancePct <= 34 || centerClear < 0.3;
    if (obstacleNow && this.state !== "AVOIDING") {
      this.state = "AVOIDING";
      this.stateUntilMs = now + 900;
      const frontier = input.mapper.getFrontierBias();
      const rightScore = rightClear + frontier * 0.25;
      const leftScore = leftClear - frontier * 0.25;
      this.avoidDir = rightScore >= leftScore ? 1 : -1;
    }

    if (this.state === "AVOIDING") {
      const tooClose = input.frontDistancePct <= 24 || input.bump;
      if (tooClose) {
        const m = mixXboxToTank(-this.avoidDir * 0.2, -0.65, cap);
        return {
          state: "AVOIDING",
          left: m.left,
          right: m.right,
          steer: -this.avoidDir * 0.2,
          throttle: -0.65,
          statusNote: "Too close — backing away before turning",
          recoveries: this.recoveries,
        };
      }
      if (now < this.stateUntilMs || centerClear < 0.5) {
        const m = mixXboxToTank(this.avoidDir * 0.8, 0, cap);
        return {
          state: "AVOIDING",
          left: m.left,
          right: m.right,
          steer: this.avoidDir * 0.8,
          throttle: 0,
          statusNote: `Steering ${this.avoidDir > 0 ? "right" : "left"} toward open corridor`,
          recoveries: this.recoveries,
        };
      }
      this.state = input.mission === "return-home" ? "RETURNING_HOME" : "CRUISING";
    }

    // 7. Return-to-Start Navigation (obstacle-aware!)
    if (input.mission === "return-home") {
      this.state = "RETURNING_HOME";
      const home = input.mapper.getReturnHomeGuidance();
      if (home.arrived) {
        this.state = "MISSION_COMPLETE";
        return {
          state: "MISSION_COMPLETE",
          left: 0,
          right: 0,
          steer: 0,
          throttle: 0,
          statusNote: "Arrived back near starting point!",
          synthSfx: 7,
          recoveries: this.recoveries,
        };
      }
      const homeSteer = clamp(home.turnErrorDeg / 50, -0.85, 0.85);
      const blendedSteer = clamp(homeSteer * 0.65 + input.bestSteer * 0.35, -0.9, 0.9);
      const throttle = Math.abs(home.turnErrorDeg) > 65 ? 0.15 : 0.65;
      const m = mixXboxToTank(blendedSteer, throttle, cap);
      return {
        state: "RETURNING_HOME",
        left: m.left,
        right: m.right,
        steer: blendedSteer,
        throttle,
        statusNote: `Returning home · ${(home.distCm / 100).toFixed(1)} m away`,
        recoveries: this.recoveries,
      };
    }

    // 8. Normal Curious Cruising: blend 5-sector vision clearance (68%) + unexplored frontier (32%)
    this.state = "CRUISING";
    const frontierBias = input.mapper.getFrontierBias();
    const cruiseSteer = clamp(input.bestSteer * 0.68 + frontierBias * 0.32, -0.78, 0.78);
    const cruiseThrottle = clamp(0.45 + centerClear * 0.35, 0.42, 0.78);
    const m = mixXboxToTank(cruiseSteer, cruiseThrottle, cap);

    return {
      state: "CRUISING",
      left: m.left,
      right: m.right,
      steer: cruiseSteer,
      throttle: cruiseThrottle,
      statusNote:
        input.mission === "find-person"
          ? "Exploring room · Searching for a person…"
          : input.mission === "find-object"
            ? "Exploring room · Hunting for interesting objects…"
            : "Exploring open floor · Mapping new room areas",
      recoveries: this.recoveries,
    };
  }
}
