// SPDX-License-Identifier: MIT
// Smooth Continuous Autonomous Vision Explorer for LEGO BOOST Tank/Car.
// Designed for fluid, car-like forward cruising with ZERO unnecessary stopping:
//   - Curves smoothly around obstacles using 5-sector camera floor clearance + early bumper avoidance
//   - Applies turn-direction hysteresis & exponential motor smoothing (no stop-start jitter!)
//   - Logs curious object discoveries ON THE FLY without halting forward motion
//   - Only reverses in a curved arc when genuinely dead-ended, bumped, or inches from impact
//   - Recovers automatically if snagged on a rug/cord (visual optical flow + encoder stall)

import { DetectedObjectBox, ExplorerMission } from "../rtc/roverBridge";
import { mixXboxToTank } from "../input/xboxController";
import { RoomMapper } from "./roomMap";

export type ExplorerFsmState =
  | "CRUISING"
  | "AVOIDING"
  | "UNSTICKING"
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
  /** Emitted on the fly when spotting an interesting object (no stopping!) */
  discovery?: { label: string; confidence: number };
  /** Optional expressive robot synth SFX preset ONLY when stopped (never interrupts rolling drive motors!) */
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
  private turnCommitDir: -1 | 0 | 1 = 0;
  private turnCommitUntilMs = 0;
  private deadEndAccumMs = 0;
  private stuckAccumMs = 0;
  private lastTickMs = 0;
  private lastEncSum: number | null = null;
  private recoveries = 0;
  private seenCooldowns = new Map<string, number>();
  private lastDiscoveryMs = -Infinity;
  private smoothedSteer = 0;
  private smoothedThrottle = 0.45;
  private hasStepped = false;

  reset(): void {
    this.state = "CRUISING";
    this.stateUntilMs = 0;
    this.avoidDir = 1;
    this.turnCommitDir = 0;
    this.turnCommitUntilMs = 0;
    this.deadEndAccumMs = 0;
    this.stuckAccumMs = 0;
    this.lastTickMs = 0;
    this.lastEncSum = null;
    this.recoveries = 0;
    this.seenCooldowns.clear();
    this.lastDiscoveryMs = -Infinity;
    this.smoothedSteer = 0;
    this.smoothedThrottle = 0.45;
    this.hasStepped = false;
  }

  getRecoveries(): number {
    return this.recoveries;
  }

  private smoothOutput(targetSteer: number, targetThrottle: number, fast = false): {
    steer: number;
    throttle: number;
  } {
    if (!this.hasStepped) {
      this.hasStepped = true;
      this.smoothedSteer = targetSteer;
      this.smoothedThrottle = targetThrottle;
    } else {
      const aSteer = fast ? 0.55 : 0.34;
      const aThrottle = fast ? 0.55 : 0.3;
      this.smoothedSteer += (targetSteer - this.smoothedSteer) * aSteer;
      this.smoothedThrottle += (targetThrottle - this.smoothedThrottle) * aThrottle;
    }
    return {
      steer: clamp(this.smoothedSteer, -0.92, 0.92),
      throttle: clamp(this.smoothedThrottle, -0.75, 0.85),
    };
  }

  private pickClearSide(
    leftClear: number,
    rightClear: number,
    frontier: number,
    nowMs: number
  ): -1 | 1 {
    // Respect recent turn direction commitment unless the opposite side is decisively clearer
    const commitBias =
      nowMs < this.turnCommitUntilMs && this.turnCommitDir !== 0 ? this.turnCommitDir * 0.14 : 0;
    const rightScore = rightClear + frontier * 0.2 + commitBias;
    const leftScore = leftClear - frontier * 0.2 - commitBias;
    const chosen: -1 | 1 = rightScore >= leftScore ? 1 : -1;
    this.turnCommitDir = chosen;
    this.turnCommitUntilMs = nowMs + 750;
    return chosen;
  }

  step(input: ExplorerTickInput): ExplorerTickOutput {
    const now = input.nowMs;
    const dtMs = this.lastTickMs > 0 ? clamp(now - this.lastTickMs, 20, 300) : 100;
    this.lastTickMs = now;

    // 1. Immediate hardware safety lockouts
    if (input.safeMode || input.pickedUp) {
      this.stuckAccumMs = 0;
      this.deadEndAccumMs = 0;
      this.hasStepped = false;
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

    const cap = clamp(input.speedCap, 25, 80);
    const leftClear = input.corridors[0] * 0.45 + input.corridors[1] * 0.55;
    const centerClear = input.corridors[2];
    const rightClear = input.corridors[4] * 0.45 + input.corridors[3] * 0.55;
    const maxSideClear = Math.max(leftClear, rightClear);
    const frontierBias = input.mapper.getFrontierBias();

    // 2. Check encoder delta & visual optical flow for snag/stuck detection while cruising forward
    const encSum = Math.abs(input.encA) + Math.abs(input.encB);
    const encDelta = this.lastEncSum !== null ? Math.abs(encSum - this.lastEncSum) : 10;
    this.lastEncSum = encSum;

    if (this.state === "CRUISING" || this.state === "RETURNING_HOME") {
      const visuallyStalled = Math.abs(input.flowForward) < 0.07 && encDelta < 3;
      if (visuallyStalled) {
        this.stuckAccumMs += dtMs;
      } else {
        this.stuckAccumMs = Math.max(0, this.stuckAccumMs - dtMs * 1.5);
      }

      if (this.stuckAccumMs >= 2100) {
        this.stuckAccumMs = 0;
        this.deadEndAccumMs = 0;
        this.recoveries += 1;
        this.avoidDir = this.pickClearSide(leftClear, rightClear, frontierBias, now);
        this.state = "UNSTICKING";
        this.stateUntilMs = now + 1200;
        this.smoothedSteer = -this.avoidDir * 0.35;
        this.smoothedThrottle = -0.62;
        const m = mixXboxToTank(this.smoothedSteer, this.smoothedThrottle, cap);
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: this.smoothedSteer,
          throttle: this.smoothedThrottle,
          statusNote: `Snag detected — smooth Unstick Recovery #${this.recoveries}`,
          recoveries: this.recoveries,
        };
      }
    }

    // 3. Handle active UNSTICKING maneuver (550 ms curved reverse -> 650 ms forward escape arc!)
    if (this.state === "UNSTICKING") {
      const rem = this.stateUntilMs - now;
      if (rem > 650) {
        const s = this.smoothOutput(-this.avoidDir * 0.38, -0.62, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote: `Unstick Recovery #${this.recoveries} — backing clear in an arc…`,
          recoveries: this.recoveries,
        };
      }
      if (rem > 0) {
        const s = this.smoothOutput(this.avoidDir * 0.68, 0.48, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote: `Unstick Recovery #${this.recoveries} — curving forward onto open floor…`,
          recoveries: this.recoveries,
        };
      }
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

    // 4. On-the-fly object discovery logging (NO STOPPING while exploring! Only stop when Find Person completes!)
    let discoveryOut: { label: string; confidence: number } | undefined;
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
        discoveryOut = { label: candidate.label, confidence: candidate.score };

        // Only halt for the dedicated "Find Person" mission when a person is found!
        if (input.mission === "find-person" && candidate.label === "person") {
          this.state = "MISSION_COMPLETE";
          return {
            state: "MISSION_COMPLETE",
            left: 0,
            right: 0,
            steer: 0,
            throttle: 0,
            statusNote: "Mission complete — found a person!",
            discovery: discoveryOut,
            synthSfx: 7,
            recoveries: this.recoveries,
          };
        }
      }
    }

    // 5. True emergency dead-end / impact check (debounced so noisy frames NEVER cause false stops!)
    const immediateImpact = input.bump || input.frontDistancePct <= 18;
    const allLanesDeadEnd = centerClear < 0.14 && maxSideClear < 0.24;
    if (allLanesDeadEnd) {
      this.deadEndAccumMs += dtMs;
    } else {
      this.deadEndAccumMs = Math.max(0, this.deadEndAccumMs - dtMs * 2);
    }

    const mustReverse = immediateImpact || this.deadEndAccumMs >= 320;
    if (mustReverse && this.state !== "AVOIDING") {
      this.state = "AVOIDING";
      this.deadEndAccumMs = 0;
      this.avoidDir = this.pickClearSide(leftClear, rightClear, frontierBias, now);
      this.stateUntilMs = now + 780;
    }

    if (this.state === "AVOIDING") {
      const rem = this.stateUntilMs - now;
      const stillTooClose = input.bump || input.frontDistancePct <= 24;
      // Phase A: brief smooth reverse-arc ONLY while inches from impact or in first 360ms of dead-end
      if (stillTooClose || rem > 420) {
        const s = this.smoothOutput(-this.avoidDir * 0.45, -0.56, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "AVOIDING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote: "Dead-end / bumper close — reversing smoothly in an arc",
          discovery: discoveryOut,
          recoveries: this.recoveries,
        };
      }
      // Phase B: immediately roll forward again while curving cleanly toward open floor!
      if (rem > 0 && centerClear < 0.35) {
        const s = this.smoothOutput(this.avoidDir * 0.65, 0.46, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "AVOIDING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote: `Carving ${this.avoidDir > 0 ? "right" : "left"} around obstacle`,
          discovery: discoveryOut,
          recoveries: this.recoveries,
        };
      }
      this.state = input.mission === "return-home" ? "RETURNING_HOME" : "CRUISING";
    }

    // 6. Return-to-Start Navigation (continuous obstacle-curving forward drive!)
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
      const homeSteer = clamp(home.turnErrorDeg / 50, -0.82, 0.82);
      const obstaclePull =
        centerClear < 0.5 || input.frontDistancePct <= 48
          ? this.pickClearSide(leftClear, rightClear, 0, now) * 0.55
          : 0;
      const targetSteer = clamp(homeSteer * 0.55 + input.bestSteer * 0.3 + obstaclePull * 0.45, -0.85, 0.85);
      // Keep moving forward continuously even while curving back toward home
      const targetThrottle = Math.abs(home.turnErrorDeg) > 95 ? 0.36 : clamp(0.45 + centerClear * 0.3, 0.42, 0.74);
      const s = this.smoothOutput(targetSteer, targetThrottle);
      const m = mixXboxToTank(s.steer, s.throttle, cap);
      return {
        state: "RETURNING_HOME",
        left: m.left,
        right: m.right,
        steer: s.steer,
        throttle: s.throttle,
        statusNote: `Returning home · ${(home.distCm / 100).toFixed(1)} m away`,
        recoveries: this.recoveries,
      };
    }

    // 7. Continuous Smooth Forward Cruising — curves gracefully around obstacles WITHOUT stopping!
    this.state = "CRUISING";

    // Early proportional avoidance repulsion when an obstacle appears ahead (before ever needing to stop!)
    const visionPressure = clamp((0.62 - centerClear) / 0.48, 0, 1);
    const bumperPressure =
      input.frontDistancePct <= 58 ? clamp((58 - input.frontDistancePct) / 38, 0, 1) : 0;
    const avoidPressure = Math.max(visionPressure, bumperPressure);

    let targetSteer = input.bestSteer * 0.65 + frontierBias * 0.25;
    if (avoidPressure > 0.12) {
      const clearDir = this.pickClearSide(leftClear, rightClear, frontierBias, now);
      // Smoothly increase curve strength as obstacle approaches while keeping forward motion fluid
      targetSteer = clamp(
        targetSteer * (1 - avoidPressure * 0.5) + clearDir * (0.35 + avoidPressure * 0.5),
        -0.84,
        0.84
      );
    } else {
      targetSteer = clamp(targetSteer, -0.72, 0.72);
    }

    // Continuous positive forward throttle floor (never stops dead while curving!)
    const targetThrottle = clamp(
      0.46 + centerClear * 0.32 - avoidPressure * 0.14,
      0.42,
      0.78
    );

    const s = this.smoothOutput(targetSteer, targetThrottle);
    const m = mixXboxToTank(s.steer, s.throttle, cap);

    const note = discoveryOut
      ? `Spotted ${discoveryOut.label} — logged on the fly!`
      : avoidPressure > 0.3
        ? `Curving ${s.steer >= 0 ? "right" : "left"} smoothly around obstacle`
        : input.mission === "find-person"
          ? "Cruising smoothly · Searching for a person…"
          : input.mission === "find-object"
            ? "Cruising smoothly · Logging landmarks on the fly…"
            : "Cruising open floor · Mapping room smoothly";

    return {
      state: "CRUISING",
      left: m.left,
      right: m.right,
      steer: s.steer,
      throttle: s.throttle,
      statusNote: note,
      discovery: discoveryOut,
      recoveries: this.recoveries,
    };
  }
}
