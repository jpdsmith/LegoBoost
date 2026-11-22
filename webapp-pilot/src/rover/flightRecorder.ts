// SPDX-License-Identifier: MIT
// Black-Box Flight Recorder, Annotated Contact Sheet Renderer & Zero-Dependency ZIP Bundler
// for real-life LEGO BOOST + Pixel Fold Autonomous Explorer test runs.
//
// Captures:
//   - 10 Hz structured `telemetry.jsonl` (vision, floor model, optical flow, AI boxes, Move Hub
//     encoders/speeds/88007 distance/battery/IMU flags, Pixel Fold gyro/mount tilt, map pose, motor cmd)
//   - Automatic event snapshots (AVOIDING, UNSTICKING, BUMP, DISCOVERY, LOW_BATTERY, periodic cruise)
//   - 1-tap User Problem Tags ("Hit Obstacle", "Clipped Right", "False Wall", "Stuck/Spin", "Bad Turn", "Good Dodge")
//   - Raw + HUD-annotated JPEGs for both visual inspection AND offline vision replay
//   - Single-image `contact-sheet.png` visual storyboard + `summary.md` KPI scorecard
//   - Zero-dependency `.zip` bundle export + Android Web Share (`navigator.share({ files })`)

import { ExplorerMission, PilotAssistMode, RoomMapSnapshot } from "../rtc/roverBridge";
import { computeSweptBumperBounds, MountCalibration } from "../vision/roverVision";
import { HeadingSource } from "./foldHeading";

export type ProblemTagKind =
  | "hit-obstacle"
  | "clipped-right"
  | "false-wall"
  | "stuck-spin"
  | "bad-turn"
  | "good-dodge";

export const PROBLEM_TAGS: Array<{ id: ProblemTagKind; label: string; short: string; tone: "danger" | "warn" | "good" }> = [
  { id: "hit-obstacle", label: "Hit Obstacle", short: "HIT", tone: "danger" },
  { id: "clipped-right", label: "Clipped Right", short: "R-CLIP", tone: "danger" },
  { id: "false-wall", label: "False Wall", short: "SHADOW", tone: "warn" },
  { id: "stuck-spin", label: "Stuck / Spin", short: "STUCK", tone: "warn" },
  { id: "bad-turn", label: "Bad Turn", short: "TURN", tone: "warn" },
  { id: "good-dodge", label: "Good Dodge", short: "GOOD", tone: "good" },
];

export type FlightEventKind =
  | "RUN_START"
  | "AVOIDING_ENTER"
  | "UNSTICKING_ENTER"
  | "BUMP"
  | "DISCOVERY"
  | "MANUAL_OVERRIDE"
  | "ENCODER_SATURATED"
  | "LOW_BATTERY"
  | "PERIODIC"
  | "USER_TAG"
  | "RUN_STOP";

export interface FlightTickRecord {
  tMs: number;
  iso: string;
  assistMode: PilotAssistMode;
  mission: ExplorerMission;
  fsmState: string;
  statusNote: string;
  corridors: [number, number, number, number, number];
  horizonYs: [number, number, number, number, number];
  sweptClear: number;
  bestSteer: number;
  floorRgb: [number, number, number];
  floorNoise: number;
  avgLuma: number;
  floorPatch?: { x: number; y: number; w: number; h: number };
  flowForward: number;
  flowTurn: number;
  flowConfidence: number;
  validPatches: number;
  objects: Array<{ label: string; score: number; x: number; y: number; w: number; h: number; source: string }>;
  hw: {
    bleConnected: boolean;
    batteryMv: number | null;
    distPct: number | null;
    colorId: number | null;
    pitch: number | null;
    roll: number | null;
    flags: number | null;
    bump: boolean;
    pickedUp: boolean;
    safeMode: boolean;
    sensorOk: boolean;
    encA: number;
    encB: number;
    speedA: number;
    speedB: number;
  };
  phone: {
    headingDeg: number | null;
    yawRateDegS: number;
    headingSource: HeadingSource;
    mountPitchDeg: number | null;
    mountRollDeg: number | null;
    rawAlpha: number | null;
    rawBeta: number | null;
    rawGamma: number | null;
    torchOn: boolean;
    visionMs: number;
    aiReady: boolean;
  };
  map: {
    xCm: number;
    yCm: number;
    headingDeg: number;
    frontierBias: number;
    coveragePct: number;
    distanceM: number;
    encSaturated: boolean;
  };
  cmd: {
    left: number;
    right: number;
    steer: number;
    throttle: number;
    recoveries: number;
  };
}

export interface FlightEventRecord {
  id: number;
  tMs: number;
  iso: string;
  kind: FlightEventKind;
  tag?: ProblemTagKind;
  label: string;
  fsmState: string;
  frontDistPct: number | null;
  corridors: [number, number, number, number, number];
  sweptClear: number;
  flowForward: number;
  cmdLeft: number;
  cmdRight: number;
  /** Clean unannotated camera JPEG data URL (for offline vision replay!) */
  rawFrameDataUrl?: string;
  /** Annotated diagnostic JPEG data URL (with corridors, asymmetric bumper rails, floor patch) */
  annotatedFrameDataUrl?: string;
}

export interface FlightRunStats {
  recording: boolean;
  startedAtIso: string | null;
  durationSec: number;
  tickCount: number;
  eventCount: number;
  userTagCount: number;
  keyframeCount: number;
  cruisingPct: number;
  avoidingPct: number;
  unstickingPct: number;
  bumpCount: number;
  unstickCount: number;
  discoveryCount: number;
  overrideCount: number;
  encoderSaturated: boolean;
  lowBatterySeen: boolean;
  batteryStartMv: number | null;
  batteryEndMv: number | null;
  batteryMinMv: number | null;
  visionMsP50: number;
  visionMsP95: number;
  distanceMeters: number;
  coveragePct: number;
  headingSource: HeadingSource;
}

const MAX_TICKS = 6000; // ~10 minutes @ 10 Hz
const MAX_KEYFRAME_EVENTS = 24;
const PERIODIC_SNAPSHOT_INTERVAL_MS = 6500;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatRunTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return Number(sorted[idx].toFixed(1));
}

// ============================================================================
// Zero-Dependency IEEE CRC-32 + Standard Uncompressed (STORE) ZIP Writer
// ============================================================================

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32Bytes(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

/**
 * Create a standard PKWARE-compliant uncompressed (STORE) ZIP archive in pure TypeScript.
 * Opens natively in Python `zipfile`, Android Files, ChromeOS, macOS, and Windows.
 */
export function createStoreZip(entries: ZipEntryInput[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32Bytes(entry.data);
    return { nameBytes, data: entry.data, crc };
  });

  let localTotal = 0;
  let cdTotal = 0;
  for (const item of prepared) {
    localTotal += 30 + item.nameBytes.length + item.data.length;
    cdTotal += 46 + item.nameBytes.length;
  }

  const out = new Uint8Array(localTotal + cdTotal + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let ptr = 0;

  // 1. Local file headers + payloads
  for (const item of prepared) {
    offsets.push(ptr);
    view.setUint32(ptr, 0x04034b50, true);
    view.setUint16(ptr + 4, 20, true); // version needed
    view.setUint16(ptr + 6, 0x0800, true); // UTF-8 flag
    view.setUint16(ptr + 8, 0, true); // compression: STORE
    view.setUint16(ptr + 10, dosTime, true);
    view.setUint16(ptr + 12, dosDate, true);
    view.setUint32(ptr + 14, item.crc, true);
    view.setUint32(ptr + 18, item.data.length, true);
    view.setUint32(ptr + 22, item.data.length, true);
    view.setUint16(ptr + 26, item.nameBytes.length, true);
    view.setUint16(ptr + 28, 0, true);
    ptr += 30;
    out.set(item.nameBytes, ptr);
    ptr += item.nameBytes.length;
    out.set(item.data, ptr);
    ptr += item.data.length;
  }

  // 2. Central directory records
  const cdStart = ptr;
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    view.setUint32(ptr, 0x02014b50, true);
    view.setUint16(ptr + 4, 20, true); // version made by
    view.setUint16(ptr + 6, 20, true); // version needed
    view.setUint16(ptr + 8, 0x0800, true); // UTF-8
    view.setUint16(ptr + 10, 0, true); // STORE
    view.setUint16(ptr + 12, dosTime, true);
    view.setUint16(ptr + 14, dosDate, true);
    view.setUint32(ptr + 16, item.crc, true);
    view.setUint32(ptr + 20, item.data.length, true);
    view.setUint32(ptr + 24, item.data.length, true);
    view.setUint16(ptr + 28, item.nameBytes.length, true);
    view.setUint16(ptr + 30, 0, true);
    view.setUint16(ptr + 32, 0, true);
    view.setUint16(ptr + 34, 0, true);
    view.setUint16(ptr + 36, 0, true);
    view.setUint32(ptr + 38, 0, true);
    view.setUint32(ptr + 42, offsets[i], true);
    ptr += 46;
    out.set(item.nameBytes, ptr);
    ptr += item.nameBytes.length;
  }

  // 3. End of central directory record
  view.setUint32(ptr, 0x06054b50, true);
  view.setUint16(ptr + 4, 0, true);
  view.setUint16(ptr + 6, 0, true);
  view.setUint16(ptr + 8, prepared.length, true);
  view.setUint16(ptr + 10, prepared.length, true);
  view.setUint32(ptr + 12, cdTotal, true);
  view.setUint32(ptr + 16, cdStart, true);
  view.setUint16(ptr + 20, 0, true);

  return out;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const b64 = dataUrl.slice(comma + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

// ============================================================================
// Annotated Diagnostic Frame & Contact Sheet Renderer
// ============================================================================

function corridorFillRgba(clr: number): string {
  if (clr < 0.25) return "rgba(239, 68, 68, 0.36)";
  if (clr < 0.5) return "rgba(245, 158, 11, 0.28)";
  return "rgba(34, 197, 94, 0.22)";
}

function corridorStrokeRgba(clr: number): string {
  if (clr < 0.25) return "rgba(248, 113, 113, 0.9)";
  if (clr < 0.5) return "rgba(251, 191, 36, 0.9)";
  return "rgba(74, 222, 128, 0.85)";
}

/**
 * Capture BOTH a clean raw camera JPEG (for offline replay) AND a diagnostic HUD-annotated JPEG
 * showing the 5 corridors, asymmetric left-offset bumper rails, floor sample box, and AI boxes.
 */
export function captureAnnotatedEventFrames(
  video: HTMLVideoElement | null,
  tick: FlightTickRecord,
  cal: MountCalibration,
  caption: string
): { rawFrameDataUrl?: string; annotatedFrameDataUrl?: string } {
  if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return {};
  }
  try {
    const w = 320;
    const h = clamp(Math.round((video.videoHeight / video.videoWidth) * w), 160, 320);

    const rawCanvas = document.createElement("canvas");
    rawCanvas.width = w;
    rawCanvas.height = h;
    const rawCtx = rawCanvas.getContext("2d");
    if (!rawCtx) return {};
    rawCtx.drawImage(video, 0, 0, w, h);
    const rawFrameDataUrl = rawCanvas.toDataURL("image/jpeg", 0.72);

    const annCanvas = document.createElement("canvas");
    annCanvas.width = w;
    annCanvas.height = h;
    const ctx = annCanvas.getContext("2d");
    if (!ctx) return { rawFrameDataUrl };
    ctx.drawImage(rawCanvas, 0, 0);

    // 1. 5-Sector floor clearance bars using real horizonYs
    const bottomY = Math.round(cal.bumperMaskY * h);
    for (let s = 0; s < 5; s++) {
      const clr = tick.corridors[s];
      const topY = Math.round((tick.horizonYs[s] ?? cal.bumperMaskY - clr * 0.45) * h);
      const x0 = Math.round((s / 5) * w) + 2;
      const x1 = Math.round(((s + 1) / 5) * w) - 2;
      ctx.fillStyle = corridorFillRgba(clr);
      ctx.fillRect(x0, topY, x1 - x0, Math.max(2, bottomY - topY));
      ctx.strokeStyle = corridorStrokeRgba(clr);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, topY);
      ctx.lineTo(x1, topY);
      ctx.stroke();
    }

    // 2. Asymmetric swept-bumper rails (shows exact left-offset camera chassis width!)
    const nearB = computeSweptBumperBounds(cal, 0);
    const midB = computeSweptBumperBounds(cal, 0.45);
    const farB = computeSweptBumperBounds(cal, 1);
    const yNear = cal.bumperMaskY * h;
    const yMid = (cal.bumperMaskY - (cal.bumperMaskY - cal.horizonY) * 0.45) * h;
    const yFar = cal.horizonY * h;

    ctx.save();
    ctx.strokeStyle = tick.sweptClear < 0.28 ? "#ef4444" : "#38bdf8";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    // Left tread rail
    ctx.beginPath();
    ctx.moveTo(nearB.uLeft * w, yNear);
    ctx.lineTo(midB.uLeft * w, yMid);
    ctx.lineTo(farB.uLeft * w, yFar);
    ctx.stroke();
    // Right tread rail (shifted further right when camera is left of center!)
    ctx.beginPath();
    ctx.moveTo(nearB.uRight * w, yNear);
    ctx.lineTo(midB.uRight * w, yMid);
    ctx.lineTo(farB.uRight * w, yFar);
    ctx.stroke();
    ctx.restore();

    // 3. Floor sample patch rectangle
    if (tick.floorPatch) {
      ctx.save();
      ctx.strokeStyle = "rgba(250, 204, 21, 0.9)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(
        tick.floorPatch.x * w,
        tick.floorPatch.y * h,
        tick.floorPatch.w * w,
        tick.floorPatch.h * h
      );
      ctx.restore();
    }

    // 4. AI / HSV bounding boxes
    for (const obj of tick.objects) {
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(obj.x * w, obj.y * h, obj.w * w, obj.h * h);
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.fillRect(obj.x * w, Math.max(0, obj.y * h - 13), 84, 13);
      ctx.fillStyle = "#7dd3fc";
      ctx.font = "bold 9px monospace";
      ctx.fillText(`${obj.label} ${Math.round(obj.score * 100)}%`, obj.x * w + 3, Math.max(10, obj.y * h - 3));
    }

    // 5. Top & bottom diagnostic captions
    ctx.fillStyle = "rgba(10, 14, 22, 0.82)";
    ctx.fillRect(0, 0, w, 18);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 10px monospace";
    ctx.fillText(caption.slice(0, 48), 5, 12);

    ctx.fillStyle = "rgba(10, 14, 22, 0.84)";
    ctx.fillRect(0, h - 18, w, 18);
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "9px monospace";
    const distStr = tick.hw.distPct !== null && tick.hw.distPct <= 100 ? `${tick.hw.distPct}%` : "NA";
    const foot = `F:${distStr} Swp:${Math.round(tick.sweptClear * 100)}% Flw:${tick.flowForward.toFixed(2)} L:${tick.cmd.left} R:${tick.cmd.right}`;
    ctx.fillText(foot, 5, h - 6);

    const annotatedFrameDataUrl = annCanvas.toDataURL("image/jpeg", 0.78);
    return { rawFrameDataUrl, annotatedFrameDataUrl };
  } catch {
    return {};
  }
}

function drawMiniMap(
  ctx: CanvasRenderingContext2D,
  map: RoomMapSnapshot | null,
  x: number,
  y: number,
  size: number
): void {
  ctx.save();
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, size, size);

  if (!map) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    ctx.fillText("No map data", x + 16, y + size / 2);
    ctx.restore();
    return;
  }

  const cellPx = size / map.gridSize;
  ctx.fillStyle = "rgba(34, 197, 94, 0.45)";
  for (const [gx, gy] of map.visited) {
    ctx.fillRect(x + gx * cellPx, y + gy * cellPx, Math.max(2, cellPx + 1), Math.max(2, cellPx + 1));
  }
  ctx.fillStyle = "#f59e0b";
  for (const [gx, gy] of map.obstacles) {
    ctx.fillRect(x + gx * cellPx, y + gy * cellPx, Math.max(2.5, cellPx + 1), Math.max(2.5, cellPx + 1));
  }

  // Home origin
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.fillStyle = "#e2e8f0";
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Robot marker
  const rx = x + map.robotX * cellPx;
  const ry = y + map.robotY * cellPx;
  ctx.fillStyle = "#f97316";
  ctx.beginPath();
  ctx.arc(rx, ry, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ============================================================================
// FlightRecorder State Machine
// ============================================================================

export class FlightRecorder {
  private recording = false;
  private startedAtMs = 0;
  private startedAtIso: string | null = null;
  private ticks: FlightTickRecord[] = [];
  private events: FlightEventRecord[] = [];
  private eventSeq = 1;
  private lastFsmState = "";
  private lastBump = false;
  private encSatLogged = false;
  private lowBattLogged = false;
  private lastPeriodicMs = 0;
  private calibration: MountCalibration;
  private deviceLabel = "Pixel Fold (2023) 90° Tabletop";

  constructor(initialCalibration: MountCalibration) {
    this.calibration = { ...initialCalibration };
  }

  setCalibration(cal: MountCalibration): void {
    this.calibration = { ...cal };
  }

  isRecording(): boolean {
    return this.recording;
  }

  start(cal?: MountCalibration): void {
    if (cal) this.calibration = { ...cal };
    this.ticks = [];
    this.events = [];
    this.eventSeq = 1;
    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
    this.lastFsmState = "";
    this.lastBump = false;
    this.encSatLogged = false;
    this.lowBattLogged = false;
    this.lastPeriodicMs = 0;
    this.recording = true;
  }

  stop(video?: HTMLVideoElement | null): void {
    if (!this.recording) return;
    const last = this.ticks[this.ticks.length - 1];
    if (last) {
      this.pushEvent("RUN_STOP", "Run ended", last, video ?? null, false);
    }
    this.recording = false;
  }

  clear(): void {
    this.recording = false;
    this.startedAtMs = 0;
    this.startedAtIso = null;
    this.ticks = [];
    this.events = [];
    this.eventSeq = 1;
    this.lastFsmState = "";
    this.lastBump = false;
    this.encSatLogged = false;
    this.lowBattLogged = false;
    this.lastPeriodicMs = 0;
  }

  /**
   * Record one 10 Hz vision/explorer tick and automatically capture high-signal transition keyframes.
   */
  recordTick(
    tickWithoutTime: Omit<FlightTickRecord, "tMs" | "iso">,
    video: HTMLVideoElement | null,
    extras?: { discoveryLabel?: string; lowBattery?: boolean; stuckReason?: string }
  ): void {
    if (!this.recording) return;
    const now = Date.now();
    const tMs = Math.max(0, now - this.startedAtMs);
    const tick: FlightTickRecord = {
      ...tickWithoutTime,
      tMs,
      iso: new Date(now).toISOString(),
    };

    if (this.ticks.length >= MAX_TICKS) {
      this.ticks.shift();
    }
    this.ticks.push(tick);

    // First tick -> RUN_START snapshot
    if (this.ticks.length === 1) {
      this.pushEvent("RUN_START", `Start (${tick.mission})`, tick, video, true);
      this.lastPeriodicMs = tMs;
    }

    // Automatic state transition triggers
    if (tick.fsmState !== this.lastFsmState) {
      if (tick.fsmState === "AVOIDING") {
        this.pushEvent("AVOIDING_ENTER", tick.statusNote, tick, video, true);
      } else if (tick.fsmState === "UNSTICKING") {
        this.pushEvent(
          "UNSTICKING_ENTER",
          extras?.stuckReason ? `Unstick (${extras.stuckReason})` : tick.statusNote,
          tick,
          video,
          true
        );
      }
      this.lastFsmState = tick.fsmState;
    }

    // Rising-edge hardware bump
    if (tick.hw.bump && !this.lastBump) {
      this.pushEvent("BUMP", "Move Hub IMU bump!", tick, video, true);
    }
    this.lastBump = tick.hw.bump;

    // On-the-fly AI discovery
    if (extras?.discoveryLabel) {
      this.pushEvent("DISCOVERY", `Spotted ${extras.discoveryLabel}`, tick, video, true);
    }

    // Hardware health anomalies (logged once per run)
    if (tick.map.encSaturated && !this.encSatLogged) {
      this.encSatLogged = true;
      this.pushEvent("ENCODER_SATURATED", "Encoder hit ±32767° (using speed fallback)", tick, video, false);
    }
    if (extras?.lowBattery && !this.lowBattLogged) {
      this.lowBattLogged = true;
      this.pushEvent("LOW_BATTERY", `Low battery (${tick.hw.batteryMv ?? "?"} mV)`, tick, video, false);
    }

    // Periodic cruise frame so we have normal driving context too
    if (
      tick.fsmState === "CRUISING" &&
      tMs - this.lastPeriodicMs >= PERIODIC_SNAPSHOT_INTERVAL_MS &&
      this.getKeyframeCount() < MAX_KEYFRAME_EVENTS - 6
    ) {
      this.lastPeriodicMs = tMs;
      this.pushEvent("PERIODIC", "Cruise context frame", tick, video, true);
    }
  }

  /**
   * 1-tap User Problem Tag right when something goes wrong (or great!) during a live floor run.
   * Always prioritized in the Contact Sheet PNG and ZIP bundle.
   */
  markProblem(tag: ProblemTagKind, video: HTMLVideoElement | null, note?: string): FlightEventRecord | null {
    const meta = PROBLEM_TAGS.find((t) => t.id === tag);
    const label = note ? `${meta?.label ?? tag}: ${note}` : (meta?.label ?? tag);
    const last = this.ticks[this.ticks.length - 1];
    const now = Date.now();

    if (!this.recording) {
      // Allow tagging even if user forgot to hit REC first — auto-starts a mini snapshot record!
      this.start(this.calibration);
    }

    const baseTick: FlightTickRecord = last ?? {
      tMs: Math.max(0, now - this.startedAtMs),
      iso: new Date(now).toISOString(),
      assistMode: "explorer",
      mission: "explore-room",
      fsmState: "IDLE",
      statusNote: label,
      corridors: [0.5, 0.5, 0.5, 0.5, 0.5],
      horizonYs: [0.6, 0.6, 0.6, 0.6, 0.6],
      sweptClear: 0.5,
      bestSteer: 0,
      floorRgb: [128, 128, 128],
      floorNoise: 0,
      avgLuma: 128,
      flowForward: 0,
      flowTurn: 0,
      flowConfidence: 0,
      validPatches: 0,
      objects: [],
      hw: {
        bleConnected: false,
        batteryMv: null,
        distPct: null,
        colorId: null,
        pitch: null,
        roll: null,
        flags: null,
        bump: false,
        pickedUp: false,
        safeMode: false,
        sensorOk: false,
        encA: 0,
        encB: 0,
        speedA: 0,
        speedB: 0,
      },
      phone: {
        headingDeg: null,
        yawRateDegS: 0,
        headingSource: "none",
        mountPitchDeg: null,
        mountRollDeg: null,
        rawAlpha: null,
        rawBeta: null,
        rawGamma: null,
        torchOn: false,
        visionMs: 0,
        aiReady: false,
      },
      map: {
        xCm: 0,
        yCm: 0,
        headingDeg: 0,
        frontierBias: 0,
        coveragePct: 0,
        distanceM: 0,
        encSaturated: false,
      },
      cmd: { left: 0, right: 0, steer: 0, throttle: 0, recoveries: 0 },
    };

    return this.pushEvent("USER_TAG", label, baseTick, video, true, tag);
  }

  markManualOverride(video: HTMLVideoElement | null): void {
    if (!this.recording || this.ticks.length === 0) return;
    const last = this.ticks[this.ticks.length - 1];
    this.pushEvent("MANUAL_OVERRIDE", "Driver took manual control / STOP", last, video, true);
  }

  private getKeyframeCount(): number {
    return this.events.filter((e) => Boolean(e.annotatedFrameDataUrl || e.rawFrameDataUrl)).length;
  }

  private pushEvent(
    kind: FlightEventKind,
    label: string,
    tick: FlightTickRecord,
    video: HTMLVideoElement | null,
    captureFrame: boolean,
    tag?: ProblemTagKind
  ): FlightEventRecord {
    // Always allow USER_TAG frames (evict oldest PERIODIC frame if at cap!)
    let shouldCapture = captureFrame && Boolean(video);
    if (shouldCapture && this.getKeyframeCount() >= MAX_KEYFRAME_EVENTS) {
      if (kind === "USER_TAG" || kind === "BUMP" || kind === "UNSTICKING_ENTER") {
        const periodicIdx = this.events.findIndex(
          (e) => e.kind === "PERIODIC" && Boolean(e.annotatedFrameDataUrl)
        );
        if (periodicIdx >= 0) {
          this.events[periodicIdx].annotatedFrameDataUrl = undefined;
          this.events[periodicIdx].rawFrameDataUrl = undefined;
        } else {
          shouldCapture = false;
        }
      } else {
        shouldCapture = false;
      }
    }

    const sec = (tick.tMs / 1000).toFixed(1);
    const caption = `t=${sec}s · ${tag ? `[${tag.toUpperCase()}]` : kind} · ${tick.fsmState}`;
    const frames = shouldCapture
      ? captureAnnotatedEventFrames(video, tick, this.calibration, caption)
      : {};

    const ev: FlightEventRecord = {
      id: this.eventSeq++,
      tMs: tick.tMs,
      iso: tick.iso,
      kind,
      tag,
      label,
      fsmState: tick.fsmState,
      frontDistPct: tick.hw.distPct,
      corridors: [...tick.corridors],
      sweptClear: tick.sweptClear,
      flowForward: tick.flowForward,
      cmdLeft: tick.cmd.left,
      cmdRight: tick.cmd.right,
      ...frames,
    };
    this.events.push(ev);
    return ev;
  }

  getEvents(): FlightEventRecord[] {
    return this.events;
  }

  getTicks(): FlightTickRecord[] {
    return this.ticks;
  }

  getStats(mapSnap?: RoomMapSnapshot | null): FlightRunStats {
    const n = this.ticks.length;
    const durationSec =
      n >= 2
        ? Number(((this.ticks[n - 1].tMs - this.ticks[0].tMs) / 1000).toFixed(1))
        : this.recording && this.startedAtMs > 0
          ? Number(((Date.now() - this.startedAtMs) / 1000).toFixed(1))
          : 0;

    let cruising = 0;
    let avoiding = 0;
    let unsticking = 0;
    const visionTimes: number[] = [];
    let battStart: number | null = null;
    let battEnd: number | null = null;
    let battMin: number | null = null;
    let encSat = false;
    let headingSource: HeadingSource = "none";

    for (const t of this.ticks) {
      if (t.fsmState === "CRUISING" || t.fsmState === "RETURNING_HOME") cruising++;
      else if (t.fsmState === "AVOIDING") avoiding++;
      else if (t.fsmState === "UNSTICKING") unsticking++;

      if (t.phone.visionMs > 0) visionTimes.push(t.phone.visionMs);
      if (t.phone.headingSource !== "none") headingSource = t.phone.headingSource;
      if (t.map.encSaturated) encSat = true;

      if (t.hw.batteryMv !== null && t.hw.batteryMv > 0) {
        if (battStart === null) battStart = t.hw.batteryMv;
        battEnd = t.hw.batteryMv;
        if (battMin === null || t.hw.batteryMv < battMin) battMin = t.hw.batteryMv;
      }
    }

    const lastMap = this.ticks[n - 1]?.map;
    return {
      recording: this.recording,
      startedAtIso: this.startedAtIso,
      durationSec,
      tickCount: n,
      eventCount: this.events.length,
      userTagCount: this.events.filter((e) => e.kind === "USER_TAG").length,
      keyframeCount: this.getKeyframeCount(),
      cruisingPct: n > 0 ? Math.round((cruising / n) * 100) : 0,
      avoidingPct: n > 0 ? Math.round((avoiding / n) * 100) : 0,
      unstickingPct: n > 0 ? Math.round((unsticking / n) * 100) : 0,
      bumpCount: this.events.filter((e) => e.kind === "BUMP").length,
      unstickCount: this.events.filter((e) => e.kind === "UNSTICKING_ENTER").length,
      discoveryCount: this.events.filter((e) => e.kind === "DISCOVERY").length,
      overrideCount: this.events.filter((e) => e.kind === "MANUAL_OVERRIDE").length,
      encoderSaturated: encSat,
      lowBatterySeen: this.lowBattLogged,
      batteryStartMv: battStart,
      batteryEndMv: battEnd,
      batteryMinMv: battMin,
      visionMsP50: percentile(visionTimes, 50),
      visionMsP95: percentile(visionTimes, 95),
      distanceMeters: mapSnap?.distanceMeters ?? lastMap?.distanceM ?? 0,
      coveragePct: mapSnap?.coveragePct ?? lastMap?.coveragePct ?? 0,
      headingSource,
    };
  }

  buildTelemetryJsonl(): string {
    return this.ticks.map((t) => JSON.stringify(t)).join("\n") + (this.ticks.length > 0 ? "\n" : "");
  }

  buildSummaryMarkdown(mapSnap?: RoomMapSnapshot | null): string {
    const st = this.getStats(mapSnap);
    const cal = this.calibration;
    const tagCounts = new Map<string, number>();
    for (const ev of this.events) {
      if (ev.tag) {
        tagCounts.set(ev.tag, (tagCounts.get(ev.tag) ?? 0) + 1);
      }
    }

    const lines: string[] = [
      `# Vernie Pilot Field Test Run Report`,
      ``,
      `- **Device:** ${this.deviceLabel}`,
      `- **Started:** ${st.startedAtIso ?? "N/A"}`,
      `- **Duration:** ${st.durationSec}s (${st.tickCount} ticks @ ~10 Hz)`,
      `- **Calibration:** \`camOffset=${cal.camOffsetCm}cm\`, \`robotWidth=${cal.robotWidthCm}cm\`, \`fov=${cal.fovDeg}°\`, \`horizonY=${cal.horizonY}\`, \`bumperMaskY=${cal.bumperMaskY}\``,
      ``,
      `## Autonomy Scorecard`,
      `| Metric | Value |`,
      `| :--- | :--- |`,
      `| Distance Driven | ${st.distanceMeters} m |`,
      `| Map Coverage | ${st.coveragePct}% |`,
      `| Cruising / Avoiding / Unsticking | ${st.cruisingPct}% / ${st.avoidingPct}% / ${st.unstickingPct}% |`,
      `| Bumps / Unsticks / Overrides | ${st.bumpCount} / ${st.unstickCount} / ${st.overrideCount} |`,
      `| Discoveries Logged | ${st.discoveryCount} |`,
      `| User Problem Tags | ${st.userTagCount}${tagCounts.size > 0 ? ` (${Array.from(tagCounts.entries()).map(([k, v]) => `${k}:${v}`).join(", ")})` : ""} |`,
      `| Heading Source | \`${st.headingSource}\` |`,
      `| Vision Latency (p50 / p95) | ${st.visionMsP50} ms / ${st.visionMsP95} ms |`,
      `| Battery (Start → End / Min) | ${st.batteryStartMv ?? "N/A"} → ${st.batteryEndMv ?? "N/A"} mV (min ${st.batteryMinMv ?? "N/A"} mV) |`,
      `| Encoder Saturated (±32767°) | ${st.encoderSaturated ? "YES (speed fallback active)" : "No"} |`,
      ``,
      `## Event Timeline (${this.events.length} events, ${st.keyframeCount} keyframes)`,
      `| Time | Kind | State | Front | Swept | Flow | L/R | Note |`,
      `| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :--- |`,
    ];

    for (const ev of this.events) {
      const tSec = `${(ev.tMs / 1000).toFixed(1)}s`;
      const fStr = ev.frontDistPct !== null && ev.frontDistPct <= 100 ? `${ev.frontDistPct}%` : "N/A";
      const kindStr = ev.tag ? `TAG:${ev.tag}` : ev.kind;
      lines.push(
        `| ${tSec} | \`${kindStr}\` | ${ev.fsmState} | ${fStr} | ${Math.round(ev.sweptClear * 100)}% | ${ev.flowForward.toFixed(2)} | ${ev.cmdLeft}/${ev.cmdRight} | ${ev.label.replace(/\|/g, "/")} |`
      );
    }

    lines.push(
      ``,
      `> Upload this report + \`contact-sheet.png\` (or the full \`.zip\` bundle) into Antigravity chat to inspect exact failure frames and replay them offline.`
    );
    return lines.join("\n");
  }

  /**
   * Render a single high-signal 1280×1020 visual storyboard PNG combining run KPIs,
   * the final 2D occupancy map, and up to 12 prioritized annotated event keyframes.
   */
  async renderContactSheetPng(mapSnap?: RoomMapSnapshot | null): Promise<string | null> {
    if (typeof document === "undefined") return null;
    try {
      const st = this.getStats(mapSnap);
      const cal = this.calibration;

      // Prioritize user problem tags, bumps, unsticks, avoidances, discoveries, then periodic context
      const priorityScore = (ev: FlightEventRecord): number => {
        if (ev.kind === "USER_TAG") return 100;
        if (ev.kind === "BUMP") return 90;
        if (ev.kind === "UNSTICKING_ENTER") return 80;
        if (ev.kind === "MANUAL_OVERRIDE") return 75;
        if (ev.kind === "AVOIDING_ENTER") return 60;
        if (ev.kind === "DISCOVERY") return 50;
        if (ev.kind === "RUN_START") return 40;
        return 20;
      };

      const withFrames = this.events.filter((e) => Boolean(e.annotatedFrameDataUrl));
      const chosen = [...withFrames]
        .sort((a, b) => priorityScore(b) - priorityScore(a) || a.tMs - b.tMs)
        .slice(0, 12)
        .sort((a, b) => a.tMs - b.tMs);

      const cols = 4;
      const rows = Math.max(1, Math.ceil(chosen.length / cols));
      const tileW = 304;
      const tileH = 228;
      const pad = 16;
      const headerH = 200;
      const canvasW = pad + cols * (tileW + pad);
      const canvasH = headerH + pad + rows * (tileH + pad);

      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      // Dark studio console backdrop
      ctx.fillStyle = "#0b111b";
      ctx.fillRect(0, 0, canvasW, canvasH);

      // Header scorecard box
      ctx.fillStyle = "#131c2b";
      ctx.fillRect(pad, pad, canvasW - pad * 2, headerH - pad);
      ctx.strokeStyle = "#263348";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pad, pad, canvasW - pad * 2, headerH - pad);

      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.fillText("Vernie Pilot · Pixel Fold Field Test Contact Sheet", pad + 18, pad + 34);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "13px monospace";
      ctx.fillText(
        `Start: ${st.startedAtIso ?? "N/A"}   Duration: ${st.durationSec}s   Ticks: ${st.tickCount}   Heading: ${st.headingSource}`,
        pad + 18,
        pad + 60
      );
      ctx.fillText(
        `Mount Cal: camOffset=${cal.camOffsetCm}cm  width=${cal.robotWidthCm}cm  fov=${cal.fovDeg}°  horizonY=${cal.horizonY}  bumperY=${cal.bumperMaskY}`,
        pad + 18,
        pad + 82
      );

      // Highlighted KPI line
      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 14px monospace";
      ctx.fillText(
        `Dist: ${st.distanceMeters}m  |  Map: ${st.coveragePct}%  |  Cruise/Avoid/Unstick: ${st.cruisingPct}%/${st.avoidingPct}%/${st.unstickingPct}%  |  Bumps: ${st.bumpCount}  |  Unsticks: ${st.unstickCount}  |  Tags: ${st.userTagCount}`,
        pad + 18,
        pad + 112
      );

      ctx.fillStyle = st.lowBatterySeen || st.encoderSaturated ? "#fbbf24" : "#4ade80";
      ctx.font = "13px monospace";
      ctx.fillText(
        `Battery: ${st.batteryStartMv ?? "NA"}→${st.batteryEndMv ?? "NA"}mV (min ${st.batteryMinMv ?? "NA"}mV)   Vision p50/p95: ${st.visionMsP50}/${st.visionMsP95}ms   EncSat: ${st.encoderSaturated ? "YES" : "NO"}`,
        pad + 18,
        pad + 138
      );

      ctx.fillStyle = "#cbd5e1";
      ctx.font = "12px monospace";
      ctx.fillText(
        `Legend: Dashed Cyan/Red = Asymmetric Left-Offset Chassis Rails | Yellow Dotted = Floor Sample Patch | Bars = 5-Sector Clearance`,
        pad + 18,
        pad + 164
      );

      // Mini 2D occupancy map on top right of header
      drawMiniMap(ctx, mapSnap ?? null, canvasW - pad - 172, pad + 10, 162);

      // Render annotated event tiles
      if (chosen.length === 0) {
        ctx.fillStyle = "#64748b";
        ctx.font = "15px monospace";
        ctx.fillText("No camera keyframes captured during this run.", pad + 18, headerH + 60);
      } else {
        for (let i = 0; i < chosen.length; i++) {
          const ev = chosen[i];
          const col = i % cols;
          const row = Math.floor(i / cols);
          const tx = pad + col * (tileW + pad);
          const ty = headerH + pad + row * (tileH + pad);

          ctx.fillStyle = "#111827";
          ctx.fillRect(tx, ty, tileW, tileH);

          if (ev.annotatedFrameDataUrl) {
            const img = await loadImage(ev.annotatedFrameDataUrl);
            if (img) {
              ctx.drawImage(img, tx, ty, tileW, tileH - 28);
            }
          }

          // Highlight border for user problem tags / bumps
          ctx.strokeStyle =
            ev.kind === "USER_TAG"
              ? ev.tag === "good-dodge"
                ? "#22c55e"
                : "#f97316"
              : ev.kind === "BUMP" || ev.kind === "UNSTICKING_ENTER"
                ? "#ef4444"
                : "#334155";
          ctx.lineWidth = ev.kind === "USER_TAG" ? 2.5 : 1.5;
          ctx.strokeRect(tx, ty, tileW, tileH);

          // Footer note strip
          ctx.fillStyle = "#0f172a";
          ctx.fillRect(tx + 1, ty + tileH - 27, tileW - 2, 26);
          ctx.fillStyle = ev.kind === "USER_TAG" ? "#fdba74" : "#e2e8f0";
          ctx.font = "bold 11px monospace";
          const note = `#${ev.id} ${(ev.tMs / 1000).toFixed(1)}s ${ev.label}`;
          ctx.fillText(note.slice(0, 38), tx + 6, ty + tileH - 10);
        }
      }

      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  /**
   * Build the complete `.zip` run archive containing:
   *  - `summary.md` (KPI scorecard & event table)
   *  - `meta.json` (device, calibration, final stats, map snapshot)
   *  - `telemetry.jsonl` (10 Hz full structured stream)
   *  - `events.json` (event metadata)
   *  - `contact-sheet.png` (single visual storyboard image)
   *  - `annotated-frames/ev-NNN.jpg` (HUD-overlaid event snapshots)
   *  - `raw-frames/ev-NNN.jpg` (clean unannotated frames for offline replay!)
   */
  async buildZipBundle(mapSnap?: RoomMapSnapshot | null): Promise<{ filename: string; bytes: Uint8Array; file: File }> {
    const encoder = new TextEncoder();
    const stamp = formatRunTimestamp();
    const filename = `vernie-fold-run-${stamp}.zip`;
    const entries: ZipEntryInput[] = [];

    const summaryMd = this.buildSummaryMarkdown(mapSnap);
    entries.push({ name: "summary.md", data: encoder.encode(summaryMd) });

    const meta = {
      schemaVersion: 1,
      device: this.deviceLabel,
      calibration: this.calibration,
      stats: this.getStats(mapSnap),
      finalMap: mapSnap ?? null,
    };
    entries.push({ name: "meta.json", data: encoder.encode(JSON.stringify(meta, null, 2)) });

    const jsonl = this.buildTelemetryJsonl();
    entries.push({ name: "telemetry.jsonl", data: encoder.encode(jsonl) });

    const cleanEvents = this.events.map(({ rawFrameDataUrl: _r, annotatedFrameDataUrl: _a, ...rest }) => rest);
    entries.push({ name: "events.json", data: encoder.encode(JSON.stringify(cleanEvents, null, 2)) });

    const contactSheetUrl = await this.renderContactSheetPng(mapSnap);
    if (contactSheetUrl) {
      const sheetBytes = dataUrlToBytes(contactSheetUrl);
      if (sheetBytes) {
        entries.push({ name: "contact-sheet.png", data: sheetBytes });
      }
    }

    for (const ev of this.events) {
      const padId = String(ev.id).padStart(3, "0");
      if (ev.annotatedFrameDataUrl) {
        const bytes = dataUrlToBytes(ev.annotatedFrameDataUrl);
        if (bytes) {
          entries.push({ name: `annotated-frames/ev-${padId}-${ev.kind.toLowerCase()}.jpg`, data: bytes });
        }
      }
      if (ev.rawFrameDataUrl) {
        const bytes = dataUrlToBytes(ev.rawFrameDataUrl);
        if (bytes) {
          entries.push({ name: `raw-frames/ev-${padId}-${ev.kind.toLowerCase()}.jpg`, data: bytes });
        }
      }
    }

    const bytes = createStoreZip(entries);
    const blobBytes = new Uint8Array(bytes);
    const file = new File([blobBytes], filename, { type: "application/zip" });
    return { filename, bytes, file };
  }
}

/**
 * Trigger Android Web Share sheet (`navigator.share({ files })`) when available,
 * gracefully falling back to standard browser file download.
 */
export async function shareOrDownloadFile(
  file: File,
  title: string,
  preferShare = true
): Promise<"shared" | "downloaded"> {
  if (preferShare && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      const navShare = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
      };
      if (!navShare.canShare || navShare.canShare({ files: [file] })) {
        await navigator.share({
          title,
          text: "Vernie Pilot Pixel Fold Auto Explorer test run bundle",
          files: [file],
        });
        return "shared";
      }
    } catch (err) {
      // If user explicitly cancelled share sheet, don't force an unwanted download
      if (err instanceof Error && err.name === "AbortError") {
        return "shared";
      }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  return "downloaded";
}
