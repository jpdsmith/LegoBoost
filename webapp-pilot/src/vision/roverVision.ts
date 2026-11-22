// SPDX-License-Identifier: MIT
// Zero-Dependency Real-Time Rover Vision Engine (runs at 10-15 Hz on Android / Pixel Fold):
//   1. Mount-Calibrated 5-Sector + Asymmetric Swept-Bumper Free-Floor Corridor Analyzer
//      - Compensates for off-center rear camera mounts (e.g. Pixel Fold left-offset camera bar)
//      - Persistent EMA floor model (frozen near walls so obstacles never poison floor color)
//      - Shadow-tolerant YCbCr chromaticity matching + horizontal/vertical (chair-leg) edges
//   2. Multi-Patch Block-Matching Optical Flow with Texture Confidence (rug/wheel-spin detection)
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

/**
 * Physical camera mount & chassis geometry calibration (persisted to localStorage).
 * Default values are tuned for a 2023 Google Pixel Fold half-folded at 90° on a LEGO BOOST tank,
 * where the rear camera bar sits slightly left of the chassis centerline.
 */
export interface MountCalibration {
  /** Camera lateral offset from robot centerline in cm (negative = left of center, e.g. -4 cm) */
  camOffsetCm: number;
  /** Physical robot width across treads/bumper in cm (LEGO BOOST tank ≈ 17 cm) */
  robotWidthCm: number;
  /** Camera horizontal FOV in degrees (~78° Pixel Fold wide, ~112° ultrawide) */
  fovDeg: number;
  /** Top horizon cutoff fraction [0.25..0.65] (above this is upper wall/ceiling) */
  horizonY: number;
  /** Bottom bumper mask fraction [0.70..0.98] (below this may show LEGO front hood) */
  bumperMaskY: number;
  /** Preferred rear camera deviceId if multiple rear lenses are exposed */
  cameraDeviceId?: string;
  /** 90° Folded tabletop top visor height % [38..58] */
  foldTopPct: number;
}

export const PIXEL_FOLD_DEFAULT_CALIBRATION: MountCalibration = {
  camOffsetCm: -4.0,
  robotWidthCm: 17.0,
  fovDeg: 78,
  horizonY: 0.36,
  bumperMaskY: 0.9,
  foldTopPct: 48,
};

const CALIBRATION_STORAGE_KEY = "vernie-pilot-fold-calibration-v1";

export function loadMountCalibration(): MountCalibration {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return { ...PIXEL_FOLD_DEFAULT_CALIBRATION };
    }
    const raw = window.localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (!raw) return { ...PIXEL_FOLD_DEFAULT_CALIBRATION };
    const parsed = JSON.parse(raw) as Partial<MountCalibration>;
    // Upgrade legacy 0.44 default horizon to 0.36 for better low-mount wall sightline
    const rawHorizon =
      typeof parsed.horizonY === "number"
        ? Math.abs(parsed.horizonY - 0.44) < 0.001
          ? PIXEL_FOLD_DEFAULT_CALIBRATION.horizonY
          : parsed.horizonY
        : PIXEL_FOLD_DEFAULT_CALIBRATION.horizonY;
    return {
      camOffsetCm: clamp(
        typeof parsed.camOffsetCm === "number" ? parsed.camOffsetCm : PIXEL_FOLD_DEFAULT_CALIBRATION.camOffsetCm,
        -12,
        12
      ),
      robotWidthCm: clamp(
        typeof parsed.robotWidthCm === "number" ? parsed.robotWidthCm : PIXEL_FOLD_DEFAULT_CALIBRATION.robotWidthCm,
        10,
        28
      ),
      fovDeg: clamp(
        typeof parsed.fovDeg === "number" ? parsed.fovDeg : PIXEL_FOLD_DEFAULT_CALIBRATION.fovDeg,
        50,
        130
      ),
      horizonY: clamp(rawHorizon, 0.22, 0.65),
      bumperMaskY: clamp(
        typeof parsed.bumperMaskY === "number" ? parsed.bumperMaskY : PIXEL_FOLD_DEFAULT_CALIBRATION.bumperMaskY,
        0.7,
        0.98
      ),
      cameraDeviceId: typeof parsed.cameraDeviceId === "string" ? parsed.cameraDeviceId : undefined,
      foldTopPct: clamp(
        typeof parsed.foldTopPct === "number" ? parsed.foldTopPct : PIXEL_FOLD_DEFAULT_CALIBRATION.foldTopPct,
        38,
        58
      ),
    };
  } catch {
    return { ...PIXEL_FOLD_DEFAULT_CALIBRATION };
  }
}

export function saveMountCalibration(cal: MountCalibration): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(cal));
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

export interface SweptBumperBounds {
  uLeft: number;
  uRight: number;
  uCenter: number;
  distCm: number;
}

/**
 * Project the physical left/right edges of the robot chassis into normalized image X [0..1]
 * at a given depth fraction `depthFrac` (0 = near bumper ~24 cm, 1 = horizon ~165 cm).
 *
 * When the camera is mounted to the LEFT of robot center (`camOffsetCm < 0`),
 * the robot's physical right corner extends much further RIGHT in the camera view than the left corner!
 */
export function computeSweptBumperBounds(
  cal: Pick<MountCalibration, "camOffsetCm" | "robotWidthCm" | "fovDeg">,
  depthFrac: number
): SweptBumperBounds {
  const t = clamp(depthFrac, 0, 1);
  // Perspective foreshortening: rows near bottom are ~24 cm ahead, horizon ~165 cm ahead
  const distCm = 24 + t * t * 141;
  const halfFovRad = (clamp(cal.fovDeg, 45, 130) * Math.PI) / 360;
  const halfViewWidthCm = Math.max(8, distCm * Math.tan(halfFovRad));

  // Robot edges relative to camera optical axis (positive = right of camera)
  const xLeftCm = -cal.robotWidthCm / 2 - cal.camOffsetCm;
  const xRightCm = cal.robotWidthCm / 2 - cal.camOffsetCm;
  const xCenterCm = -cal.camOffsetCm;

  const uLeft = clamp(0.5 + xLeftCm / (2 * halfViewWidthCm), 0.02, 0.94);
  const uRight = clamp(0.5 + xRightCm / (2 * halfViewWidthCm), Math.min(0.98, uLeft + 0.04), 0.98);
  const uCenter = clamp(0.5 + xCenterCm / (2 * halfViewWidthCm), 0.08, 0.92);

  return { uLeft, uRight, uCenter, distCm };
}

/**
 * Persistent EMA floor appearance & micro-texture model so approaching a smooth wall
 * or white skirting board never overwrites the learned floor color/texture.
 */
export interface FloorModelState {
  r: number;
  g: number;
  b: number;
  y: number;
  cb: number;
  cr: number;
  noise: number;
  /** Mean 4x4 local pixel-to-pixel luma texture energy (carpet ≈ 9..19, smooth wall ≈ 1..3) */
  tex: number;
  samples: number;
}

export function createFloorModel(): FloorModelState {
  return { r: 140, g: 130, b: 115, y: 131, cb: 119, cr: 134, noise: 12, tex: 0, samples: 0 };
}

export interface FloorAnalysisOptions {
  calibration?: Partial<MountCalibration>;
  /** Optional persistent floor model mutated in-place when `allowFloorUpdate` is true */
  floorModel?: FloorModelState | null;
  /** Set false when inches from a wall or during AVOIDING/UNSTICKING so walls never poison floor color */
  allowFloorUpdate?: boolean;
}

export interface FloorCorridorResult {
  corridors: [number, number, number, number, number];
  bestSteer: number;
  /** Y coordinate (normalized 0..1) of deepest open floor point per corridor for HUD polygon */
  horizonYs: [number, number, number, number, number];
  /** Clearance [0..1] specifically inside the robot's asymmetric swept bumper corridor */
  sweptClear: number;
  /** Learned floor RGB used for this frame */
  floorRgb: [number, number, number];
  /** Texture variance of floor patch */
  floorNoise: number;
  /** Average frame luminance [0..255] (drives auto-headlights in dim rooms) */
  avgLuma: number;
  /** Normalized [0..1] rectangle of the floor sampling patch for HUD debugging */
  floorPatch: { x: number; y: number; w: number; h: number };
}

export interface OpticalFlowResult {
  flowForward: number;
  flowTurn: number;
  /** Number of textured patches that contributed valid flow estimates (0..9) */
  validPatches: number;
  /** Texture confidence [0..1] (0 = featureless scene, >=0.4 = reliable stuck/motion signal) */
  confidence: number;
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

function rgbToYCbCr(r: number, g: number, b: number): { y: number; cb: number; cr: number } {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return { y, cb, cr };
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
 * Mount-Calibrated 5-Sector + Asymmetric Swept-Bumper Free-Floor Corridor Analyzer.
 *
 * Improvements over raw RGB foreground diffing:
 *  - Compensates for off-center cameras (e.g. Pixel Fold left-offset camera bar) by checking
 *    the true asymmetric swept chassis corridor `[uLeft(y)..uRight(y)]`.
 *  - Uses optional persistent EMA `floorModel` that freezes near obstacles so walls cannot
 *    poison the learned floor color.
 *  - Separates YCbCr chromaticity from luminance so shadows on flat floor don't trigger phantom walls.
 *  - Detects BOTH horizontal edges (baseboards) and vertical edges (thin chair/table legs).
 */
export function analyzeFloorCorridors(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options?: FloorAnalysisOptions
): FloorCorridorResult {
  const defaultPatch = { x: 0.34, y: 0.84, w: 0.32, h: 0.12 };
  if (width < 10 || height < 10 || rgba.length < width * height * 4) {
    return {
      corridors: [0.5, 0.5, 0.5, 0.5, 0.5],
      bestSteer: 0,
      horizonYs: [0.65, 0.65, 0.65, 0.65, 0.65],
      sweptClear: 0.5,
      floorRgb: [140, 130, 115],
      floorNoise: 12,
      avgLuma: 128,
      floorPatch: defaultPatch,
    };
  }

  const cal: MountCalibration = {
    camOffsetCm: options?.calibration?.camOffsetCm ?? 0,
    robotWidthCm: options?.calibration?.robotWidthCm ?? PIXEL_FOLD_DEFAULT_CALIBRATION.robotWidthCm,
    fovDeg: options?.calibration?.fovDeg ?? PIXEL_FOLD_DEFAULT_CALIBRATION.fovDeg,
    horizonY: clamp(
      options?.calibration?.horizonY ?? PIXEL_FOLD_DEFAULT_CALIBRATION.horizonY,
      0.22,
      0.65
    ),
    bumperMaskY: clamp(options?.calibration?.bumperMaskY ?? 0.9, 0.7, 0.98),
    foldTopPct: options?.calibration?.foldTopPct ?? 48,
  };

  // Extract 1-byte grayscale luminance buffer once (reused for avgLuma, 4x4 micro-texture, and edges)
  const luma = extractLuma(rgba, width, height);

  // Sample average frame luminance (sparse stride for speed) for low-light auto-headlights
  let totalLuma = 0;
  let totalLumaCount = 0;
  for (let y = 0; y < height; y += 4) {
    const rowOff = y * width;
    for (let x = 0; x < width; x += 4) {
      totalLuma += luma[rowOff + x];
      totalLumaCount++;
    }
  }
  const avgLuma = totalLumaCount > 0 ? Math.round(totalLuma / totalLumaCount) : 128;

  // Precompute 4x4 local micro-texture map (plush carpet ≈ 9..19 vs smooth painted walls/baseboards ≈ 1..3)
  const bw = Math.max(1, width >> 2);
  const bh = Math.max(1, height >> 2);
  const blockTex = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y0 = by << 2;
    const y1 = Math.min(height - 1, y0 + 4);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx << 2;
      const x1 = Math.min(width - 1, x0 + 4);
      let texSum = 0;
      let texN = 0;
      for (let yy = y0; yy < y1; yy++) {
        const rowOff = yy * width;
        for (let xx = x0; xx < x1; xx++) {
          const v = luma[rowOff + xx];
          texSum +=
            Math.abs(v - luma[rowOff + xx + 1]) + Math.abs(v - luma[rowOff + width + xx]);
          texN++;
        }
      }
      blockTex[by * bw + bx] = texN > 0 ? texSum / texN : 0;
    }
  }

  // 1. Sample immediate foreground floor patch right above bumperMaskY, centered on robot centerline
  const nearBounds = computeSweptBumperBounds(cal, 0.12);
  const patchWFrac = 0.3;
  const patchX0Norm = clamp(nearBounds.uCenter - patchWFrac / 2, 0.08, 0.92 - patchWFrac);
  const patchY1Norm = clamp(cal.bumperMaskY + 0.04, 0.74, 0.96);
  const patchY0Norm = clamp(patchY1Norm - 0.1, 0.62, patchY1Norm - 0.04);

  const yStart = Math.floor(height * patchY0Norm);
  const yEnd = Math.max(yStart + 2, Math.floor(height * patchY1Norm));
  const xStart = Math.floor(width * patchX0Norm);
  const xEnd = Math.max(xStart + 2, Math.floor(width * (patchX0Norm + patchWFrac)));

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
  const sampleR = count > 0 ? sumR / count : 140;
  const sampleG = count > 0 ? sumG / count : 130;
  const sampleB = count > 0 ? sumB / count : 115;

  // Measure foreground texture variance & 4x4 micro-texture so patterned carpets don't false-trigger
  // while smooth painted skirting boards / walls stand out sharply against textured flooring
  let varSum = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * width + x) * 4;
      const dr = Math.abs(rgba[idx] - sampleR);
      const dg = Math.abs(rgba[idx + 1] - sampleG);
      const db = Math.abs(rgba[idx + 2] - sampleB);
      varSum += (dr + dg + db) / 3;
    }
  }
  const sampleNoise = count > 0 ? varSum / count : 12;

  const patchBlockTex: number[] = [];
  const pby0 = clamp(yStart >> 2, 0, bh - 1);
  const pby1 = clamp((yEnd - 1) >> 2, pby0, bh - 1);
  const pbx0 = clamp(xStart >> 2, 0, bw - 1);
  const pbx1 = clamp((xEnd - 1) >> 2, pbx0, bw - 1);
  for (let by = pby0; by <= pby1; by++) {
    for (let bx = pbx0; bx <= pbx1; bx++) {
      patchBlockTex.push(blockTex[by * bw + bx]);
    }
  }
  patchBlockTex.sort((a, b) => a - b);
  // Use the median 4x4 micro-texture so an obstacle seam touching one corner of a smooth hardwood
  // patch never inflates floorTex into falsely thinking the floor is plush carpet!
  const sampleTex =
    patchBlockTex.length > 0 ? patchBlockTex[Math.floor(patchBlockTex.length / 2)] : 0;

  // Blend into persistent EMA floor model when provided and verified to still be genuine floor
  const model = options?.floorModel ?? null;
  let floorR = sampleR;
  let floorG = sampleG;
  let floorB = sampleB;
  let floorNoise = sampleNoise;
  let floorTex = sampleTex;

  if (model) {
    const allowUpdate = options?.allowFloorUpdate !== false;
    if (model.samples === 0) {
      const ycc = rgbToYCbCr(sampleR, sampleG, sampleB);
      model.r = sampleR;
      model.g = sampleG;
      model.b = sampleB;
      model.y = ycc.y;
      model.cb = ycc.cb;
      model.cr = ycc.cr;
      model.noise = sampleNoise;
      model.tex = sampleTex;
      model.samples = 1;
    } else if (allowUpdate && sampleNoise < 44) {
      const patchYcc = rgbToYCbCr(sampleR, sampleG, sampleB);
      const chromaJump = Math.hypot(patchYcc.cb - model.cb, patchYcc.cr - model.cr);
      const lumaJump = Math.abs(patchYcc.y - model.y);
      // Verify the foreground patch still matches the floor's texture/chroma before adapting
      // so smooth walls entering the bottom patch never poison the learned floor model,
      // while phone AE transitions across sunlit/shaded carpet adapt cleanly!
      const isTexturedFloor = model.tex >= 6.5;
      const patchLooksLikeFloor = isTexturedFloor
        ? sampleTex >= model.tex * 0.48 && chromaJump < 9.0
        : chromaJump < 8.5 && lumaJump < 38;
      if (patchLooksLikeFloor) {
        const alpha = chromaJump < 4.5 ? 0.45 : 0.18;
        model.r += (sampleR - model.r) * alpha;
        model.g += (sampleG - model.g) * alpha;
        model.b += (sampleB - model.b) * alpha;
        const updated = rgbToYCbCr(model.r, model.g, model.b);
        model.y = updated.y;
        model.cb = updated.cb;
        model.cr = updated.cr;
        model.noise += (sampleNoise - model.noise) * alpha;
        model.tex += (sampleTex - model.tex) * 0.15;
        model.samples += 1;
      }
    }
    floorR = model.r;
    floorG = model.g;
    floorB = model.b;
    floorNoise = model.noise;
    floorTex = model.tex;
  }

  const floorHsv = rgbToHsv(floorR, floorG, floorB);
  const floorYcc = rgbToYCbCr(floorR, floorG, floorB);

  const colorDistThresh = clamp(32 + floorNoise * 1.5, 32, 68);
  const chromaBarrierThresh = clamp(6.6 + floorNoise * 0.16, 6.6, 11.5);
  const shadowLumaThresh = clamp(62 + floorNoise * 2.1, 64, 108);
  const brightLumaThresh = clamp(28 + floorNoise * 0.9, 28, 46);
  const edgeThresh = clamp(30 + floorNoise * 1.4, 30, 68);
  const vertEdgeThresh = clamp(32 + floorNoise * 1.5, 32, 72);

  const yBottom = Math.floor(height * cal.bumperMaskY);
  const yHorizon = Math.min(yBottom - 4, Math.floor(height * cal.horizonY));
  const scanRows = Math.max(1, yBottom - yHorizon);
  const xStep = width >= 140 ? 2 : width >= 70 ? 2 : 1;

  // Pixel obstacle classification helper:
  //   - Dark-only shadow tolerance (never classifies bright white walls/baseboards as shadows!)
  //   - 4x4 micro-texture smoothness barrier (catches painted baseboards on textured carpet)
  //   - Dual-axis edges (1-2 row baseboard seam + vertical chair/table legs)
  const classifyPixel = (
    x: number,
    y: number,
    depthFrac: number
  ): { blocked: boolean; verticalEdge: boolean } => {
    const pIdx = y * width + x;
    const idx = pIdx * 4;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];

    const pxYcc = rgbToYCbCr(r, g, b);
    const chromaDiff = Math.hypot(pxYcc.cb - floorYcc.cb, pxYcc.cr - floorYcc.cr);
    const dy = pxYcc.y - floorYcc.y;
    const lumaDiff = Math.abs(dy);

    // Shadow-tolerant color test:
    // Only DARKER regions (dy < 0) with tightly preserved floor chromaticity pass as cast shadows.
    // Brighter neutral white skirting boards / walls never qualify as shadows!
    const isDarkShadow = dy < 0 && chromaDiff <= 5.2;
    const meanRgbDiff = (Math.abs(r - floorR) + Math.abs(g - floorG) + Math.abs(b - floorB)) / 3;
    const colorBarrier = isDarkShadow
      ? lumaDiff > shadowLumaThresh
      : chromaDiff > chromaBarrierThresh ||
        (dy > brightLumaThresh && chromaDiff > 3.6) ||
        meanRgbDiff > colorDistThresh;

    // Micro-texture smoothness barrier: smooth painted walls/skirting boards on textured carpet
    const localTex = blockTex[Math.min(bh - 1, y >> 2) * bw + Math.min(bw - 1, x >> 2)];
    const expectedFloorTex = floorTex * (1 - depthFrac * 0.45);
    const smoothWallHit =
      floorTex >= 6.5 &&
      localTex < expectedFloorTex * 0.36 &&
      (chromaDiff > 4.0 || lumaDiff > 14);

    const pxHsv = rgbToHsv(r, g, b);
    const hueBarrier =
      pxHsv.s > 0.3 && floorHsv.s > 0.14 && hueDiffDeg(pxHsv.h, floorHsv.h) > 38;
    const satBarrier = Math.abs(pxHsv.s - floorHsv.s) > 0.36;

    // Horizontal edge (baseboard / obstacle seam over 1-2 rows) & Vertical edge (chair / table leg!)
    const lCurr = luma[pIdx];
    const lAbove1 = luma[Math.max(0, y - 1) * width + x];
    const lAbove2 = luma[Math.max(0, y - 2) * width + x];
    const lLeft = luma[y * width + Math.max(0, x - xStep)];

    const horizEdgeHit =
      Math.abs(lCurr - lAbove1) > edgeThresh || Math.abs(lCurr - lAbove2) > edgeThresh;
    const vertEdgeHit = Math.abs(lCurr - lLeft) > vertEdgeThresh;

    // A vertical edge combined with non-shadow chroma/color deviation catches narrow chair legs!
    const legEdgeHit = vertEdgeHit && (!isDarkShadow || lumaDiff > colorDistThresh * 0.75);

    return {
      blocked:
        colorBarrier || smoothWallHit || hueBarrier || satBarrier || horizEdgeHit || legEdgeHit,
      verticalEdge:
        vertEdgeHit &&
        (colorBarrier || smoothWallHit || hueBarrier || satBarrier || lumaDiff > 28),
    };
  };

  // 2. Scan upward across 5 horizontal sectors
  const corridors: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const horizonYs: [number, number, number, number, number] = [
    cal.bumperMaskY,
    cal.bumperMaskY,
    cal.bumperMaskY,
    cal.bumperMaskY,
    cal.bumperMaskY,
  ];

  for (let s = 0; s < 5; s++) {
    const sx0 = Math.floor((s / 5) * width) + 1;
    const sx1 = Math.floor(((s + 1) / 5) * width) - 1;
    const cols = Math.max(1, sx1 - sx0);

    let freeRows = 0;
    let consecutiveBlocked = 0;
    let consecutiveThinLeg = 0;

    for (let y = yBottom; y >= yHorizon; y--) {
      const depthFrac = (yBottom - y) / scanRows;
      let blockedCols = 0;
      let vertEdgeCols = 0;
      let runCols = 0;
      let maxRunCols = 0;

      for (let x = sx0; x < sx1; x += xStep) {
        const res = classifyPixel(x, y, depthFrac);
        if (res.blocked) {
          blockedCols += xStep;
          runCols += xStep;
          if (runCols > maxRunCols) maxRunCols = runCols;
        } else {
          runCols = 0;
        }
        if (res.verticalEdge) {
          vertEdgeCols += xStep;
        }
      }

      const blockedFrac = blockedCols / cols;
      // Chair-leg guard in near/mid field: a narrow vertical object (>= 16% of sector with vertical edge)
      const thinLegHit =
        depthFrac < 0.72 && vertEdgeCols >= xStep && maxRunCols / cols >= 0.16 && blockedFrac >= 0.18;

      if (blockedFrac > 0.44) {
        consecutiveBlocked++;
        if (consecutiveBlocked >= 3) break;
      } else if (thinLegHit) {
        consecutiveThinLeg++;
        consecutiveBlocked = 0;
        if (consecutiveThinLeg >= 4) break;
      } else {
        consecutiveBlocked = 0;
        consecutiveThinLeg = 0;
        freeRows = yBottom - y + 1;
      }
    }

    const clearance = clamp(freeRows / scanRows, 0, 1);
    corridors[s] = Number(clearance.toFixed(2));
    horizonYs[s] = Number(((yBottom - freeRows) / height).toFixed(3));
  }

  // 3. Dedicated Asymmetric Swept-Bumper Corridor Scan (critical for Pixel Fold left-offset camera!)
  let sweptFreeRows = 0;
  let sweptBlockedRun = 0;
  let sweptLegRun = 0;
  for (let y = yBottom; y >= yHorizon; y--) {
    const depthFrac = (yBottom - y) / scanRows;
    const bounds = computeSweptBumperBounds(cal, depthFrac);
    const bx0 = Math.max(1, Math.floor(bounds.uLeft * width));
    const bx1 = Math.min(width - 2, Math.ceil(bounds.uRight * width));
    const bCols = Math.max(1, bx1 - bx0);

    let bBlocked = 0;
    let bVertEdges = 0;
    let bRun = 0;
    let bMaxRun = 0;
    for (let x = bx0; x < bx1; x += xStep) {
      const res = classifyPixel(x, y, depthFrac);
      if (res.blocked) {
        bBlocked += xStep;
        bRun += xStep;
        if (bRun > bMaxRun) bMaxRun = bRun;
      } else {
        bRun = 0;
      }
      if (res.verticalEdge) bVertEdges += xStep;
    }

    const bFrac = bBlocked / bCols;
    const minLegPx = Math.max(3, Math.round(width * 0.025));
    const bLegHit =
      depthFrac < 0.78 && bVertEdges >= xStep && bMaxRun >= minLegPx;
    if (bFrac > 0.34) {
      sweptBlockedRun++;
      if (sweptBlockedRun >= 3) break;
    } else if (bLegHit) {
      sweptLegRun++;
      sweptBlockedRun = 0;
      if (sweptLegRun >= 4) break;
    } else {
      sweptBlockedRun = 0;
      sweptLegRun = 0;
      sweptFreeRows = yBottom - y + 1;
    }
  }
  const sweptClear = Number(clamp(sweptFreeRows / scanRows, 0, 1).toFixed(2));

  // 4. Weighted steering score shifted by robot centerline (accounts for left/right camera offset!)
  const midBounds = computeSweptBumperBounds(cal, 0.35);
  const centerU = midBounds.uCenter;
  const sectorCenters = [0.1, 0.3, 0.5, 0.7, 0.9];
  let wSum = 0;
  let total = 0;
  for (let s = 0; s < 5; s++) {
    const weight = clamp((sectorCenters[s] - centerU) / 0.4, -1.1, 1.1);
    const score = corridors[s] * corridors[s];
    wSum += weight * score;
    total += score;
  }
  const bestSteer = total > 0.05 ? clamp((wSum / total) * 1.4, -1, 1) : 0;

  return {
    corridors,
    bestSteer: Number(bestSteer.toFixed(3)),
    horizonYs,
    sweptClear,
    floorRgb: [Math.round(floorR), Math.round(floorG), Math.round(floorB)],
    floorNoise: Number(floorNoise.toFixed(1)),
    avgLuma,
    floorPatch: {
      x: Number(patchX0Norm.toFixed(3)),
      y: Number(patchY0Norm.toFixed(3)),
      w: Number(patchWFrac.toFixed(3)),
      h: Number((patchY1Norm - patchY0Norm).toFixed(3)),
    },
  };
}

/**
 * Multi-patch block-matching optical flow between consecutive grayscale frames.
 * Reports texture confidence (`validPatches` / `confidence`) so the explorer can distinguish
 * a genuine rug/wheel-spin snag on textured floor from a blank featureless wall.
 */
export function computeOpticalFlow(
  prevLuma: Uint8Array | null,
  currRgba: Uint8ClampedArray,
  width: number,
  height: number
): OpticalFlowResult {
  const luma = extractLuma(currRgba, width, height);
  if (!prevLuma || prevLuma.length !== luma.length || width < 24 || height < 18) {
    return { flowForward: 0, flowTurn: 0, validPatches: 0, confidence: 0, luma };
  }

  const scale = width / 80;
  const patchW = Math.max(6, Math.round(8 * scale));
  const patchH = Math.max(6, Math.round(6 * scale));
  const search = clamp(Math.round(3 * scale), 3, 6);
  const step = 2;

  const samplePoints = [
    { x: Math.floor(width * 0.2), y: Math.floor(height * 0.72), side: -1 },
    { x: Math.floor(width * 0.5), y: Math.floor(height * 0.74), side: 0 },
    { x: Math.floor(width * 0.8), y: Math.floor(height * 0.72), side: 1 },
    { x: Math.floor(width * 0.22), y: Math.floor(height * 0.58), side: -1 },
    { x: Math.floor(width * 0.5), y: Math.floor(height * 0.58), side: 0 },
    { x: Math.floor(width * 0.78), y: Math.floor(height * 0.58), side: 1 },
    { x: Math.floor(width * 0.25), y: Math.floor(height * 0.44), side: -1 },
    { x: Math.floor(width * 0.5), y: Math.floor(height * 0.44), side: 0 },
    { x: Math.floor(width * 0.75), y: Math.floor(height * 0.44), side: 1 },
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
    for (let dy = 0; dy < patchH; dy += step) {
      for (let dx = 0; dx < patchW; dx += step) {
        const v = prevLuma[(y0 + dy) * width + (x0 + dx)];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    if (maxV - minV < 10) continue;

    let bestScore = Infinity;
    let bestDx = 0;
    let bestDy = 0;
    for (let sy = -search; sy <= search; sy++) {
      for (let sx = -search; sx <= search; sx++) {
        let sad = 0;
        for (let dy = 0; dy < patchH; dy += step) {
          const prevRow = (y0 + dy) * width + x0;
          const currRow = (y0 + dy + sy) * width + (x0 + sx);
          for (let dx = 0; dx < patchW; dx += step) {
            sad += Math.abs(prevLuma[prevRow + dx] - luma[currRow + dx]);
          }
        }
        // Tiny quadratic tie-breaker eliminates aperture-problem phantom drift on horizontal floorboards!
        const score = sad + (sx * sx + sy * sy) * 0.25;
        if (score < bestScore) {
          bestScore = score;
          bestDx = sx;
          bestDy = sy;
        }
      }
    }

    // Normalize shifts to 80px-width units so thresholds remain invariant across 80x60 and 160x120
    const normDx = bestDx / Math.max(0.5, scale);
    const normDy = bestDy / Math.max(0.5, scale);

    // Forward rover motion pushes floor textures downward (+dy) and outward (+side * dx)
    sumForward += normDy + pt.side * normDx * 0.35;
    // Turning right shifts camera scene to the left (-dx)
    sumTurn += -normDx;
    valid++;
  }

  if (valid === 0) {
    return { flowForward: 0, flowTurn: 0, validPatches: 0, confidence: 0, luma };
  }
  const confidence = Number(clamp(valid / 5, 0, 1).toFixed(2));
  return {
    flowForward: Number((sumForward / valid).toFixed(3)),
    flowTurn: Number((sumTurn / valid).toFixed(3)),
    validPatches: valid,
    confidence,
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
      const isTape = Math.abs(lum - meanL) > 48 || hsv.s > 0.55;
      if (isTape) {
        weightedX += (x + 0.5) / width;
        hits++;
      }
    }
  }

  const frac = hits / Math.max(1, cnt);
  if (frac < 0.02 || frac > 0.28) return null;
  const centerNorm = weightedX / hits;
  return Number(clamp(centerNorm * 2 - 1, -1, 1).toFixed(3));
}
