// SPDX-License-Identifier: MIT
// Zero-Dependency Real-Time Rover Vision Engine (runs at 10-15 Hz on any Android phone or Demo Canvas):
//   1. Adaptive 5-Sector Free-Floor Corridor Analyzer (learns floor HSV + Sobel edge barriers)
//   2. Block-Matching Optical Flow & Visual Stuck Estimator
//   3. Tap-to-Lock Adaptive HSV Target Tracker
//   4. Floor-Tape / Hallway Lane Offset Detector

import { DetectedObjectBox } from "../rtc/roverBridge";

export interface HsvColor {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

export interface HsvLockModel {
  id: string;
  label: string;
  target: HsvColor;
  hueTol: number;
  satMin: number;
  valMin: number;
}

export interface FloorCorridorResult {
  corridors: [number, number, number, number, number];
  bestSteer: number;
  /** Y coordinate (normalized 0..1) of deepest open floor point per corridor for HUD polygon */
  horizonYs: [number, number, number, number, number];
}

export interface OpticalFlowResult {
  flowForward: number;
  flowTurn: number;
  luma: Uint8Array;
}

export function rgbToHsv(r: number, g: number, b: number): HsvColor {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d > 1e-5) {
    if (max === rf) h = 60 * (((gf - bf) / d) % 6);
    else if (max === gf) h = 60 * ((bf - rf) / d + 2);
    else h = 60 * ((rf - gf) / d + 4);
    if (h < 0) h += 360;
  }
  const s = max > 1e-5 ? d / max : 0;
  return { h, s, v: max };
}

function hueDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Convert RGBA buffer into a compact 1-byte grayscale luminance buffer.
 */
export function extractLuma(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

/**
 * Adaptive 5-Sector Free-Floor Corridor Analyzer.
 * Learns floor color from the immediate foreground patch right in front of the tank bumper,
 * then scans upward across 5 horizontal sectors combining color deviation and horizontal edge barriers.
 */
export function analyzeFloorCorridors(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): FloorCorridorResult {
  if (width < 10 || height < 10 || rgba.length < width * height * 4) {
    return {
      corridors: [0.5, 0.5, 0.5, 0.5, 0.5],
      bestSteer: 0,
      horizonYs: [0.65, 0.65, 0.65, 0.65, 0.65],
    };
  }

  // 1. Sample immediate foreground floor patch (bottom-center bumper zone)
  const yStart = Math.floor(height * 0.84);
  const yEnd = Math.floor(height * 0.96);
  const xStart = Math.floor(width * 0.34);
  const xEnd = Math.floor(width * 0.66);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * width + x) * 4;
      sumR += rgba[idx];
      sumG += rgba[idx + 1];
      sumB += rgba[idx + 2];
      count++;
    }
  }
  const floorR = count > 0 ? sumR / count : 140;
  const floorG = count > 0 ? sumG / count : 130;
  const floorB = count > 0 ? sumB / count : 115;
  const floorHsv = rgbToHsv(floorR, floorG, floorB);

  // Measure foreground texture variance so patterned carpets/rugs don't trigger false obstacles
  let varSum = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * width + x) * 4;
      const dr = Math.abs(rgba[idx] - floorR);
      const dg = Math.abs(rgba[idx + 1] - floorG);
      const db = Math.abs(rgba[idx + 2] - floorB);
      varSum += (dr + dg + db) / 3;
    }
  }
  const floorNoise = count > 0 ? varSum / count : 12;
  const colorDistThresh = clamp(32 + floorNoise * 1.8, 34, 72);
  const edgeThresh = clamp(28 + floorNoise * 1.4, 28, 62);

  // 2. Scan upward from yBottom (0.90h) to yHorizon (0.44h) in 5 horizontal sectors
  const yBottom = Math.floor(height * 0.9);
  const yHorizon = Math.floor(height * 0.44);
  const scanRows = Math.max(1, yBottom - yHorizon);

  const corridors: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const horizonYs: [number, number, number, number, number] = [0.9, 0.9, 0.9, 0.9, 0.9];

  for (let s = 0; s < 5; s++) {
    const sx0 = Math.floor((s / 5) * width) + 1;
    const sx1 = Math.floor(((s + 1) / 5) * width) - 1;
    const cols = Math.max(1, sx1 - sx0);

    let freeRows = 0;
    let consecutiveBlocked = 0;

    for (let y = yBottom; y >= yHorizon; y--) {
      let blockedCols = 0;
      for (let x = sx0; x < sx1; x += 2) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];

        // Color deviation from learned floor patch (tolerant to mild brightness gradient)
        const rgbDiff = (Math.abs(r - floorR) + Math.abs(g - floorG) + Math.abs(b - floorB)) / 3;
        const pxHsv = rgbToHsv(r, g, b);
        const hueBarrier =
          pxHsv.s > 0.28 && floorHsv.s > 0.12 && hueDiffDeg(pxHsv.h, floorHsv.h) > 36;
        const satBarrier = Math.abs(pxHsv.s - floorHsv.s) > 0.34;

        // Vertical gradient (horizontal edge like baseboard / chair leg / obstacle bottom)
        const aboveIdx = (Math.max(0, y - 1) * width + x) * 4;
        const lCurr = (r * 77 + g * 150 + b * 29) >> 8;
        const lAbove =
          (rgba[aboveIdx] * 77 + rgba[aboveIdx + 1] * 150 + rgba[aboveIdx + 2] * 29) >> 8;
        const edgeHit = Math.abs(lCurr - lAbove) > edgeThresh;

        if (rgbDiff > colorDistThresh || hueBarrier || satBarrier || edgeHit) {
          blockedCols += 2;
        }
      }

      if (blockedCols / cols > 0.42) {
        consecutiveBlocked++;
        if (consecutiveBlocked >= 2) break;
      } else {
        consecutiveBlocked = 0;
        freeRows = yBottom - y + 1;
      }
    }

    const clearance = clamp(freeRows / scanRows, 0, 1);
    corridors[s] = Number(clearance.toFixed(2));
    horizonYs[s] = Number(((yBottom - freeRows) / height).toFixed(3));
  }

  // Weighted steering score toward widest/deepest open floor corridor
  const weights = [-1.0, -0.5, 0.0, 0.5, 1.0];
  let wSum = 0;
  let total = 0;
  for (let s = 0; s < 5; s++) {
    const score = corridors[s] * corridors[s];
    wSum += weights[s] * score;
    total += score;
  }
  const bestSteer = total > 0.05 ? clamp((wSum / total) * 1.4, -1, 1) : 0;

  return { corridors, bestSteer, horizonYs };
}

/**
 * Fast block-matching optical flow between consecutive grayscale frames.
 * Used to detect real visual movement vs. rug/wheel-spin snagging!
 */
export function computeOpticalFlow(
  prevLuma: Uint8Array | null,
  currRgba: Uint8ClampedArray,
  width: number,
  height: number
): OpticalFlowResult {
  const luma = extractLuma(currRgba, width, height);
  if (!prevLuma || prevLuma.length !== luma.length || width < 24 || height < 18) {
    return { flowForward: 0, flowTurn: 0, luma };
  }

  const patchW = 8;
  const patchH = 6;
  const search = 3;
  const samplePoints = [
    { x: Math.floor(width * 0.2), y: Math.floor(height * 0.65), side: -1 },
    { x: Math.floor(width * 0.5), y: Math.floor(height * 0.68), side: 0 },
    { x: Math.floor(width * 0.8), y: Math.floor(height * 0.65), side: 1 },
    { x: Math.floor(width * 0.25), y: Math.floor(height * 0.48), side: -1 },
    { x: Math.floor(width * 0.75), y: Math.floor(height * 0.48), side: 1 },
  ];

  let sumForward = 0;
  let sumTurn = 0;
  let valid = 0;

  for (const pt of samplePoints) {
    const x0 = clamp(pt.x - Math.floor(patchW / 2), search, width - patchW - search - 1);
    const y0 = clamp(pt.y - Math.floor(patchH / 2), search, height - patchH - search - 1);

    // Check local texture contrast so flat untextured patches don't produce noisy matches
    let minV = 255;
    let maxV = 0;
    for (let dy = 0; dy < patchH; dy += 2) {
      for (let dx = 0; dx < patchW; dx += 2) {
        const v = prevLuma[(y0 + dy) * width + (x0 + dx)];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    if (maxV - minV < 10) continue;

    let bestSad = Infinity;
    let bestDx = 0;
    let bestDy = 0;
    for (let sy = -search; sy <= search; sy++) {
      for (let sx = -search; sx <= search; sx++) {
        let sad = 0;
        for (let dy = 0; dy < patchH; dy += 2) {
          const prevRow = (y0 + dy) * width + x0;
          const currRow = (y0 + dy + sy) * width + (x0 + sx);
          for (let dx = 0; dx < patchW; dx += 2) {
            sad += Math.abs(prevLuma[prevRow + dx] - luma[currRow + dx]);
          }
        }
        if (sad < bestSad) {
          bestSad = sad;
          bestDx = sx;
          bestDy = sy;
        }
      }
    }

    // Forward rover motion pushes floor textures downward (+dy) and outward (+side * dx)
    sumForward += bestDy + pt.side * bestDx * 0.35;
    // Turning right shifts camera scene to the left (-dx)
    sumTurn += -bestDx;
    valid++;
  }

  if (valid === 0) {
    return { flowForward: 0, flowTurn: 0, luma };
  }
  return {
    flowForward: Number((sumForward / valid).toFixed(3)),
    flowTurn: Number((sumTurn / valid).toFixed(3)),
    luma,
  };
}

/**
 * Sample an adaptive HSV color lock model around a user tap point (normX, normY in [0..1]).
 */
export function sampleHsvTarget(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  normX: number,
  normY: number
): HsvLockModel | null {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return null;
  const cx = clamp(Math.round(normX * (width - 1)), 2, width - 3);
  const cy = clamp(Math.round(normY * (height - 1)), 2, height - 3);

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const idx = ((cy + dy) * width + (cx + dx)) * 4;
      rSum += rgba[idx];
      gSum += rgba[idx + 1];
      bSum += rgba[idx + 2];
      n++;
    }
  }
  const hsv = rgbToHsv(rSum / n, gSum / n, bSum / n);
  return {
    id: `hsv-${Date.now()}`,
    label: "Locked Target",
    target: hsv,
    hueTol: hsv.s < 0.22 ? 45 : 22,
    satMin: Math.max(0.12, hsv.s * 0.45),
    valMin: Math.max(0.15, hsv.v * 0.42),
  };
}

/**
 * Track a tapped HSV color model across a frame and return its bounding box.
 */
export function trackHsvTarget(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  model: HsvLockModel
): DetectedObjectBox | null {
  const total = width * height;
  if (total <= 0 || rgba.length < total * 4) return null;

  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  let hits = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const hsv = rgbToHsv(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
      if (hsv.v < model.valMin || hsv.s < model.satMin) continue;
      if (hueDiffDeg(hsv.h, model.target.h) <= model.hueTol) {
        hits++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const coverage = hits / total;
  if (hits < 8 || coverage < 0.004) return null;

  return {
    id: model.id,
    label: model.label,
    score: clamp(0.65 + coverage * 2.5, 0.65, 0.99),
    x: minX / width,
    y: minY / height,
    w: Math.max(1, maxX - minX + 1) / width,
    h: Math.max(1, maxY - minY + 1) / height,
    source: "hsv",
  };
}

/**
 * Floor-tape / lane-stripe lateral offset detector in the lower third of the frame.
 * Returns normalized error in [-1..+1] (negative = tape is left of center, positive = right) or null.
 */
export function detectFloorLaneOffset(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): number | null {
  if (width < 12 || height < 12 || rgba.length < width * height * 4) return null;
  const y0 = Math.floor(height * 0.68);
  const y1 = Math.floor(height * 0.94);

  // Measure average row luminance so we can find a distinct high-contrast dark or bright tape stripe
  let sumL = 0;
  let cnt = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      sumL += (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;
      cnt++;
    }
  }
  const meanL = cnt > 0 ? sumL / cnt : 128;

  let weightedX = 0;
  let hits = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const lum = (rgba[idx] * 77 + rgba[idx + 1] * 150 + rgba[idx + 2] * 29) >> 8;
      const hsv = rgbToHsv(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
      // Painter's tape (blue/yellow/neon) or strong dark/white track stripe
      const isTape = Math.abs(lum - meanL) > 48 || hsv.s > 0.55;
      if (isTape) {
        weightedX += (x + 0.5) / width;
        hits++;
      }
    }
  }

  const frac = hits / Math.max(1, cnt);
  // A valid floor tape stripe covers a narrow band (2%..28% of lower frame), not the entire floor
  if (frac < 0.02 || frac > 0.28) return null;
  const centerNorm = weightedX / hits;
  return Number(clamp(centerNorm * 2 - 1, -1, 1).toFixed(3));
}
