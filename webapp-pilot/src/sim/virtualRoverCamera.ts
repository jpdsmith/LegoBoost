// SPDX-License-Identifier: MIT
// Procedural 3D-Perspective Simulated FPV Rover Camera for Demo Mode!
// Renders a realistic living-room floor arena with walls, doorway, chair, bright red ball,
// backpack, and friendly person — driven live by the virtual rover's (x, y, headingDeg) pose.
// Also emits true projected bounding boxes and front obstacle distance so Smart Co-Pilot,
// Tap-to-Follow, and Intelligent Exploration run live with zero external hardware!

import { DetectedObjectBox } from "../rtc/roverBridge";

export interface ArenaLandmark {
  id: string;
  label: string;
  x: number; // cm (-240..+240)
  y: number; // cm (-240..+240)
  radiusCm: number;
  heightCm: number;
  color: string;
  accent: string;
  shape: "ball" | "chair" | "person" | "box" | "plant";
}

export const DEMO_ARENA_HALF_CM = 230;

export const DEMO_LANDMARKS: ArenaLandmark[] = [
  { id: "ball-1", label: "sports ball", x: 55, y: 125, radiusCm: 16, heightCm: 32, color: "#DC2626", accent: "#FCA5A5", shape: "ball" },
  { id: "chair-1", label: "chair", x: -95, y: 110, radiusCm: 28, heightCm: 76, color: "#92400E", accent: "#D97706", shape: "chair" },
  { id: "person-1", label: "person", x: 130, y: -40, radiusCm: 26, heightCm: 115, color: "#2563EB", accent: "#FDBA74", shape: "person" },
  { id: "plant-1", label: "potted plant", x: -135, y: -95, radiusCm: 24, heightCm: 68, color: "#15803D", accent: "#86EFAC", shape: "plant" },
  { id: "pack-1", label: "backpack", x: -10, y: -145, radiusCm: 24, heightCm: 48, color: "#EA580C", accent: "#FDE047", shape: "box" },
];

export interface VirtualCameraRenderResult {
  /** Projected visible landmarks matching DetectedObjectBox schema */
  visibleObjects: DetectedObjectBox[];
  /** Simulated front bumper 88007 distance percentage (0..100, 100 = clear) */
  frontDistancePct: number;
  /** True geometric 5-sector free-floor clearance [FL, ML, C, MR, FR] in [0..1] */
  trueCorridors: [number, number, number, number, number];
}

function rayWallOnlyCm(
  rx: number,
  ry: number,
  angleRad: number,
  maxDistCm = 420
): number {
  const dx = Math.sin(angleRad);
  const dy = Math.cos(angleRad);
  let best = maxDistCm;
  if (Math.abs(dx) > 1e-4) {
    const tPos = (DEMO_ARENA_HALF_CM - rx) / dx;
    const tNeg = (-DEMO_ARENA_HALF_CM - rx) / dx;
    if (tPos > 0 && tPos < best) best = tPos;
    if (tNeg > 0 && tNeg < best) best = tNeg;
  }
  if (Math.abs(dy) > 1e-4) {
    const tPos = (DEMO_ARENA_HALF_CM - ry) / dy;
    const tNeg = (-DEMO_ARENA_HALF_CM - ry) / dy;
    if (tPos > 0 && tPos < best) best = tPos;
    if (tNeg > 0 && tNeg < best) best = tNeg;
  }
  return best;
}

function rayClearanceCm(
  rx: number,
  ry: number,
  angleRad: number,
  maxDistCm = 240
): number {
  const dx = Math.sin(angleRad);
  const dy = Math.cos(angleRad);
  let best = rayWallOnlyCm(rx, ry, angleRad, maxDistCm);

  // Check circular landmark footprints
  for (const lm of DEMO_LANDMARKS) {
    const ocx = lm.x - rx;
    const ocy = lm.y - ry;
    const proj = ocx * dx + ocy * dy;
    if (proj <= 0) continue;
    const perpSq = ocx * ocx + ocy * ocy - proj * proj;
    const r = lm.radiusCm + 10;
    if (perpSq < r * r) {
      const hit = Math.max(0, proj - Math.sqrt(r * r - perpSq));
      if (hit < best) best = hit;
    }
  }
  return best;
}

/**
 * Render one realistic 3D-perspective FPV frame onto a 2D canvas for Demo Rover Mode.
 */
export function renderVirtualRoverCamera(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  roverXCm: number,
  roverYCm: number,
  headingDeg: number,
  headlightsOn: boolean
): VirtualCameraRenderResult {
  const horizonY = Math.round(height * 0.42);
  const fovRad = (68 * Math.PI) / 180;
  const halfFov = fovRad / 2;
  const focal = (width / 2) / Math.tan(halfFov);
  const headingRad = (headingDeg * Math.PI) / 180;

  // 1. Warm living-room ceiling / upper wall gradient
  const wallGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
  wallGrad.addColorStop(0, headlightsOn ? "#334155" : "#1E2530");
  wallGrad.addColorStop(1, headlightsOn ? "#475569" : "#2A3342");
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, width, horizonY);

  // 2. Warm light hardwood floor gradient spanning bottom ~58% of frame
  const floorGrad = ctx.createLinearGradient(0, horizonY, 0, height);
  floorGrad.addColorStop(0, headlightsOn ? "#C8B89C" : "#A6967D");
  floorGrad.addColorStop(1, headlightsOn ? "#E8DCC5" : "#C9BA9F");
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, horizonY, width, height - horizonY);

  // Draw ONLY room perimeter walls aligned accurately to the 28cm floor contact plane
  const cols = 40;
  const colW = Math.ceil(width / cols);
  for (let c = 0; c < cols; c++) {
    const screenX = (c + 0.5) * (width / cols) - width / 2;
    const relAngle = Math.atan2(screenX, focal);
    const rayAngle = headingRad + relAngle;
    const distWall = rayWallOnlyCm(roverXCm, roverYCm, rayAngle, 460);
    const perpDist = Math.max(24, distWall * Math.cos(relAngle));
    const botY = Math.min(height, horizonY + (28 * focal) / perpDist);
    const topY = Math.max(0, horizonY - (110 * focal) / perpDist);
    const shade = Math.max(0.26, Math.min(1, 1 - perpDist / 460));
    const lum = Math.round((headlightsOn ? 88 : 58) * shade + 24);
    ctx.fillStyle = `rgb(${lum}, ${lum + 6}, ${lum + 15})`;
    ctx.fillRect(c * colW, topY, colW + 1, Math.max(1, botY - topY));
    // Crisp dark baseboard line at true wall-floor contact
    ctx.fillStyle = `rgba(15, 23, 42, ${0.45 + 0.45 * shade})`;
    ctx.fillRect(c * colW, botY - 3, colW + 1, 4);
  }

  // Subtle floor depth stripes moving past the camera (gives real optical flow!)
  const cosH = Math.cos(headingRad);
  const sinH = Math.sin(headingRad);
  ctx.strokeStyle = headlightsOn ? "rgba(120, 96, 68, 0.22)" : "rgba(74, 58, 40, 0.24)";
  ctx.lineWidth = 1.5;
  for (let gx = -200; gx <= 200; gx += 50) {
    for (let gy = -200; gy <= 200; gy += 50) {
      const dx = gx - roverXCm;
      const dy = gy - roverYCm;
      const forward = dx * sinH + dy * cosH;
      const right = dx * cosH - dy * sinH;
      if (forward > 22 && forward < 220) {
        const sx = width / 2 + (right / forward) * focal;
        const sy = horizonY + (28 * focal) / forward;
        if (sx >= 0 && sx <= width && sy >= horizonY && sy <= height) {
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(1.2, 22 / forward * 3), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  // 3. Project & sort landmarks back-to-front
  const projected: Array<{
    lm: ArenaLandmark;
    forward: number;
    right: number;
    sx: number;
    botY: number;
    pxW: number;
    pxH: number;
  }> = [];

  for (const lm of DEMO_LANDMARKS) {
    const dx = lm.x - roverXCm;
    const dy = lm.y - roverYCm;
    const forward = dx * sinH + dy * cosH;
    const right = dx * cosH - dy * sinH;
    if (forward < 16 || forward > 320) continue;
    const sx = width / 2 + (right / forward) * focal;
    const pxW = (lm.radiusCm * 2 * focal) / forward;
    const pxH = (lm.heightCm * focal) / forward;
    const botY = horizonY + (28 * focal) / forward;
    if (sx + pxW < 0 || sx - pxW > width) continue;
    projected.push({ lm, forward, right, sx, botY, pxW, pxH });
  }
  projected.sort((a, b) => b.forward - a.forward);

  const visibleObjects: DetectedObjectBox[] = [];

  for (const p of projected) {
    const { lm, sx, botY, pxW, pxH, forward } = p;
    const topY = botY - pxH;

    // Ground contact shadow
    ctx.fillStyle = "rgba(15, 23, 42, 0.32)";
    ctx.beginPath();
    ctx.ellipse(sx, botY, pxW * 0.55, Math.max(3, pxW * 0.14), 0, 0, Math.PI * 2);
    ctx.fill();

    if (lm.shape === "ball") {
      const r = pxW * 0.5;
      ctx.fillStyle = lm.color;
      ctx.beginPath();
      ctx.arc(sx, botY - r, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = lm.accent;
      ctx.beginPath();
      ctx.arc(sx - r * 0.25, botY - r * 1.25, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    } else if (lm.shape === "person") {
      // Torso + legs + friendly head
      const bodyW = pxW * 0.65;
      ctx.fillStyle = "#1E293B";
      ctx.fillRect(sx - bodyW * 0.42, botY - pxH * 0.42, bodyW * 0.34, pxH * 0.42);
      ctx.fillRect(sx + bodyW * 0.08, botY - pxH * 0.42, bodyW * 0.34, pxH * 0.42);
      ctx.fillStyle = lm.color;
      ctx.fillRect(sx - bodyW * 0.5, topY + pxH * 0.24, bodyW, pxH * 0.38);
      ctx.fillStyle = lm.accent;
      ctx.beginPath();
      ctx.arc(sx, topY + pxH * 0.13, pxW * 0.24, 0, Math.PI * 2);
      ctx.fill();
    } else if (lm.shape === "chair") {
      ctx.fillStyle = lm.color;
      ctx.fillRect(sx - pxW * 0.42, botY - pxH * 0.48, pxW * 0.12, pxH * 0.48);
      ctx.fillRect(sx + pxW * 0.3, botY - pxH * 0.48, pxW * 0.12, pxH * 0.48);
      ctx.fillStyle = lm.accent;
      ctx.fillRect(sx - pxW * 0.46, botY - pxH * 0.52, pxW * 0.92, pxH * 0.1);
      ctx.fillRect(sx - pxW * 0.42, topY, pxW * 0.84, pxH * 0.48);
    } else if (lm.shape === "plant") {
      ctx.fillStyle = "#B45309";
      ctx.fillRect(sx - pxW * 0.3, botY - pxH * 0.36, pxW * 0.6, pxH * 0.36);
      ctx.fillStyle = lm.color;
      ctx.beginPath();
      ctx.arc(sx, botY - pxH * 0.64, pxW * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = lm.accent;
      ctx.beginPath();
      ctx.arc(sx - pxW * 0.15, botY - pxH * 0.72, pxW * 0.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = lm.color;
      ctx.fillRect(sx - pxW * 0.45, topY, pxW * 0.9, pxH);
      ctx.fillStyle = lm.accent;
      ctx.fillRect(sx - pxW * 0.32, topY + pxH * 0.2, pxW * 0.64, pxH * 0.16);
    }

    const x0 = Math.max(0, sx - pxW * 0.5);
    const x1 = Math.min(width, sx + pxW * 0.5);
    const y0 = Math.max(0, topY);
    const y1 = Math.min(height, botY);
    const bw = (x1 - x0) / width;
    const bh = (y1 - y0) / height;
    if (bw > 0.04 && bh > 0.05 && forward < 240) {
      visibleObjects.push({
        id: lm.id,
        label: lm.label,
        score: Math.max(0.62, Math.min(0.96, 1 - forward / 360)),
        x: x0 / width,
        y: y0 / height,
        w: bw,
        h: bh,
        source: "sim",
      });
    }
  }

  // Headlight warm beam cone overlay when torch is ON
  if (headlightsOn) {
    const beam = ctx.createRadialGradient(
      width * 0.5,
      height * 0.95,
      10,
      width * 0.5,
      height * 0.65,
      width * 0.55
    );
    beam.addColorStop(0, "rgba(255, 251, 224, 0.24)");
    beam.addColorStop(1, "rgba(255, 251, 224, 0)");
    ctx.fillStyle = beam;
    ctx.fillRect(0, 0, width, height);
  }

  // Compute exact 5-sector geometric clearances & front bumper distance
  const sectorAngles = [-26, -13, 0, 13, 26];
  const clearances = sectorAngles.map((deg) => {
    const cm = rayClearanceCm(roverXCm, roverYCm, headingRad + (deg * Math.PI) / 180, 180);
    return Math.max(0, Math.min(1, (cm - 18) / 140));
  }) as [number, number, number, number, number];

  const frontCm = rayClearanceCm(roverXCm, roverYCm, headingRad, 100);
  const frontDistancePct = Math.max(5, Math.min(100, Math.round(frontCm)));

  return {
    visibleObjects,
    frontDistancePct,
    trueCorridors: clearances,
  };
}
