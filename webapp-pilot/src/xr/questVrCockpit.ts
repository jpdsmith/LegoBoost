// SPDX-License-Identifier: MIT
// Zero-Dependency WebXR + WebGL 1/2 Immersive FPV Tank Cockpit for Meta Quest 1 / 2 / 3.
// Renders:
//   1. Giant 88° curved panoramic windshield streaming the Android phone's live WebRTC <video> at 72 FPS
//   2. Floating translucent 3D AR Vision Overlay (5-sector floor clearance lanes, object boxes, steering arcs)
//   3. Angled lower cockpit dashboard with live Mini 2D Room Map, tread gauges, & Touch controller guide
//   4. Subtle dark grounding floor grid for comfortable seated/standing VR with zero motion sickness

import { RoomMapSnapshot, RoverVisionSnapshot } from "../rtc/roverBridge";
import {
  QuestControlSample,
  QuestControllerReader,
  QuestDriveStyle,
  XrInputSourceLike,
} from "./questControllers";

// Minimal WebXR TypeScript interfaces (avoids external @types/webxr dependency)
interface XrPoseTransformLike {
  position: { x: number; y: number; z: number };
  matrix: Float32Array;
}
interface XrViewLike {
  projectionMatrix: Float32Array;
  transform: { inverse: { matrix: Float32Array }; matrix: Float32Array };
}
interface XrViewerPoseLike {
  transform: XrPoseTransformLike;
  views: readonly XrViewLike[];
}
interface XrViewportLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface XrWebGlLayerLike {
  framebuffer: WebGLFramebuffer | null;
  getViewport(view: XrViewLike): XrViewportLike | null;
}
interface XrSessionLike extends EventTarget {
  inputSources: Iterable<XrInputSourceLike>;
  renderState: { baseLayer?: XrWebGlLayerLike | null };
  updateRenderState(state: { baseLayer: XrWebGlLayerLike }): void;
  requestReferenceSpace(type: string): Promise<unknown>;
  requestAnimationFrame(cb: (time: number, frame: XrFrameLike) => void): number;
  end(): Promise<void>;
}
interface XrFrameLike {
  session: XrSessionLike;
  getViewerPose(refSpace: unknown): XrViewerPoseLike | null;
}
interface XrSystemLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: { optionalFeatures?: string[] }): Promise<XrSessionLike>;
}

export interface VrHudState {
  videoConnected: boolean;
  bleConnected: boolean;
  assistMode: string;
  explorerState: string;
  assistIntervening: string;
  assistNote: string;
  driveStyle: QuestDriveStyle;
  speedCap: number;
  leftMotor: number;
  rightMotor: number;
  steer: number;
  frontDistPct: number | null;
  batteryPct: number | null;
  headingDeg: number | null;
  headlightsOn: boolean;
  pingMs: number | null;
  vision: RoverVisionSnapshot | null;
  map: RoomMapSnapshot | null;
}

export function isMetaQuestBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /OculusBrowser|Quest/i.test(ua);
}

export async function checkWebXrVrSupported(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const xr = (navigator as unknown as { xr?: XrSystemLike }).xr;
  if (!xr?.isSessionSupported) return false;
  try {
    return await xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

/**
 * Extract horizontal yaw angle (radians) from a column-major 4x4 WebXR viewer transform matrix.
 * Facing straight -Z returns 0; turning right (+X) returns +PI/2.
 */
export function extractViewerYawRad(matrix: ArrayLike<number>): number {
  const fx = -(matrix[8] ?? 0);
  const fz = -(matrix[10] ?? 1);
  if (Math.hypot(fx, fz) < 1e-4) return 0;
  return Math.atan2(fx, -fz);
}

/**
 * Build a column-major 4x4 model matrix placing the VR cockpit centered at (vx, vy, vz)
 * rotated around +Y by yawRad so its local -Z screen sits directly ahead of the viewer.
 */
export function buildCockpitModelMatrix(
  vx: number,
  vy: number,
  vz: number,
  yawRad: number
): Float32Array {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  // Column-major: col0 = (c, 0, s, 0), col1 = (0, 1, 0, 0), col2 = (-s, 0, c, 0), col3 = (vx, vy, vz, 1)
  return new Float32Array([
    c, 0, s, 0,
    0, 1, 0, 0,
    -s, 0, c, 0,
    vx, vy, vz, 1,
  ]);
}

function multiplyMat4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export interface CurvedMeshData {
  /** Interleaved [x, y, z, u, v] vertices */
  vertices: Float32Array;
  indices: Uint16Array;
}

/**
 * Generate a gently curved cylindrical cockpit display mesh facing inward toward the pilot.
 * Optionally tilts vertically around its horizontal centerline (tiltXRad < 0 tilts top away like a car dash).
 */
export function buildCurvedScreenGeometry(params: {
  radius: number;
  arcRad: number;
  height: number;
  centerY: number;
  tiltXRad?: number;
  segments?: number;
}): CurvedMeshData {
  const segs = Math.max(4, params.segments ?? 28);
  const tilt = params.tiltXRad ?? 0;
  const halfH = params.height / 2;
  const verts = new Float32Array((segs + 1) * 2 * 5);
  const indices = new Uint16Array(segs * 6);

  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);

  let vp = 0;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const theta = -params.arcRad / 2 + u * params.arcRad;
    const sinA = Math.sin(theta);
    const cosA = Math.cos(theta);

    for (let row = 0; row < 2; row++) {
      const v = row; // 0 = top, 1 = bottom
      const localY = row === 0 ? halfH : -halfH;
      // Tilt panel around its radial arc centerline
      const dy = localY * cosT;
      const dr = localY * sinT;
      const r = params.radius + dr;

      verts[vp++] = r * sinA;
      verts[vp++] = params.centerY + dy;
      verts[vp++] = -r * cosA;
      verts[vp++] = u;
      verts[vp++] = v;
    }
  }

  let ip = 0;
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices[ip++] = a;
    indices[ip++] = b;
    indices[ip++] = c;
    indices[ip++] = c;
    indices[ip++] = b;
    indices[ip++] = d;
  }

  return { vertices: verts, indices };
}

function buildFloorGridVertices(y: number): Float32Array {
  const pts: number[] = [];
  const extent = 4.0;
  const step = 0.5;
  for (let g = -extent; g <= extent + 0.001; g += step) {
    pts.push(g, y, -extent, g, y, extent);
    pts.push(-extent, y, g, extent, y, g);
  }
  return new Float32Array(pts);
}

const VERT_TEX = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform mat4 uMvp;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`;

const FRAG_TEX = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}
`;

const VERT_LINE = `
attribute vec3 aPos;
uniform mat4 uMvp;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`;

const FRAG_LINE = `
precision mediump float;
uniform vec4 uColor;
void main() {
  gl_FragColor = uColor;
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("WebGL shader creation failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh) || "compile error";
    gl.deleteShader(sh);
    throw new Error(`Shader error: ${info}`);
  }
  return sh;
}

function createProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error("WebGL program creation failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog) || "link error";
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${info}`);
  }
  return prog;
}

function createGlTexture(gl: WebGLRenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("WebGL texture creation failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Seed 1x1 dark pixel so texture is complete immediately
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([15, 20, 29, 255])
  );
  return tex;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Draw the floating translucent AR overlay placed directly over the curved live video windshield.
 */
function renderArOverlayCanvas(canvas: HTMLCanvasElement, state: VrHudState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Subtle corner cockpit frame ticks
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = 2;
  const m = 10;
  const cLen = 22;
  for (const [cx, cy, dx, dy] of [
    [m, m, cLen, cLen],
    [w - m, m, -cLen, cLen],
    [m, h - m, cLen, -cLen],
    [w - m, h - m, -cLen, -cLen],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy);
    ctx.stroke();
  }

  // If no live camera video yet, show clear guidance right on the curved VR windshield
  if (!state.videoConnected) {
    ctx.fillStyle = "rgba(15, 20, 29, 0.86)";
    drawRoundedRect(ctx, w * 0.14, h * 0.28, w * 0.72, h * 0.44, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(56, 189, 248, 0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#F8FAFC";
    ctx.font = "bold 24px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Quest VR Cockpit Ready", w / 2, h * 0.46);
    ctx.fillStyle = "#CBD5E1";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("Pair with your Android Phone on the FPV Rover screen to view live video.", w / 2, h * 0.56);
    ctx.fillStyle = "#38BDF8";
    ctx.font = "bold 14px ui-monospace, monospace";
    ctx.fillText("Press Right B to STOP · Press Oculus Menu to exit VR", w / 2, h * 0.65);
    return;
  }

  // 5-Sector floor clearance fan
  if (state.vision) {
    const corridors = state.vision.corridors;
    for (let i = 0; i < 5; i++) {
      const clr = corridors[i];
      const topY = h * (0.9 - clr * 0.44);
      const x0 = (i / 5) * w + 6;
      const x1 = ((i + 1) / 5) * w - 6;
      const fill =
        clr < 0.26
          ? "rgba(239, 68, 68, 0.26)"
          : clr < 0.52
            ? "rgba(245, 158, 11, 0.22)"
            : "rgba(34, 197, 94, 0.16)";
      const stroke =
        clr < 0.26 ? "#F87171" : clr < 0.52 ? "#FBBF24" : "#4ADE80";
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.fillRect(x0, topY, x1 - x0, h * 0.94 - topY);
      ctx.strokeRect(x0, topY, x1 - x0, h * 0.94 - topY);
    }

    // Object boxes
    for (const box of state.vision.objects) {
      const isLocked = state.vision.lockedTarget?.id === box.id;
      const bx = box.x * w;
      const by = box.y * h;
      const bw = box.w * w;
      const bh = box.h * h;
      ctx.strokeStyle = isLocked ? "#F59E0B" : "#38BDF8";
      ctx.lineWidth = isLocked ? 3 : 2;
      ctx.strokeRect(bx, by, bw, bh);

      const label = `${box.label} ${Math.round(box.score * 100)}%`;
      ctx.font = "bold 12px ui-monospace, monospace";
      const tw = ctx.measureText(label).width + 12;
      const ly = by < 24 ? by + 4 : by - 22;
      ctx.fillStyle = isLocked ? "#F59E0B" : "rgba(15, 20, 29, 0.82)";
      ctx.fillRect(bx, ly, tw, 18);
      ctx.fillStyle = isLocked ? "#111827" : "#F8FAFC";
      ctx.textAlign = "left";
      ctx.fillText(label, bx + 6, ly + 13);
    }
  }

  // Predictive steering arcs
  const curve = state.steer * 145;
  const arcColor =
    state.frontDistPct !== null && state.frontDistPct <= 24
      ? "#F87171"
      : state.frontDistPct !== null && state.frontDistPct <= 48
        ? "#FBBF24"
        : "#38BDF8";
  ctx.strokeStyle = arcColor;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(w * 0.3, h * 0.96);
  ctx.quadraticCurveTo(w * 0.36 + curve * 0.45, h * 0.72, w * 0.41 + curve, h * 0.56);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.7, h * 0.96);
  ctx.quadraticCurveTo(w * 0.64 + curve * 0.45, h * 0.72, w * 0.59 + curve, h * 0.56);
  ctx.stroke();

  // Top Visor Status Pills
  const modeLabel =
    state.assistMode === "explorer"
      ? `EXPLORER · ${state.explorerState}`
      : state.assistMode === "copilot"
        ? "SMART CO-PILOT"
        : "MANUAL FPV";
  const modeBg =
    state.assistIntervening === "braking"
      ? "#DC2626"
      : state.assistIntervening === "dodging" || state.assistMode === "explorer"
        ? "#D97706"
        : state.assistMode === "copilot"
          ? "#16A34A"
          : "#0284C7";

  const drawPill = (x: number, text: string, bg: string, alignRight = false) => {
    ctx.font = "bold 13px ui-monospace, monospace";
    const pw = ctx.measureText(text).width + 20;
    const px = alignRight ? x - pw : x;
    ctx.fillStyle = bg;
    drawRoundedRect(ctx, px, 16, pw, 26, 13);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    ctx.fillText(text, px + 10, 34);
    return pw + 8;
  };

  let lx = 18;
  lx += drawPill(lx, modeLabel, modeBg);
  if (state.headingDeg !== null) {
    lx += drawPill(lx, `HDG ${Math.round(state.headingDeg)}°`, "rgba(15, 20, 29, 0.82)");
  }
  if (state.headlightsOn) {
    drawPill(lx, "LIGHTS ON", "#D97706");
  }

  let rx = w - 18;
  if (state.batteryPct !== null) {
    rx -= drawPill(rx, `BATT ${state.batteryPct}%`, "rgba(15, 20, 29, 0.82)", true);
  }
  if (state.frontDistPct !== null) {
    const dBg =
      state.frontDistPct <= 22 ? "#DC2626" : state.frontDistPct <= 50 ? "#D97706" : "#16A34A";
    rx -= drawPill(rx, `FRONT ${state.frontDistPct}%`, dBg, true);
  }
  if (state.pingMs !== null) {
    drawPill(rx, `${state.pingMs} ms`, "rgba(15, 20, 29, 0.82)", true);
  }
}

/**
 * Draw the angled lower VR Cockpit Instrument Dashboard (Mini 2D Map + Gauges + Touch Legend).
 */
export function drawVrHudDashboard(canvas: HTMLCanvasElement, state: VrHudState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  // Matte dark hardware console frame
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(15, 20, 29, 0.94)";
  drawRoundedRect(ctx, 4, 4, w - 8, h - 8, 20);
  ctx.fill();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.32)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // --- LEFT MODULE: MINI 2D ROOM RADAR MAP ---
  const mapX = 18;
  const mapY = 18;
  const mapS = h - 36;
  ctx.fillStyle = "#090D14";
  drawRoundedRect(ctx, mapX, mapY, mapS, mapS, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.25)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const cx = mapX + mapS / 2;
  const cy = mapY + mapS / 2;
  ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
  ctx.lineWidth = 1;
  for (const r of [mapS * 0.16, mapS * 0.31, mapS * 0.45]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (state.map) {
    const cellPx = mapS / state.map.gridSize;
    ctx.fillStyle = "rgba(34, 197, 94, 0.38)";
    for (const [gx, gy] of state.map.visited) {
      ctx.fillRect(mapX + gx * cellPx - 1, mapY + gy * cellPx - 1, cellPx + 2, cellPx + 2);
    }
    ctx.fillStyle = "#F59E0B";
    for (const [gx, gy] of state.map.obstacles) {
      ctx.fillRect(mapX + gx * cellPx, mapY + gy * cellPx, Math.max(2, cellPx), Math.max(2, cellPx));
    }
    const rx = mapX + state.map.robotX * cellPx;
    const ry = mapY + state.map.robotY * cellPx;
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate((state.map.headingDeg * Math.PI) / 180);
    ctx.fillStyle = "#F97316";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // --- CENTER MODULE: TREAD GAUGES, SPEED CAP & STATUS ---
  const midX = mapX + mapS + 22;
  const midW = 290;
  ctx.fillStyle = "#94A3B8";
  ctx.font = "bold 11px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(
    `DRIVE: ${state.driveStyle === "twin-stick" ? "TWIN-STICK TANK" : "ARCADE / TRIGGERS"}   ·   CAP ${state.speedCap}%`,
    midX,
    34
  );

  // Left & Right tread bars
  const drawTreadBar = (y: number, label: string, val: number) => {
    ctx.fillStyle = "#CBD5E1";
    ctx.font = "bold 12px ui-monospace, monospace";
    ctx.fillText(label, midX, y + 14);
    const bx = midX + 54;
    const bw = midW - 108;
    ctx.fillStyle = "#1E293B";
    drawRoundedRect(ctx, bx, y, bw, 18, 6);
    ctx.fill();
    const mid = bx + bw / 2;
    const fillW = (Math.max(-100, Math.min(100, val)) / 100) * (bw / 2);
    ctx.fillStyle = val >= 0 ? "#22C55E" : "#F59E0B";
    if (fillW >= 0) ctx.fillRect(mid, y + 2, fillW, 14);
    else ctx.fillRect(mid + fillW, y + 2, -fillW, 14);
    ctx.fillStyle = "#F8FAFC";
    ctx.textAlign = "right";
    ctx.fillText(`${val}%`, midX + midW, y + 14);
    ctx.textAlign = "left";
  };

  drawTreadBar(48, "LEFT", state.leftMotor);
  drawTreadBar(76, "RIGHT", state.rightMotor);

  // Live assist / explorer status
  ctx.fillStyle = "rgba(30, 41, 59, 0.9)";
  drawRoundedRect(ctx, midX, 110, midW, 56, 10);
  ctx.fill();
  ctx.fillStyle = state.bleConnected ? "#4ADE80" : "#FBBF24";
  ctx.font = "bold 11px ui-monospace, monospace";
  ctx.fillText(
    state.bleConnected ? "MOVE HUB BLUETOOTH: READY" : "CONNECT MOVE HUB ON PHONE",
    midX + 12,
    130
  );
  ctx.fillStyle = "#E2E8F0";
  ctx.font = "12px system-ui, sans-serif";
  const noteTrim = state.assistNote.length > 42 ? `${state.assistNote.slice(0, 40)}…` : state.assistNote;
  ctx.fillText(noteTrim, midX + 12, 152);

  if (state.map) {
    ctx.fillStyle = "#94A3B8";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(
      `MAP: ${state.map.coveragePct}% EXPLORED · ${state.map.distanceMeters} m`,
      midX,
      192
    );
  }

  // --- RIGHT MODULE: OCULUS TOUCH CONTROLLER GUIDE ---
  const rightX = midX + midW + 24;
  ctx.fillStyle = "#38BDF8";
  ctx.font = "bold 12px ui-monospace, monospace";
  ctx.fillText("QUEST HAND CONTROLLERS", rightX, 34);

  const lines: Array<[string, string, string]> = [
    ["L-STICK / RT·LT", "Drive & Steer", "#E2E8F0"],
    ["R-STICK", "Turret / R-Click Recenter", "#CBD5E1"],
    ["RIGHT B", "EMERGENCY STOP", "#F87171"],
    ["RIGHT A", "Horn / Chirp", "#4ADE80"],
    ["LEFT X / Y", "Headlights / AI Mode", "#FBBF24"],
    ["L / R GRIPS", "Speed Down / Up", "#CBD5E1"],
    ["L-CLICK", "Arcade ↔ Twin-Stick Tank", "#38BDF8"],
  ];

  let ly = 56;
  for (const [key, desc, color] of lines) {
    ctx.fillStyle = color;
    ctx.font = "bold 11px ui-monospace, monospace";
    ctx.fillText(key, rightX, ly);
    ctx.fillStyle = "#94A3B8";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(desc, rightX + 108, ly);
    ly += 21;
  }
}

export interface QuestVrSessionCallbacks {
  getVideoElement: () => HTMLVideoElement | null;
  getHudState: () => VrHudState;
  onControlFrame: (sample: QuestControlSample) => void;
  onSessionEnd: () => void;
  onError?: (message: string) => void;
}

export class QuestVrCockpitSession {
  private session: XrSessionLike | null = null;
  private readonly controllerReader = new QuestControllerReader();
  private anchored = false;
  private anchorPos = { x: 0, y: 1.45, z: 0 };
  private anchorYawRad = 0;
  private lastHudDrawMs = -1000;
  private lastControlSendMs = -1000;

  isActive(): boolean {
    return this.session !== null;
  }

  recenter(): void {
    this.anchored = false;
  }

  pulseHaptics(hand: "left" | "right" | "both", intensity = 0.45, durationMs = 55): void {
    if (!this.session) return;
    this.controllerReader.pulseHaptics(this.session.inputSources, hand, intensity, durationMs);
  }

  async start(callbacks: QuestVrSessionCallbacks): Promise<void> {
    if (this.session) return;
    const xr = (navigator as unknown as { xr?: XrSystemLike }).xr;
    if (!xr) {
      throw new Error("WebXR is not available in this browser.");
    }

    const session = await xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor", "bounded-floor"],
    });
    this.session = session;
    this.anchored = false;
    this.controllerReader.reset();

    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2", { alpha: false, antialias: true, xrCompatible: true }) as WebGLRenderingContext | null) ??
      (canvas.getContext("webgl", { alpha: false, antialias: true, xrCompatible: true }) as WebGLRenderingContext | null);
    if (!gl) {
      await session.end();
      this.session = null;
      throw new Error("Unable to initialize WebGL for VR cockpit.");
    }

    const xrGl = gl as WebGLRenderingContext & { makeXRCompatible?: () => Promise<void> };
    if (typeof xrGl.makeXRCompatible === "function") {
      await xrGl.makeXRCompatible();
    }

    const XRWebGLLayerCtor = (
      window as unknown as {
        XRWebGLLayer: new (s: XrSessionLike, ctx: WebGLRenderingContext) => XrWebGlLayerLike;
      }
    ).XRWebGLLayer;
    const layer = new XRWebGLLayerCtor(session, gl);
    session.updateRenderState({ baseLayer: layer });

    // Quest 1 graceful reference space fallback: local-floor -> local
    let refSpace: unknown;
    try {
      refSpace = await session.requestReferenceSpace("local-floor");
    } catch {
      refSpace = await session.requestReferenceSpace("local");
    }

    // Build WebGL programs, curved meshes, floor grid, and dynamic textures
    const texProg = createProgram(gl, VERT_TEX, FRAG_TEX);
    const lineProg = createProgram(gl, VERT_LINE, FRAG_LINE);

    const aTexPos = gl.getAttribLocation(texProg, "aPos");
    const aTexUv = gl.getAttribLocation(texProg, "aUv");
    const uTexMvp = gl.getUniformLocation(texProg, "uMvp");
    const uTexSampler = gl.getUniformLocation(texProg, "uTex");

    const aLinePos = gl.getAttribLocation(lineProg, "aPos");
    const uLineMvp = gl.getUniformLocation(lineProg, "uMvp");
    const uLineColor = gl.getUniformLocation(lineProg, "uColor");

    const uploadMesh = (mesh: CurvedMeshData) => {
      const vbo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      const ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      return { vbo, ibo, count: mesh.indices.length };
    };

    // 1. Curved Panoramic Video Windshield (88° wide, 16:9, 2.2m away)
    const videoMesh = uploadMesh(
      buildCurvedScreenGeometry({
        radius: 2.2,
        arcRad: (88 * Math.PI) / 180,
        height: 1.9,
        centerY: 0.08,
        segments: 32,
      })
    );
    // 2. Floating AR Vision Overlay slightly in front of video windshield
    const arMesh = uploadMesh(
      buildCurvedScreenGeometry({
        radius: 2.13,
        arcRad: (88 * Math.PI) / 180,
        height: 1.84,
        centerY: 0.08,
        segments: 32,
      })
    );
    // 3. Angled Lower Instrument Dashboard (Map + Gauges + Controller Guide)
    const dashMesh = uploadMesh(
      buildCurvedScreenGeometry({
        radius: 1.88,
        arcRad: (66 * Math.PI) / 180,
        height: 0.54,
        centerY: -0.82,
        tiltXRad: -0.44,
        segments: 24,
      })
    );
    // 4. Spatial cockpit grounding floor grid
    const gridVerts = buildFloorGridVertices(-1.35);
    const gridVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
    gl.bufferData(gl.ARRAY_BUFFER, gridVerts, gl.STATIC_DRAW);
    const gridVertexCount = gridVerts.length / 3;

    const videoTex = createGlTexture(gl);
    const arTex = createGlTexture(gl);
    const dashTex = createGlTexture(gl);

    const arCanvas = document.createElement("canvas");
    arCanvas.width = 640;
    arCanvas.height = 360;

    const dashCanvas = document.createElement("canvas");
    dashCanvas.width = 768;
    dashCanvas.height = 224;

    const drawTexturedMesh = (
      mesh: { vbo: WebGLBuffer; ibo: WebGLBuffer; count: number },
      tex: WebGLTexture,
      mvp: Float32Array
    ) => {
      gl.useProgram(texProg);
      gl.uniformMatrix4fv(uTexMvp, false, mvp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uTexSampler, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.enableVertexAttribArray(aTexPos);
      gl.vertexAttribPointer(aTexPos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(aTexUv);
      gl.vertexAttribPointer(aTexUv, 2, gl.FLOAT, false, 20, 12);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    };

    const cleanup = () => {
      this.session = null;
      callbacks.onSessionEnd();
    };
    session.addEventListener("end", cleanup);

    const onFrame = (timeMs: number, frame: XrFrameLike) => {
      if (!this.session) return;
      session.requestAnimationFrame(onFrame);

      const pose = frame.getViewerPose(refSpace);
      if (!pose) return;

      // Anchor cockpit centered on viewer's comfortable eye height & heading on entry or recenter
      if (!this.anchored) {
        this.anchored = true;
        this.anchorPos = {
          x: pose.transform.position.x,
          y: pose.transform.position.y,
          z: pose.transform.position.z,
        };
        this.anchorYawRad = extractViewerYawRad(pose.transform.matrix);
      }

      // Poll Quest Touch hand controllers (~20 Hz drive cadence to avoid flooding Wi-Fi/BLE)
      const hudState = callbacks.getHudState();
      if (timeMs - this.lastControlSendMs >= 50) {
        this.lastControlSendMs = timeMs;
        const sample = this.controllerReader.poll(session.inputSources, hudState.speedCap);
        if (sample.actions.includes("recenter")) {
          this.anchored = false;
          this.pulseHaptics("right", 0.35, 45);
        }
        if (sample.actions.includes("stop")) {
          this.pulseHaptics("both", 0.8, 120);
        } else if (sample.actions.length > 0) {
          this.pulseHaptics("both", 0.3, 40);
        }
        callbacks.onControlFrame(sample);
      }

      // Upload live phone WebRTC video frame directly on GPU (72 FPS!)
      const videoEl = callbacks.getVideoElement();
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        gl.bindTexture(gl.TEXTURE_2D, videoTex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
        } catch {
          // ignore transient video frame race
        }
      }

      // Refresh AR overlay & lower dashboard canvases at 10 Hz
      if (timeMs - this.lastHudDrawMs >= 100) {
        this.lastHudDrawMs = timeMs;
        const nextHud: VrHudState = {
          ...hudState,
          driveStyle: this.controllerReader.getDriveStyle(),
        };
        renderArOverlayCanvas(arCanvas, nextHud);
        gl.bindTexture(gl.TEXTURE_2D, arTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, arCanvas);

        drawVrHudDashboard(dashCanvas, nextHud);
        gl.bindTexture(gl.TEXTURE_2D, dashTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dashCanvas);
      }

      const baseLayer = session.renderState.baseLayer;
      if (!baseLayer) return;

      gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
      gl.clearColor(0.035, 0.048, 0.075, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      const modelMat = buildCockpitModelMatrix(
        this.anchorPos.x,
        this.anchorPos.y,
        this.anchorPos.z,
        this.anchorYawRad
      );

      for (const view of pose.views) {
        const vp = baseLayer.getViewport(view);
        if (!vp) continue;
        gl.viewport(vp.x, vp.y, vp.width, vp.height);

        const viewModel = multiplyMat4(view.transform.inverse.matrix, modelMat);
        const mvp = multiplyMat4(view.projectionMatrix, viewModel);

        // Grounding floor grid lines
        gl.disable(gl.BLEND);
        gl.useProgram(lineProg);
        gl.uniformMatrix4fv(uLineMvp, false, mvp);
        gl.uniform4f(uLineColor, 0.16, 0.24, 0.36, 1.0);
        gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
        gl.enableVertexAttribArray(aLinePos);
        gl.vertexAttribPointer(aLinePos, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, gridVertexCount);

        // Opaque curved live camera windshield
        drawTexturedMesh(videoMesh, videoTex, mvp);

        // Translucent floating AR vision overlay & lower cockpit dashboard
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        drawTexturedMesh(arMesh, arTex, mvp);
        drawTexturedMesh(dashMesh, dashTex, mvp);
        gl.depthMask(true);
      }
    };

    session.requestAnimationFrame(onFrame);
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    try {
      await s.end();
    } catch {
      // already ended
    }
  }
}
