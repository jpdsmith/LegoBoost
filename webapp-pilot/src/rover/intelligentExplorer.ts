// SPDX-License-Identifier: MIT
// Smooth Continuous Autonomous Vision Explorer for LEGO BOOST Tank/Car (Optimized for Pixel Fold 90°).
// Designed for fluid, car-like forward cruising with ZERO unnecessary stopping:
//   - Curves smoothly around obstacles using 5-sector + asymmetric swept-bumper clearance
//     (compensating for left-offset Pixel Fold camera mounts!) + unobstructed 88007 front sensor
//   - Fuses low-reaching AI object detections (chairs, tables, people, pets) into obstacle corridors
//   - Applies turn-direction hysteresis & exponential motor smoothing (no stop-start jitter!)
//   - Logs curious object discoveries ON THE FLY without halting forward motion
//   - Detects BOTH motor-stall snags AND wheel-spin rug/cord snags (via optical flow confidence!)
//   - Uses an escalating 3-stage Unstick recovery playbook so tight traps never loop forever

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
  /** Optional clearance [0..1] across the asymmetric swept bumper path (for off-center camera mounts) */
  sweptClear?: number;
  bestSteer: number;
  flowForward: number;
  /** Optional horizontal optical flow turn rate */
  flowTurn?: number;
  /** Optional optical flow texture confidence [0..1] (allows detecting spinning treads on rugs!) */
  flowConfidence?: number;
  /** Optional fused phone gyro heading in degrees [0..360) for turn-progress snag detection */
  headingDeg?: number | null;
  /** Optional phone yaw rate in deg/s */
  yawRateDegS?: number;
  encA: number;
  encB: number;
  /** Optional measured Move Hub track speeds (-100..+100) */
  speedA?: number;
  speedB?: number;
  /** Optional Move Hub battery voltage in mV */
  batteryMv?: number;
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
  /** True when battery has dipped under 6.5 V continuously */
  lowBattery?: boolean;
  /** Reason if entering UNSTICKING on this tick */
  stuckReason?: "wheel-spin" | "motor-stall";
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

const OBSTACLE_AI_LABELS = new Set([
  "person",
  "dog",
  "cat",
  "chair",
  "couch",
  "dining table",
  "bed",
  "potted plant",
  "bench",
  "suitcase",
  "backpack",
  "tv",
  "refrigerator",
  "toilet",
  "bottle",
  "cup",
]);

const ENC_SATURATION_THRESHOLD = 32700;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function shortestAngleDeltaDeg(toDeg: number, fromDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export class IntelligentExplorer {
  private state: ExplorerFsmState = "CRUISING";
  private stateUntilMs = 0;
  private avoidReverseStartMs = 0;
  private avoidReverseUntilMs = 0;
  private avoidReverseMaxUntilMs = 0;
  private avoidTurnStartMs = 0;
  private avoidTurnStartHeadingDeg: number | null = null;
  private avoidDidReverse = false;
  private avoidInSpinPhase = false;
  private unstickReverseStartMs = 0;
  private unstickReverseUntilMs = 0;
  private unstickTurnStartMs = 0;
  private unstickTurnStartHeadingDeg: number | null = null;
  private unstickInSpinPhase = false;
  private unstickTier = 1;
  private avoidDir: -1 | 1 = 1;
  private turnCommitDir: -1 | 0 | 1 = 0;
  private turnCommitUntilMs = 0;
  private deadEndAccumMs = 0;
  private sweptBlockedAccumMs = 0;
  private bumpAccumMs = 0;
  private pickedUpAccumMs = 0;
  private stuckAccumMs = 0;
  private reverseStallAccumMs = 0;
  private rearBlockedUntilMs = 0;
  private lastReverseEndMs = -Infinity;
  private lastReverseHeadingDeg: number | null = null;
  private forwardClearAccumMs = 0;
  private lowBattAccumMs = 0;
  private lastTickMs = 0;
  private lastEncSum: number | null = null;
  private progressRefMs = 0;
  private progressRefHeadingDeg: number | null = null;
  private progressNetFlow = 0;
  private progressNetTurn = 0;
  private progressSteerSum = 0;
  private progressThrottleSum = 0;
  private progressTicks = 0;
  private progressConfidentTicks = 0;
  private recoveries = 0;
  private consecutiveRecoveries = 0;
  private lastRecoveryEndMs = -Infinity;
  private seenCooldowns = new Map<string, number>();
  private lastDiscoveryMs = -Infinity;
  private smoothedSteer = 0;
  private smoothedThrottle = 0.45;
  private hasStepped = false;

  reset(): void {
    this.state = "CRUISING";
    this.stateUntilMs = 0;
    this.avoidReverseStartMs = 0;
    this.avoidReverseUntilMs = 0;
    this.avoidReverseMaxUntilMs = 0;
    this.avoidTurnStartMs = 0;
    this.avoidTurnStartHeadingDeg = null;
    this.avoidDidReverse = false;
    this.avoidInSpinPhase = false;
    this.unstickReverseStartMs = 0;
    this.unstickReverseUntilMs = 0;
    this.unstickTurnStartMs = 0;
    this.unstickTurnStartHeadingDeg = null;
    this.unstickInSpinPhase = false;
    this.unstickTier = 1;
    this.avoidDir = 1;
    this.turnCommitDir = 0;
    this.turnCommitUntilMs = 0;
    this.deadEndAccumMs = 0;
    this.sweptBlockedAccumMs = 0;
    this.bumpAccumMs = 0;
    this.pickedUpAccumMs = 0;
    this.stuckAccumMs = 0;
    this.reverseStallAccumMs = 0;
    this.rearBlockedUntilMs = 0;
    this.lastReverseEndMs = -Infinity;
    this.lastReverseHeadingDeg = null;
    this.forwardClearAccumMs = 0;
    this.lowBattAccumMs = 0;
    this.lastTickMs = 0;
    this.lastEncSum = null;
    this.resetProgressWindow();
    this.recoveries = 0;
    this.consecutiveRecoveries = 0;
    this.lastRecoveryEndMs = -Infinity;
    this.seenCooldowns.clear();
    this.lastDiscoveryMs = -Infinity;
    this.smoothedSteer = 0;
    this.smoothedThrottle = 0.45;
    this.hasStepped = false;
  }

  private resetProgressWindow(): void {
    this.progressRefMs = 0;
    this.progressRefHeadingDeg = null;
    this.progressNetFlow = 0;
    this.progressNetTurn = 0;
    this.progressSteerSum = 0;
    this.progressThrottleSum = 0;
    this.progressTicks = 0;
    this.progressConfidentTicks = 0;
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
      const aSteer = fast ? 0.65 : 0.36;
      const aThrottle = fast ? 0.65 : 0.32;
      this.smoothedSteer += (targetSteer - this.smoothedSteer) * aSteer;
      this.smoothedThrottle += (targetThrottle - this.smoothedThrottle) * aThrottle;
    }
    return {
      steer: clamp(this.smoothedSteer, -0.95, 0.95),
      throttle: clamp(this.smoothedThrottle, -0.85, 0.85),
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

  /**
   * Fuse close-range AI object detections (e.g. chairs, couches, people, pets whose bottom edge
   * reaches into the lower third of the camera frame) into the 5-sector corridor clearances.
   */
  private applySemanticObstacles(
    corridors: [number, number, number, number, number],
    objects: DetectedObjectBox[]
  ): [number, number, number, number, number] {
    const out: [number, number, number, number, number] = [...corridors];
    for (const obj of objects) {
      if (obj.source !== "ai" || obj.score < 0.48 || !OBSTACLE_AI_LABELS.has(obj.label)) {
        continue;
      }
      const bottomY = obj.y + obj.h;
      if (bottomY < 0.66) continue;
      // Lower bottomY = closer to robot bumper -> stronger clearance cap
      const maxAllowedClr = clamp(1 - (bottomY - 0.58) / 0.34, 0.08, 0.55);
      const s0 = clamp(Math.floor(obj.x * 5), 0, 4);
      const s1 = clamp(Math.floor((obj.x + obj.w) * 5), 0, 4);
      for (let s = s0; s <= s1; s++) {
        if (maxAllowedClr < out[s]) {
          out[s] = Number(maxAllowedClr.toFixed(2));
        }
      }
    }
    return out;
  }

  step(input: ExplorerTickInput): ExplorerTickOutput {
    const now = input.nowMs;
    const dtMs = this.lastTickMs > 0 ? clamp(now - this.lastTickMs, 20, 300) : 100;
    this.lastTickMs = now;

    // Track sustained low battery (< 6.5 V for >= 3 s)
    if (typeof input.batteryMv === "number" && input.batteryMv > 0 && input.batteryMv < 6500) {
      this.lowBattAccumMs += dtMs;
    } else {
      this.lowBattAccumMs = Math.max(0, this.lowBattAccumMs - dtMs);
    }
    const lowBattery = this.lowBattAccumMs >= 3000;

    // 1. Hardware safety lockouts:
    //    - safeMode is ALWAYS instant (0 ms)!
    //    - pickedUp is debounced (>= 900 ms continuous) because plush carpet jolts carrying
    //      a 283 g Pixel Fold briefly trip the Move Hub's 300 ms IMU tilt latch!
    if (input.safeMode) {
      this.pickedUpAccumMs = 0;
      this.stuckAccumMs = 0;
      this.deadEndAccumMs = 0;
      this.sweptBlockedAccumMs = 0;
      this.resetProgressWindow();
      this.hasStepped = false;
      return {
        state: "PAUSED",
        left: 0,
        right: 0,
        steer: 0,
        throttle: 0,
        statusNote: "Explorer paused — Safety Mode active.",
        lowBattery,
        recoveries: this.recoveries,
      };
    }

    if (input.pickedUp) {
      this.pickedUpAccumMs += dtMs;
    } else {
      this.pickedUpAccumMs = Math.max(0, this.pickedUpAccumMs - dtMs * 2);
    }
    if (this.pickedUpAccumMs >= 900) {
      this.stuckAccumMs = 0;
      this.deadEndAccumMs = 0;
      this.sweptBlockedAccumMs = 0;
      this.resetProgressWindow();
      this.hasStepped = false;
      return {
        state: "PAUSED",
        left: 0,
        right: 0,
        steer: 0,
        throttle: 0,
        statusNote: "Explorer paused — set tank back on floor.",
        lowBattery,
        recoveries: this.recoveries,
      };
    }

    const cap = clamp(input.speedCap, 25, 80);
    const effCorridors = this.applySemanticObstacles(input.corridors, input.objects);
    const leftClear = effCorridors[0] * 0.45 + effCorridors[1] * 0.55;
    // Fuse asymmetric swept-bumper clearance so a left-offset Pixel Fold camera never clips its right corner!
    const sweptVal = input.sweptClear ?? effCorridors[2];
    const centerClear = Math.min(effCorridors[2], sweptVal);
    const rightClear = effCorridors[4] * 0.45 + effCorridors[3] * 0.55;
    const maxSideClear = Math.max(leftClear, rightClear);
    const frontierBias = input.mapper.getFrontierBias();

    const hasSpeedTelem = typeof input.speedA === "number" && typeof input.speedB === "number";
    const hasConfidentFlow =
      typeof input.flowConfidence === "number" && input.flowConfidence >= 0.4;
    const hasHeading = typeof input.headingDeg === "number" && Number.isFinite(input.headingDeg);

    // Track clean forward progress to clear reverse cooldown after rolling away
    if (
      this.state === "CRUISING" &&
      this.smoothedThrottle > 0.25 &&
      centerClear >= 0.4 &&
      input.frontDistancePct >= 55
    ) {
      this.forwardClearAccumMs += dtMs;
    } else if (this.state !== "CRUISING") {
      this.forwardClearAccumMs = 0;
    }

    // Reset recovery escalation streak after 7 s of clean forward driving
    if (this.state === "CRUISING" && now - this.lastRecoveryEndMs > 7000) {
      this.consecutiveRecoveries = 0;
    }

    // 2. Multi-modal snag detection while cruising:
    //    (a) Motor-stall snag: wheels physically jammed (low encoder delta / zero measured speed)
    //    (b) Wheel-spin snag: treads spinning on rug/cord while textured optical flow stays ~0
    //    (c) Net-progress rocking snag: robot rocks ±1° in place against a doorframe with zero
    //        net forward flow AND zero net gyro heading change over 1.5 s!
    const encSum = Math.abs(input.encA) + Math.abs(input.encB);
    const encSaturated =
      Math.abs(input.encA) >= ENC_SATURATION_THRESHOLD ||
      Math.abs(input.encB) >= ENC_SATURATION_THRESHOLD;
    const encDelta = this.lastEncSum !== null ? Math.abs(encSum - this.lastEncSum) : 10;
    this.lastEncSum = encSum;

    if (this.state === "CRUISING" || this.state === "RETURNING_HOME") {
      const speedSum = hasSpeedTelem ? Math.abs(input.speedA!) + Math.abs(input.speedB!) : null;
      const motorStalled =
        speedSum !== null ? speedSum < 6 : !encSaturated && encDelta < 3;

      const flowStill =
        Math.abs(input.flowForward) < 0.08 && Math.abs(input.flowTurn ?? 0) < 0.14;

      // Wheel-spin snag: textured camera scene is completely stationary even while treads spin!
      const wheelSpinSnag = hasConfidentFlow && flowStill;
      // Legacy/combined stall: either confirmed motor stall with low flow, or legacy (no confidence provided)
      const legacyStall =
        typeof input.flowConfidence !== "number" &&
        Math.abs(input.flowForward) < 0.07 &&
        motorStalled;
      const motorJamSnag = motorStalled && (flowStill || !hasConfidentFlow);

      let stuckReason: "wheel-spin" | "motor-stall" | undefined;
      if (wheelSpinSnag || motorJamSnag || legacyStall) {
        this.stuckAccumMs += dtMs;
        stuckReason = motorStalled ? "motor-stall" : "wheel-spin";
      } else {
        this.stuckAccumMs = Math.max(0, this.stuckAccumMs - dtMs * 1.5);
      }

      // Net-progress sliding window (immune to ±0.3 flow / ±15 deg/s rocking vibration in place!)
      let netProgressStuck = false;
      if (this.progressRefMs === 0) {
        this.progressRefMs = now;
        this.progressRefHeadingDeg = hasHeading ? input.headingDeg! : null;
        this.progressNetFlow = 0;
        this.progressNetTurn = 0;
        this.progressSteerSum = 0;
        this.progressThrottleSum = 0;
        this.progressTicks = 0;
        this.progressConfidentTicks = 0;
      } else {
        const dtSec = dtMs / 1000;
        this.progressNetFlow += input.flowForward * dtSec;
        this.progressNetTurn += (input.flowTurn ?? 0) * dtSec;
        this.progressSteerSum += Math.abs(this.smoothedSteer);
        this.progressThrottleSum += Math.abs(this.smoothedThrottle);
        this.progressTicks += 1;
        if (hasConfidentFlow) this.progressConfidentTicks += 1;

        const windowMs = now - this.progressRefMs;
        if (windowMs >= 1500 && this.progressTicks >= 6) {
          const avgSteer = this.progressSteerSum / this.progressTicks;
          const avgThrottle = this.progressThrottleSum / this.progressTicks;
          const mostlyConfidentFlow = this.progressConfidentTicks >= this.progressTicks * 0.5;
          const netHeadingDeg =
            hasHeading && this.progressRefHeadingDeg !== null
              ? Math.abs(shortestAngleDeltaDeg(input.headingDeg!, this.progressRefHeadingDeg))
              : null;

          const turnPinned =
            avgSteer >= 0.3 &&
            netHeadingDeg !== null &&
            netHeadingDeg < 10 &&
            this.progressNetFlow < 0.42;
          const forwardPinned =
            mostlyConfidentFlow &&
            avgThrottle >= 0.25 &&
            this.progressNetFlow < 0.32 &&
            (netHeadingDeg !== null ? netHeadingDeg < 12 : Math.abs(this.progressNetTurn) < 0.45);

          if (turnPinned || forwardPinned) {
            netProgressStuck = true;
            stuckReason = motorStalled ? "motor-stall" : "wheel-spin";
          } else {
            // Genuine forward or turning progress made -> advance anchor window
            this.progressRefMs = now;
            this.progressRefHeadingDeg = hasHeading ? input.headingDeg! : null;
            this.progressNetFlow = 0;
            this.progressNetTurn = 0;
            this.progressSteerSum = 0;
            this.progressThrottleSum = 0;
            this.progressTicks = 0;
            this.progressConfidentTicks = 0;
          }
        }
      }

      const stuckTriggerMs = stuckReason === "motor-stall" && hasSpeedTelem ? 1650 : 2100;
      if (this.stuckAccumMs >= stuckTriggerMs || netProgressStuck) {
        this.stuckAccumMs = 0;
        this.deadEndAccumMs = 0;
        this.sweptBlockedAccumMs = 0;
        this.reverseStallAccumMs = 0;
        this.resetProgressWindow();
        this.recoveries += 1;
        this.consecutiveRecoveries += 1;
        this.unstickTier = clamp(this.consecutiveRecoveries, 1, 3);

        // Escalation tier 2+ intentionally flips turn direction to escape traps/corners
        const preferred = this.pickClearSide(leftClear, rightClear, frontierBias, now);
        this.avoidDir = this.unstickTier >= 2 ? ((-this.avoidDir) as -1 | 1) : preferred;

        const canReverseUnstick = now >= this.rearBlockedUntilMs;
        const revMs = canReverseUnstick
          ? this.unstickTier === 1
            ? 520
            : this.unstickTier === 2
              ? 640
              : 740
          : 0;
        const turnMs = this.unstickTier === 1 ? 1150 : this.unstickTier === 2 ? 1350 : 1550;
        this.unstickReverseStartMs = now;
        this.unstickReverseUntilMs = now + revMs;
        this.unstickInSpinPhase = !canReverseUnstick;
        this.unstickTurnStartMs = now;
        this.unstickTurnStartHeadingDeg = hasHeading ? input.headingDeg! : null;
        this.stateUntilMs = now + revMs + turnMs;
        this.state = "UNSTICKING";

        if (canReverseUnstick) {
          // Instant snap to traction-friendly curved dual-wheel reverse (zero forward carryover!)
          this.smoothedSteer = -this.avoidDir * 0.18;
          this.smoothedThrottle = this.unstickTier >= 2 ? -0.76 : -0.72;
        } else {
          // Rear recently blocked -> skip straight to forward rolling escape arc!
          this.smoothedSteer = this.avoidDir * 0.52;
          this.smoothedThrottle = 0.44;
        }
        this.hasStepped = true;
        const m = mixXboxToTank(this.smoothedSteer, this.smoothedThrottle, cap);
        const reasonTag = stuckReason === "wheel-spin" ? "Rug/wheel-spin" : "Motor stall";
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: this.smoothedSteer,
          throttle: this.smoothedThrottle,
          statusNote: `${reasonTag} detected — Unstick #${this.recoveries} (Tier ${this.unstickTier})`,
          lowBattery,
          stuckReason,
          recoveries: this.recoveries,
        };
      }
    }

    // 3. Handle active UNSTICKING maneuver (rear-safe short reverse -> gyro-guided low-slip escape turn!)
    if (this.state === "UNSTICKING") {
      if (now < this.unstickReverseUntilMs) {
        const revElapsed = now - this.unstickReverseStartMs;
        // Rear obstacle protection during UNSTICKING reverse: NEVER keep pushing backward into a wall!
        const rearBumpHit = revElapsed >= 160 && input.bump;
        const rearWheelStalled =
          revElapsed >= 280 &&
          ((hasSpeedTelem && (Math.abs(input.speedA!) < 6 || Math.abs(input.speedB!) < 6)) ||
            (hasConfidentFlow && Math.abs(input.flowForward) < 0.08));
        if (rearWheelStalled) {
          this.reverseStallAccumMs += dtMs;
        } else {
          this.reverseStallAccumMs = 0;
        }
        if (rearBumpHit || this.reverseStallAccumMs >= 300) {
          this.rearBlockedUntilMs = now + 4500;
          this.unstickReverseUntilMs = now;
          this.reverseStallAccumMs = 0;
        } else {
          const s = this.smoothOutput(
            -this.avoidDir * 0.18,
            this.unstickTier >= 2 ? -0.76 : -0.72,
            true
          );
          const m = mixXboxToTank(s.steer, s.throttle, cap);
          return {
            state: "UNSTICKING",
            left: m.left,
            right: m.right,
            steer: s.steer,
            throttle: s.throttle,
            statusNote: `Unstick #${this.recoveries} (Tier ${this.unstickTier}) — backing clear…`,
            lowBattery,
            recoveries: this.recoveries,
          };
        }
      }
      if (!this.unstickInSpinPhase) {
        this.unstickInSpinPhase = true;
        this.unstickTurnStartMs = now;
        this.unstickTurnStartHeadingDeg = hasHeading ? input.headingDeg! : null;
        this.lastReverseEndMs = now;
        this.lastReverseHeadingDeg = hasHeading ? input.headingDeg! : null;
        this.stateUntilMs = Math.max(this.stateUntilMs, now + 1150);
      }
      const uTurnElapsed = now - this.unstickTurnStartMs;
      const uTurnedDeg =
        hasHeading && this.unstickTurnStartHeadingDeg !== null
          ? Math.abs(shortestAngleDeltaDeg(input.headingDeg!, this.unstickTurnStartHeadingDeg))
          : null;
      const uDoneEarly =
        uTurnElapsed >= 900 &&
        uTurnedDeg !== null &&
        uTurnedDeg >= 40 &&
        centerClear >= 0.35 &&
        input.frontDistancePct >= 50;

      if (now < this.stateUntilMs && !uDoneEarly) {
        // Low-slip carpet escape: use a rolling forward arc when front is open (>= 62%),
        // or moderate-torque counter-rotation when tight so wheels keep carpet grip!
        const useRollingArc = input.frontDistancePct >= 62;
        const escSteer = useRollingArc
          ? this.avoidDir * 0.42
          : this.avoidDir * (this.unstickTier === 3 ? 0.84 : 0.78);
        const escThrottle = useRollingArc ? 0.44 : 0.04;
        const s = this.smoothOutput(escSteer, escThrottle, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "UNSTICKING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote: useRollingArc
            ? `Unstick #${this.recoveries} (Tier ${this.unstickTier}) — arcing onto open carpet…`
            : `Unstick #${this.recoveries} (Tier ${this.unstickTier}) — pivoting clear…`,
          lowBattery,
          recoveries: this.recoveries,
        };
      }
      this.lastRecoveryEndMs = now;
      this.resetProgressWindow();
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
          lowBattery,
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
            lowBattery,
            recoveries: this.recoveries,
          };
        }
      }
    }

    // 5. Rear-safe obstacle avoidance & gyro-guided low-slip carpet turning:
    //    - Filter single 300 ms Move Hub carpet-jolt IMU bumps when rolling briskly across open floor
    //    - NEVER reverse blindly when front 88007 has plenty of room (>= 65%) or during reverse cooldown
    //    - IMMEDIATELY abort reverse on any rear bump or rear wheel stall (Vernie has no rear sensor!)
    if (input.bump) {
      this.bumpAccumMs += dtMs;
    } else {
      this.bumpAccumMs = 0;
    }
    const treadsMovingBriskly =
      hasSpeedTelem && Math.abs(input.speedA!) + Math.abs(input.speedB!) >= 45;
    const confirmedBump =
      input.bump &&
      (input.frontDistancePct <= 45 ||
        centerClear < 0.25 ||
        (!treadsMovingBriskly && Math.abs(input.flowForward) < 0.25) ||
        this.bumpAccumMs >= 550);

    const immediateImpact = confirmedBump || input.frontDistancePct <= 26;
    const sweptBlocked = sweptVal < 0.18 || (input.frontDistancePct <= 30 && centerClear < 0.35);
    if (sweptBlocked) {
      this.sweptBlockedAccumMs += dtMs;
    } else {
      this.sweptBlockedAccumMs = Math.max(0, this.sweptBlockedAccumMs - dtMs * 2);
    }

    const allLanesDeadEnd = centerClear < 0.16 && maxSideClear < 0.28;
    if (allLanesDeadEnd) {
      this.deadEndAccumMs += dtMs;
    } else {
      this.deadEndAccumMs = Math.max(0, this.deadEndAccumMs - dtMs * 2);
    }

    const mustAvoid =
      immediateImpact || this.sweptBlockedAccumMs >= 220 || this.deadEndAccumMs >= 260;
    if (mustAvoid && this.state !== "AVOIDING") {
      this.state = "AVOIDING";
      this.deadEndAccumMs = 0;
      this.sweptBlockedAccumMs = 0;
      this.reverseStallAccumMs = 0;
      this.resetProgressWindow();
      this.avoidDir = this.pickClearSide(leftClear, rightClear, frontierBias, now);

      // Decide whether reversing is truly necessary AND safe (prevent backing into unseen rear walls!):
      // Only reverse when genuinely close in front (<= 45% or forward bump or close dead-end)
      // AND not inside rear-blocked lockout / back-to-back reverse cooldown.
      const needsReverse =
        input.frontDistancePct <= 45 ||
        (confirmedBump && this.smoothedThrottle > 0.1) ||
        (allLanesDeadEnd && input.frontDistancePct <= 60);
      const turnedSinceLastRev =
        hasHeading &&
        this.lastReverseHeadingDeg !== null &&
        Math.abs(shortestAngleDeltaDeg(input.headingDeg!, this.lastReverseHeadingDeg)) >= 25;
      const rearAllowed =
        now >= this.rearBlockedUntilMs &&
        (now - this.lastReverseEndMs >= 3000 ||
          turnedSinceLastRev ||
          this.forwardClearAccumMs >= 1500);

      if (needsReverse && rearAllowed) {
        this.avoidDidReverse = true;
        this.avoidReverseStartMs = now;
        this.avoidReverseUntilMs = now + 520;
        this.avoidReverseMaxUntilMs = now + 680;
        this.avoidInSpinPhase = false;
        this.stateUntilMs = now + 2600;

        // Instant snap to traction-friendly curved dual-tread reverse (NO forward EMA carryover!)
        this.smoothedSteer = -this.avoidDir * 0.18;
        this.smoothedThrottle = -0.72;
        this.hasStepped = true;
      } else {
        // Plenty of space ahead (or rear recently blocked/reversed) -> skip straight to Turn Phase!
        this.avoidDidReverse = false;
        this.avoidReverseStartMs = now;
        this.avoidReverseUntilMs = now;
        this.avoidReverseMaxUntilMs = now;
        this.avoidInSpinPhase = false;
        this.stateUntilMs = now + 2200;
      }
    }

    if (this.state === "AVOIDING") {
      const revElapsed = now - this.avoidReverseStartMs;
      // NEVER let bump or distant vision extend reverse! Only allow up to 680 ms if front sensor <= 24%.
      const stillTouchFront = input.frontDistancePct <= 24;
      let inReversePhase =
        this.avoidDidReverse &&
        (now < this.avoidReverseUntilMs ||
          (stillTouchFront && now < this.avoidReverseMaxUntilMs));

      if (inReversePhase) {
        // Rear-wall bump or rear wheel stall detector -> IMMEDIATELY abort reverse!
        const rearBumpHit = revElapsed >= 160 && input.bump;
        const rearWheelStalled =
          revElapsed >= 280 &&
          ((hasSpeedTelem && (Math.abs(input.speedA!) < 6 || Math.abs(input.speedB!) < 6)) ||
            (hasConfidentFlow && Math.abs(input.flowForward) < 0.08));
        if (rearWheelStalled) {
          this.reverseStallAccumMs += dtMs;
        } else {
          this.reverseStallAccumMs = 0;
        }

        if (rearBumpHit || this.reverseStallAccumMs >= 300) {
          this.rearBlockedUntilMs = now + 4500;
          this.avoidReverseUntilMs = now;
          this.avoidReverseMaxUntilMs = now;
          this.reverseStallAccumMs = 0;
          inReversePhase = false;
        }
      }

      if (inReversePhase) {
        const s = this.smoothOutput(-this.avoidDir * 0.18, -0.72, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "AVOIDING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote:
            input.frontDistancePct <= 34
              ? `Front sensor ${input.frontDistancePct}% — short curved reverse clear`
              : "Obstacle close — short curved reverse clear",
          discovery: discoveryOut,
          lowBattery,
          recoveries: this.recoveries,
        };
      }

      // Phase B: Gyro-guided low-slip carpet turn (holds long enough for Move Hub's ~600 ms motor ramp!)
      if (!this.avoidInSpinPhase) {
        this.avoidInSpinPhase = true;
        this.avoidTurnStartMs = now;
        this.avoidTurnStartHeadingDeg = hasHeading ? input.headingDeg! : null;
        this.stateUntilMs = now + 2200;
        if (this.avoidDidReverse) {
          this.lastReverseEndMs = now;
          this.lastReverseHeadingDeg = hasHeading ? input.headingDeg! : null;
        }
        const initRolling = input.frontDistancePct >= 62;
        this.smoothedSteer = this.avoidDir * (initRolling ? 0.38 : 0.78);
        this.smoothedThrottle = initRolling ? 0.46 : 0.04;
        this.hasStepped = true;
      }

      const turnElapsed = now - this.avoidTurnStartMs;
      const turnedDeg =
        hasHeading && this.avoidTurnStartHeadingDeg !== null
          ? Math.abs(shortestAngleDeltaDeg(input.headingDeg!, this.avoidTurnStartHeadingDeg))
          : null;
      const pathClearlyOpen = centerClear >= 0.48 && input.frontDistancePct >= 55;
      const gyroTurnDone =
        turnedDeg !== null &&
        turnedDeg >= 36 &&
        centerClear >= 0.28 &&
        input.frontDistancePct >= 45;
      const turnFinished =
        now >= this.stateUntilMs ||
        (turnElapsed >= 950 && pathClearlyOpen) ||
        (turnElapsed >= 850 && gyroTurnDone);

      if (!turnFinished) {
        // Detect carpet wheel slippage mid-turn: if heading moved < 8° after 1.05 s,
        // switch from stationary counter-rotate to a rolling carpet-grip forward arc!
        const slippingInPlace = turnElapsed >= 1050 && turnedDeg !== null && turnedDeg < 8;
        const useRollingTurn =
          input.frontDistancePct >= 62 || (slippingInPlace && input.frontDistancePct >= 42);

        const spinSteer = useRollingTurn ? this.avoidDir * 0.38 : this.avoidDir * 0.78;
        const spinThrottle = useRollingTurn ? 0.46 : 0.04;
        const s = this.smoothOutput(spinSteer, spinThrottle, true);
        const m = mixXboxToTank(s.steer, s.throttle, cap);
        return {
          state: "AVOIDING",
          left: m.left,
          right: m.right,
          steer: s.steer,
          throttle: s.throttle,
          statusNote: useRollingTurn
            ? `Rolling ${this.avoidDir > 0 ? "right" : "left"} arc for carpet grip`
            : `Pivoting ${this.avoidDir > 0 ? "right" : "left"} clear (${turnedDeg !== null ? `${Math.round(turnedDeg)}°` : "…"})`,
          discovery: discoveryOut,
          lowBattery,
          recoveries: this.recoveries,
        };
      }
      this.resetProgressWindow();
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
          lowBattery,
          recoveries: this.recoveries,
        };
      }
      const homeSteer = clamp(home.turnErrorDeg / 50, -0.78, 0.78);
      const obstaclePull =
        centerClear < 0.5 || input.frontDistancePct <= 50
          ? this.pickClearSide(leftClear, rightClear, 0, now) * 0.52
          : 0;
      const targetSteer = clamp(
        homeSteer * 0.55 + input.bestSteer * 0.3 + obstaclePull * 0.45,
        -0.8,
        0.8
      );
      const targetThrottle =
        Math.abs(home.turnErrorDeg) > 95
          ? 0.24
          : clamp(0.45 + centerClear * 0.3, 0.4, 0.74);
      const s = this.smoothOutput(targetSteer, targetThrottle);
      const m = mixXboxToTank(s.steer, s.throttle, cap);
      return {
        state: "RETURNING_HOME",
        left: m.left,
        right: m.right,
        steer: s.steer,
        throttle: s.throttle,
        statusNote: `Returning home · ${(home.distCm / 100).toFixed(1)} m away`,
        lowBattery,
        recoveries: this.recoveries,
      };
    }

    // 7. Continuous Smooth Forward Cruising — favors rolling traction curves on carpet
    //    so wheels grip instead of slipping in place; only counter-rotates when tightly blocked!
    this.state = "CRUISING";

    const visionPressure = clamp((0.64 - centerClear) / 0.48, 0, 1);
    const bumperPressure =
      input.frontDistancePct <= 60 ? clamp((60 - input.frontDistancePct) / 36, 0, 1) : 0;
    const avoidPressure = Math.max(visionPressure, bumperPressure);
    const tightPivot =
      input.frontDistancePct <= 34 || (centerClear < 0.22 && input.frontDistancePct <= 50);

    let targetSteer = input.bestSteer * 0.62 + frontierBias * 0.22;
    if (tightPivot) {
      const clearDir = this.pickClearSide(leftClear, rightClear, frontierBias, now);
      targetSteer = clearDir * 0.78;
    } else if (avoidPressure > 0.12) {
      const clearDir = this.pickClearSide(leftClear, rightClear, frontierBias, now);
      // Cap rolling-curve steer to ±0.58 so both wheels stay gripping forward on carpet!
      targetSteer = clamp(
        targetSteer * (1 - avoidPressure * 0.45) + clearDir * (0.3 + avoidPressure * 0.36),
        -0.58,
        0.58
      );
    } else {
      targetSteer = clamp(targetSteer, -0.52, 0.52);
    }

    // Keep smooth forward traction velocity in open/moderate aisles; moderate-torque pivot only when tight
    const targetThrottle = tightPivot
      ? 0.06
      : clamp(0.48 + centerClear * 0.28 - avoidPressure * 0.14, 0.38, 0.76);

    const s = this.smoothOutput(targetSteer, targetThrottle, tightPivot);
    const m = mixXboxToTank(s.steer, s.throttle, cap);

    const baseNote = discoveryOut
      ? `Spotted ${discoveryOut.label} — logged on the fly!`
      : tightPivot
        ? `Low-slip pivot ${s.steer >= 0 ? "right" : "left"} away from tight obstacle`
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
      statusNote: lowBattery ? `Low battery (<6.5V) · ${baseNote}` : baseNote,
      discovery: discoveryOut,
      lowBattery,
      recoveries: this.recoveries,
    };
  }
}
