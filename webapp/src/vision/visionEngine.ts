// SPDX-License-Identifier: MIT
// Pure, zero-CDN computer vision helpers for Vernie OS Phase 5 Vision Backpack.
// Runs directly on downscaled RGBA ImageData frames (works 100% offline on Chromebooks).

export type VisionDetector = "motion" | "color-red" | "color-green" | "color-blue" | "color-yellow";
export type VisionTrackMode = "head-follow" | "body-follow" | "wave-react";

export interface VisionObservation {
  detected: boolean;
  /** Horizontal centroid in [-1, +1]: -1 = left of frame, +1 = right of frame. */
  centroidX: number;
  /** Vertical centroid in [-1, +1]: -1 = bottom of frame, +1 = top of frame. */
  centroidY: number;
  /** Fraction of active pixels in [0, 1]. */
  energy: number;
  /** True when strong upper-frame motion indicates a hand wave. */
  waveDetected: boolean;
}

export interface TrackingContext {
  headHomed: boolean;
  pickedUp: boolean;
  /** Chest 88007 proximity percentage (0..100, or 255 if unavailable). */
  distancePct: number;
  /** Current smoothed head angle in degrees. */
  currentHeadDeg: number;
  /** Max track speed cap in [20..70]. */
  maxSpeedPct: number;
  /** Monotonic timestamp in ms. */
  nowMs: number;
  /** Timestamp of previous wave reaction in ms. */
  lastWaveReactMs: number;
}

export interface TrackingAction {
  drive: { left: number; right: number; timeoutMs: number } | null;
  headDeg: number | null;
  synthSfx: number | null;
  hubLed: [number, number, number] | null;
  waveTriggered: boolean;
  statusNote: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Analyze luma frame difference between consecutive RGBA buffers of identical dimensions.
 */
export function analyzeMotionFrame(
  prevRgba: Uint8ClampedArray | null,
  currRgba: Uint8ClampedArray,
  width: number,
  height: number,
  mirrorX = true
): VisionObservation {
  const totalPixels = width * height;
  if (!prevRgba || totalPixels <= 0 || prevRgba.length < totalPixels * 4 || currRgba.length < totalPixels * 4) {
    return { detected: false, centroidX: 0, centroidY: 0, energy: 0, waveDetected: false };
  }

  let activeCount = 0;
  let weightSum = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const yPrev = (prevRgba[idx] * 77 + prevRgba[idx + 1] * 150 + prevRgba[idx + 2] * 29) >> 8;
      const yCurr = (currRgba[idx] * 77 + currRgba[idx + 1] * 150 + currRgba[idx + 2] * 29) >> 8;
      const diff = Math.abs(yCurr - yPrev);
      if (diff >= 24) {
        activeCount++;
        const w = diff - 23;
        const nx = ((x + 0.5) / width) * 2 - 1;
        const ny = 1 - ((y + 0.5) / height) * 2;
        sumX += (mirrorX ? -nx : nx) * w;
        sumY += ny * w;
        weightSum += w;
      }
    }
  }

  const energy = activeCount / totalPixels;
  if (energy < 0.025 || weightSum <= 0) {
    return { detected: false, centroidX: 0, centroidY: 0, energy, waveDetected: false };
  }

  const centroidX = clamp(sumX / weightSum, -1, 1);
  const centroidY = clamp(sumY / weightSum, -1, 1);
  const waveDetected = energy >= 0.12 && centroidY >= -0.05;

  return { detected: true, centroidX, centroidY, energy, waveDetected };
}

/**
 * Analyze a single RGBA frame for a bright primary-colored target (LEGO brick / ball).
 */
export function analyzeColorTarget(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  target: Exclude<VisionDetector, "motion">,
  mirrorX = true
): VisionObservation {
  const totalPixels = width * height;
  if (totalPixels <= 0 || rgba.length < totalPixels * 4) {
    return { detected: false, centroidX: 0, centroidY: 0, energy: 0, waveDetected: false };
  }

  let matchCount = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];

      let matched = false;
      if (target === "color-red") {
        matched = r >= 135 && r > g * 1.45 && r > b * 1.45;
      } else if (target === "color-green") {
        matched = g >= 120 && g > r * 1.3 && g > b * 1.3;
      } else if (target === "color-blue") {
        matched = b >= 120 && b > r * 1.35 && b > g * 1.2;
      } else {
        // color-yellow: high R and G, low B
        matched = r >= 145 && g >= 135 && b < 100 && Math.abs(r - g) < 55;
      }

      if (matched) {
        matchCount++;
        const nx = ((x + 0.5) / width) * 2 - 1;
        const ny = 1 - ((y + 0.5) / height) * 2;
        sumX += mirrorX ? -nx : nx;
        sumY += ny;
      }
    }
  }

  const energy = matchCount / totalPixels;
  if (energy < 0.015 || matchCount === 0) {
    return { detected: false, centroidX: 0, centroidY: 0, energy, waveDetected: false };
  }

  const centroidX = clamp(sumX / matchCount, -1, 1);
  const centroidY = clamp(sumY / matchCount, -1, 1);
  return {
    detected: true,
    centroidX,
    centroidY,
    energy,
    waveDetected: energy >= 0.16 && centroidY >= 0,
  };
}

/**
 * Translate a VisionObservation into safe Vernie OS BLE commands.
 * Strictly enforces:
 * - C2: never emits head angles when !headHomed.
 * - Pickup & obstacle safety: stops tracks when pickedUp or 88007 distance <= 35%.
 * - Never fires dart launcher (dart firing is strictly manual 2-step interlock).
 */
export function computeTrackingAction(
  mode: VisionTrackMode,
  obs: VisionObservation,
  ctx: TrackingContext
): TrackingAction {
  if (ctx.pickedUp) {
    return {
      drive: { left: 0, right: 0, timeoutMs: 200 },
      headDeg: null,
      synthSfx: null,
      hubLed: null,
      waveTriggered: false,
      statusNote: "Tracking paused: Vernie is picked up.",
    };
  }

  if (mode === "head-follow") {
    if (!ctx.headHomed) {
      return {
        drive: null,
        headDeg: null,
        synthSfx: null,
        hubLed: null,
        waveTriggered: false,
        statusNote: "Head Follow waiting: Home Head first to unlock safe angle control.",
      };
    }
    if (!obs.detected) {
      return {
        drive: null,
        headDeg: null,
        synthSfx: null,
        hubLed: null,
        waveTriggered: false,
        statusNote: "Scanning for target…",
      };
    }
    if (Math.abs(obs.centroidX) < 0.14) {
      return {
        drive: null,
        headDeg: null,
        synthSfx: null,
        hubLed: null,
        waveTriggered: false,
        statusNote: "Target centered.",
      };
    }
    const desired = clamp(Math.round(obs.centroidX * 35), -35, 35);
    const smoothed = clamp(
      Math.round(ctx.currentHeadDeg * 0.6 + desired * 0.4),
      -35,
      35
    );
    return {
      drive: null,
      headDeg: smoothed,
      synthSfx: null,
      hubLed: null,
      waveTriggered: false,
      statusNote: `Tracking head to ${smoothed}°`,
    };
  }

  if (mode === "body-follow") {
    if (!obs.detected) {
      return {
        drive: { left: 0, right: 0, timeoutMs: 200 },
        headDeg: null,
        synthSfx: null,
        hubLed: null,
        waveTriggered: false,
        statusNote: "No target in view — tracks stopped.",
      };
    }

    const obstacleClose = ctx.distancePct <= 35;
    const cap = clamp(ctx.maxSpeedPct, 20, 65);
    const turn = Math.abs(obs.centroidX) >= 0.18 ? Math.round(obs.centroidX * cap) : 0;
    const forward = !obstacleClose && obs.energy < 0.14 ? Math.round(cap * 0.65) : 0;

    if (turn === 0 && forward === 0) {
      return {
        drive: { left: 0, right: 0, timeoutMs: 200 },
        headDeg: null,
        synthSfx: null,
        hubLed: null,
        waveTriggered: false,
        statusNote: obstacleClose
          ? `Target close (88007 ${ctx.distancePct}%) — holding position.`
          : "Target centered & within comfortable distance.",
      };
    }

    const left = clamp(forward + turn, -cap, cap);
    const right = clamp(forward - turn, -cap, cap);
    return {
      drive: { left, right, timeoutMs: 350 },
      headDeg: null,
      synthSfx: null,
      hubLed: null,
      waveTriggered: false,
      statusNote: `Body Follow L:${left}% R:${right}%`,
    };
  }

  // mode === "wave-react"
  if (obs.waveDetected && ctx.nowMs - ctx.lastWaveReactMs >= 2500) {
    return {
      drive: null,
      headDeg: ctx.headHomed ? 20 : null,
      synthSfx: 2, // Happy Chirp
      hubLed: [16, 220, 96],
      waveTriggered: true,
      statusNote: "Wave detected! Greeting with Happy Chirp + Emerald LED.",
    };
  }

  return {
    drive: null,
    headDeg: null,
    synthSfx: null,
    hubLed: null,
    waveTriggered: false,
    statusNote: obs.detected ? "Motion seen (wave higher to greet)." : "Watching for a hand wave…",
  };
}
