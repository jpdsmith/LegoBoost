// SPDX-License-Identifier: MIT
// Gimbal-Lock-Free Ground-Plane Yaw Heading Tracker for Half-Folded 90° Pixel Fold & Android Mounts.
//
// Why this exists:
//   Reading raw `DeviceOrientationEvent.alpha` suffers severe gimbal lock when an Android phone is
//   mounted vertically (beta ≈ 80-90°) and magnetometer distortion from LEGO Move Hub DC motors.
//   Instead:
//     1. Primary mode ("gyro-gravity"): low-pass filters `accelerationIncludingGravity` to obtain
//        the upward unit normal û, then integrates clockwise ground-plane yaw rate `-(ω · û)`.
//        Immune to gimbal lock, immune to motor magnets, and works in ANY phone posture (flat,
//        90° upright, tilted, or half-folded landscape/portrait)!
//     2. Fallback mode ("orient-matrix"): projects the rear-camera forward vector (0, 0, -1)
//        through the full W3C Z-X'-Y'' rotation matrix onto the horizontal East-North plane
//        (falling back to top-of-screen vector when nearly flat).

export type HeadingSource = "gyro-gravity" | "orient-matrix" | "none";

export interface FoldHeadingSnapshot {
  headingDeg: number | null;
  yawRateDegS: number;
  source: HeadingSource;
  /** Estimated phone screen tilt from horizontal (0° = flat, 90° = vertical upright) */
  mountPitchDeg: number | null;
  /** Side roll angle in degrees */
  mountRollDeg: number | null;
  rawAlpha: number | null;
  rawBeta: number | null;
  rawGamma: number | null;
}

export interface MotionSampleInput {
  nowMs: number;
  /** Acceleration including gravity (m/s^2) in device frame */
  ax?: number | null;
  ay?: number | null;
  az?: number | null;
  /** Rotation rate (deg/s) around device X (beta), Y (gamma), Z (alpha) */
  rotBeta?: number | null;
  rotGamma?: number | null;
  rotAlpha?: number | null;
  /** Optional browser-supplied interval in ms */
  intervalMs?: number | null;
}

export interface OrientationSampleInput {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
}

function normHeading(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/**
 * Project device rear-camera forward vector (or screen-top vector when flat) onto Earth East-North
 * plane using the W3C DeviceOrientation Z-X'-Y'' intrinsic Euler rotation matrix.
 * Returns clockwise compass heading [0..360), continuous through beta = 90° (vertical mount).
 */
export function computeMatrixHeadingDeg(alphaDeg: number, betaDeg: number, gammaDeg: number): number {
  const degToRad = Math.PI / 180;
  const a = alphaDeg * degToRad;
  const b = betaDeg * degToRad;
  const g = gammaDeg * degToRad;

  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cg = Math.cos(g);
  const sg = Math.sin(g);

  // Rear camera looks along device -Z -> Earth forward = -R * [0, 0, 1]^T
  const fEast = -(ca * sg + sa * sb * cg);
  const fNorth = -(sa * sg - ca * sb * cg);
  const horizMag = Math.hypot(fEast, fNorth);

  if (horizMag >= 0.28) {
    return normHeading((Math.atan2(fEast, fNorth) * 180) / Math.PI);
  }

  // Phone is nearly flat horizontally -> project top-of-screen +Y vector (column 2 of R)
  const tEast = -sa * cb;
  const tNorth = ca * cb;
  return normHeading((Math.atan2(tEast, tNorth) * 180) / Math.PI);
}

export class FoldHeadingTracker {
  private headingDeg: number | null = null;
  private yawRateDegS = 0;
  private source: HeadingSource = "none";

  // Low-pass filtered gravity normal in device frame (m/s^2)
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private hasGravity = false;

  // Online stationary gyro bias estimator along gravity normal (deg/s)
  private yawBiasDegS = 0;
  private lastMotionMs: number | null = null;

  private mountPitchDeg: number | null = null;
  private mountRollDeg: number | null = null;
  private rawAlpha: number | null = null;
  private rawBeta: number | null = null;
  private rawGamma: number | null = null;

  reset(initialHeadingDeg = 0): void {
    this.headingDeg = normHeading(initialHeadingDeg);
    this.yawRateDegS = 0;
    this.lastMotionMs = null;
  }

  clearAll(): void {
    this.headingDeg = null;
    this.yawRateDegS = 0;
    this.source = "none";
    this.hasGravity = false;
    this.yawBiasDegS = 0;
    this.lastMotionMs = null;
    this.mountPitchDeg = null;
    this.mountRollDeg = null;
    this.rawAlpha = null;
    this.rawBeta = null;
    this.rawGamma = null;
  }

  /**
   * Process a `DeviceMotionEvent` sample (preferred on Pixel Fold — zero gimbal lock, zero motor-magnet drift).
   */
  ingestMotion(sample: MotionSampleInput): FoldHeadingSnapshot {
    const { ax, ay, az, rotBeta, rotGamma, rotAlpha } = sample;

    if (
      typeof ax === "number" &&
      typeof ay === "number" &&
      typeof az === "number" &&
      Number.isFinite(ax) &&
      Number.isFinite(ay) &&
      Number.isFinite(az)
    ) {
      const mag = Math.hypot(ax, ay, az);
      if (mag > 4.0 && mag < 20.0) {
        if (!this.hasGravity) {
          this.gx = ax;
          this.gy = ay;
          this.gz = az;
          this.hasGravity = true;
        } else {
          // Smooth gravity vector so wheel bumps don't wobble the projection axis
          const alpha = 0.08;
          this.gx += (ax - this.gx) * alpha;
          this.gy += (ay - this.gy) * alpha;
          this.gz += (az - this.gz) * alpha;
        }
        const gMag = Math.hypot(this.gx, this.gy, this.gz);
        if (gMag > 1e-3) {
          // Pitch from flat horizontal: 0° = flat on back, 90° = standing vertical
          const horiz = Math.hypot(this.gx, this.gy);
          this.mountPitchDeg = Math.round((Math.atan2(horiz, Math.abs(this.gz)) * 180) / Math.PI);
          this.mountRollDeg = Math.round((Math.atan2(this.gx, Math.max(0.1, Math.abs(this.gy) + Math.abs(this.gz))) * 180) / Math.PI);
        }
      }
    }

    const hasGyro =
      typeof rotBeta === "number" &&
      typeof rotGamma === "number" &&
      typeof rotAlpha === "number" &&
      Number.isFinite(rotBeta) &&
      Number.isFinite(rotGamma) &&
      Number.isFinite(rotAlpha);

    if (hasGyro && this.hasGravity) {
      const gMag = Math.hypot(this.gx, this.gy, this.gz);
      if (gMag > 2.0) {
        const ux = this.gx / gMag;
        const uy = this.gy / gMag;
        const uz = this.gz / gMag;

        // Clockwise ground-plane yaw rate: -(ω · û), where ω = [rotBeta (X), rotGamma (Y), rotAlpha (Z)]
        const rawYawCw = -(rotBeta * ux + rotGamma * uy + rotAlpha * uz);

        // Gently adapt zero-rate bias while stationary
        if (Math.abs(rawYawCw - this.yawBiasDegS) < 1.6) {
          this.yawBiasDegS += (rawYawCw - this.yawBiasDegS) * 0.02;
        }

        const correctedYaw = rawYawCw - this.yawBiasDegS;
        const deadbandedYaw = Math.abs(correctedYaw) < 0.75 ? 0 : correctedYaw;
        this.yawRateDegS = Number(deadbandedYaw.toFixed(2));

        let dtSec = 0;
        if (this.lastMotionMs !== null) {
          const dtMs = sample.nowMs - this.lastMotionMs;
          if (dtMs > 0 && dtMs < 250) {
            dtSec = dtMs / 1000;
          }
        } else if (typeof sample.intervalMs === "number" && sample.intervalMs > 0 && sample.intervalMs < 150) {
          dtSec = sample.intervalMs / 1000;
        }
        this.lastMotionMs = sample.nowMs;

        if (this.headingDeg === null) {
          this.headingDeg = 0;
        } else if (dtSec > 0 && deadbandedYaw !== 0) {
          this.headingDeg = normHeading(this.headingDeg + deadbandedYaw * dtSec);
        }
        this.source = "gyro-gravity";
      }
    }

    return this.getSnapshot();
  }

  /**
   * Process a `DeviceOrientationEvent` sample.
   * Used as automatic fallback when `DeviceMotionEvent.rotationRate` is unavailable, and always
   * records raw `(alpha, beta, gamma)` for Flight Recorder mount diagnostics.
   */
  ingestOrientation(sample: OrientationSampleInput): FoldHeadingSnapshot {
    const { alpha, beta, gamma } = sample;
    if (typeof alpha === "number" && Number.isFinite(alpha)) this.rawAlpha = Math.round(alpha);
    if (typeof beta === "number" && Number.isFinite(beta)) this.rawBeta = Math.round(beta);
    if (typeof gamma === "number" && Number.isFinite(gamma)) this.rawGamma = Math.round(gamma);

    if (
      this.source !== "gyro-gravity" &&
      typeof alpha === "number" &&
      typeof beta === "number" &&
      typeof gamma === "number" &&
      Number.isFinite(alpha) &&
      Number.isFinite(beta) &&
      Number.isFinite(gamma)
    ) {
      this.headingDeg = Math.round(computeMatrixHeadingDeg(alpha, beta, gamma));
      this.mountPitchDeg = Math.round(Math.abs(beta));
      this.mountRollDeg = Math.round(gamma);
      this.source = "orient-matrix";
    }

    return this.getSnapshot();
  }

  getSnapshot(): FoldHeadingSnapshot {
    return {
      headingDeg: this.headingDeg !== null ? Math.round(this.headingDeg) % 360 : null,
      yawRateDegS: this.yawRateDegS,
      source: this.source,
      mountPitchDeg: this.mountPitchDeg,
      mountRollDeg: this.mountRollDeg,
      rawAlpha: this.rawAlpha,
      rawBeta: this.rawBeta,
      rawGamma: this.rawGamma,
    };
  }
}
