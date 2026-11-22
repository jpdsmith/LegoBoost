// SPDX-License-Identifier: MIT
// Intelligent Driving ("Smart Co-Pilot" / ADAS) Controller for LEGO BOOST Tank/Car.
// Fuses driver intent (Xbox/WASD/touch) with:
//   1. Collision Guard (Auto-Brake or Smart Dodge via 88007 front sensor + 5-sector vision corridors)
//   2. Straight-Line Heading Hold (Phone Gyroscope yaw lock with Move Hub encoder fallback)
//   3. Tap-to-Follow Object Pursuit (AI or tapped HSV target at safe following distance)
//   4. Floor-Tape / Hallway Lane Assist

import { CollisionGuardLevel, DetectedObjectBox } from "../rtc/roverBridge";
import { mixXboxToTank } from "../input/xboxController";

export interface IntelligentDriveInput {
  /** Driver requested steer [-1..+1] and throttle [-1..+1] */
  rawSteer: number;
  rawThrottle: number;
  speedCap: number;

  /** Sensor & Vision inputs */
  frontDistancePct: number; // 0..100, or 255 if unavailable
  corridors: [number, number, number, number, number];
  pickedUp: boolean;
  safeMode: boolean;

  /** Heading feedback */
  headingDeg: number | null; // Phone gyroscope yaw or simulated heading
  encA: number;
  encB: number;

  /** Assist settings */
  collisionGuard: CollisionGuardLevel;
  headingHold: boolean;
  laneAssist: boolean;
  laneOffset: number | null;
  lockedTarget: DetectedObjectBox | null;
}

export interface IntelligentDriveOutput {
  left: number;
  right: number;
  effectiveSteer: number;
  effectiveThrottle: number;
  statusNote: string;
  intervening: "none" | "braking" | "dodging" | "heading" | "following" | "lane";
}

function wrapAngleDiff(targetDeg: number, currentDeg: number): number {
  let d = ((targetDeg - currentDeg + 540) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class IntelligentDriveController {
  private lockedHeadingDeg: number | null = null;
  private lockedEncDiff: number | null = null;

  reset(): void {
    this.lockedHeadingDeg = null;
    this.lockedEncDiff = null;
  }

  step(input: IntelligentDriveInput): IntelligentDriveOutput {
    if (input.safeMode) {
      this.reset();
      return {
        left: 0,
        right: 0,
        effectiveSteer: 0,
        effectiveThrottle: 0,
        statusNote: "Safety Mode active — drive locked.",
        intervening: "braking",
      };
    }

    let steer = clamp(input.rawSteer, -1, 1);
    let throttle = clamp(input.rawThrottle, -1, 1);
    const driverActive = Math.abs(steer) > 0.05 || Math.abs(throttle) > 0.05;
    let intervening: IntelligentDriveOutput["intervening"] = "none";
    let statusNote = "Smart Co-Pilot watching ahead";

    // 1. Tap-to-Follow Object Pursuit (active when target locked & driver is hands-off)
    if (!driverActive && input.lockedTarget) {
      if (input.pickedUp) {
        return {
          left: 0,
          right: 0,
          effectiveSteer: 0,
          effectiveThrottle: 0,
          statusNote: "Follow paused — tank picked up.",
          intervening: "braking",
        };
      }
      const box = input.lockedTarget;
      const cx = (box.x + box.w / 2) * 2 - 1; // [-1..+1]
      const area = box.w * box.h;
      const targetSteer = Math.abs(cx) > 0.1 ? clamp(cx * 1.15, -0.75, 0.75) : 0;
      const closeByBumper = input.frontDistancePct <= 36;
      const closeBySize = area >= 0.18 || box.w >= 0.42;
      const targetThrottle = !closeByBumper && !closeBySize ? 0.55 : 0;

      steer = targetSteer;
      throttle = targetThrottle;
      intervening = "following";
      statusNote =
        targetThrottle === 0 && targetSteer === 0
          ? `Locked on ${box.label} — holding safe distance`
          : `Following ${box.label}`;
    }

    // 2. Straight-Line Heading Hold (cancels left/right LEGO tread drift on carpet/tile)
    if (
      input.headingHold &&
      driverActive &&
      Math.abs(input.rawSteer) < 0.08 &&
      Math.abs(input.rawThrottle) > 0.15
    ) {
      if (input.headingDeg !== null) {
        if (this.lockedHeadingDeg === null) {
          this.lockedHeadingDeg = input.headingDeg;
        }
        const errDeg = wrapAngleDiff(this.lockedHeadingDeg, input.headingDeg);
        // Flip correction sign in reverse so heading stays locked backing up too
        const dirSign = input.rawThrottle >= 0 ? 1 : -1;
        const trim = clamp((errDeg / 35) * 0.24 * dirSign, -0.22, 0.22);
        if (Math.abs(errDeg) >= 2) {
          steer = clamp(steer + trim, -1, 1);
          intervening = "heading";
          statusNote = `Heading Hold locked (${Math.round(this.lockedHeadingDeg)}°)`;
        }
      } else {
        // Fallback: wheel encoder balance (encA - encB)
        const diff = input.encA - input.encB;
        if (this.lockedEncDiff === null) this.lockedEncDiff = diff;
        const drift = diff - this.lockedEncDiff;
        const trim = clamp((-drift / 80) * 0.2, -0.18, 0.18);
        if (Math.abs(drift) >= 8) {
          steer = clamp(steer + trim, -1, 1);
          intervening = "heading";
          statusNote = "Straight-Line Encoder Assist active";
        }
      }
    } else {
      this.lockedHeadingDeg = null;
      this.lockedEncDiff = null;
    }

    // 3. Floor-Tape / Hallway Lane Assist when driving forward
    if (
      input.laneAssist &&
      throttle > 0.12 &&
      Math.abs(input.rawSteer) < 0.25 &&
      input.laneOffset !== null
    ) {
      const laneTrim = clamp(input.laneOffset * 0.55, -0.45, 0.45);
      steer = clamp(steer + laneTrim, -1, 1);
      if (intervening === "none") {
        intervening = "lane";
        statusNote = "Lane Assist centering on path";
      }
    }

    // 4. Smart Collision Guard (ALWAYS permits reversing or spinning clear!)
    if (input.collisionGuard !== "off" && throttle > 0.02) {
      const bumperDist = input.frontDistancePct;
      const centerClear = Math.min(input.corridors[2], (input.corridors[1] + input.corridors[3]) / 2 + 0.15);
      const leftClear = (input.corridors[0] + input.corridors[1]) / 2;
      const rightClear = (input.corridors[3] + input.corridors[4]) / 2;

      const hardBlocked = bumperDist <= 28 || centerClear < 0.18;
      const cautionBlocked = bumperDist <= 50 || centerClear < 0.42;

      if (hardBlocked) {
        if (input.collisionGuard === "dodge" && Math.max(leftClear, rightClear) > 0.35) {
          const dodgeDir = rightClear >= leftClear ? 1 : -1;
          throttle = Math.min(throttle, 0.22);
          steer = clamp(steer * 0.3 + dodgeDir * 0.78, -1, 1);
          intervening = "dodging";
          statusNote = `Auto-Dodge steering ${dodgeDir > 0 ? "right" : "left"} around obstacle`;
        } else {
          throttle = 0;
          intervening = "braking";
          statusNote =
            bumperDist <= 28
              ? `Auto-Brake! Front bumper ${bumperDist}% (reverse to back out)`
              : "Auto-Brake! Obstacle directly ahead";
        }
      } else if (cautionBlocked) {
        const scale = clamp(Math.min((bumperDist - 24) / 30, centerClear / 0.45), 0.35, 0.85);
        throttle *= scale;
        if (input.collisionGuard === "dodge" && Math.abs(leftClear - rightClear) > 0.14) {
          const nudge = rightClear > leftClear ? 0.32 : -0.32;
          steer = clamp(steer + nudge, -1, 1);
          intervening = "dodging";
          statusNote = "Smart Dodge curving toward clearer floor";
        } else {
          intervening = "braking";
          statusNote = "Caution — slowing for obstacle ahead";
        }
      }
    }

    const mixed = mixXboxToTank(steer, throttle, input.speedCap);
    return {
      left: mixed.left,
      right: mixed.right,
      effectiveSteer: steer,
      effectiveThrottle: throttle,
      statusNote,
      intervening,
    };
  }
}
