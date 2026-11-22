// SPDX-License-Identifier: MIT
// Live 2D Occupancy & Breadcrumb Mapper for Autonomous Tank/Rover Exploration.
// Fuses Move Hub wheel encoders (with automatic speedA/speedB fallback past ±32767° int16 clamp!)
// + gimbal-lock-free Android gyroscope heading + unobstructed front 88007 sensor & camera corridors
// into a compact 64x64 grid (10 cm/cell = 6.4m x 6.4m) with curiosity frontier scoring & Return-Home guidance.

import { RoomMapSnapshot } from "../rtc/roverBridge";

const GRID_SIZE = 64;
const CELL_CM = 10;
const HALF = GRID_SIZE / 2;
const CM_PER_ENC_DEG = 0.038; // LEGO BOOST tank tread calibration (~13.7 cm per 360° wheel revolution)
const TRACK_WIDTH_CM = 12.5;
const MAX_SPEED_DEG_S = 1200; // Matches firmware VERNIE_DRIVE_MAX_SPEED_DEG_S (speedA/B scaled -100..+100)
const ENC_SATURATION_THRESHOLD = 32700;

// Cell states: 0 = unknown, 1 = visited floor, 2 = obstacle
const CELL_UNKNOWN = 0;
const CELL_VISITED = 1;
const CELL_OBSTACLE = 2;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function wrapAngleDiff(targetDeg: number, currentDeg: number): number {
  let d = ((targetDeg - currentDeg + 540) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

function unwrapInt16Delta(curr: number, prev: number): number {
  let delta = curr - prev;
  if (delta > 32768) delta -= 65536;
  if (delta < -32768) delta += 65536;
  return delta;
}

export class RoomMapper {
  private grid = new Uint8Array(GRID_SIZE * GRID_SIZE);
  private xCm = 0;
  private yCm = 0;
  private headingDeg = 0;
  private distanceCm = 0;
  private lastEncA: number | null = null;
  private lastEncB: number | null = null;
  private visitedCount = 0;
  private encoderSaturated = false;

  constructor() {
    this.markCell(HALF, HALF, CELL_VISITED);
  }

  reset(): void {
    this.grid.fill(CELL_UNKNOWN);
    this.xCm = 0;
    this.yCm = 0;
    this.headingDeg = 0;
    this.distanceCm = 0;
    this.lastEncA = null;
    this.lastEncB = null;
    this.visitedCount = 0;
    this.encoderSaturated = false;
    this.markCell(HALF, HALF, CELL_VISITED);
  }

  isEncoderSaturated(): boolean {
    return this.encoderSaturated;
  }

  private toGrid(xCm: number, yCm: number): [number, number] {
    const gx = clamp(Math.round(HALF + xCm / CELL_CM), 0, GRID_SIZE - 1);
    const gy = clamp(Math.round(HALF - yCm / CELL_CM), 0, GRID_SIZE - 1);
    return [gx, gy];
  }

  private markCell(gx: number, gy: number, state: number): void {
    if (gx < 0 || gx >= GRID_SIZE || gy < 0 || gy >= GRID_SIZE) return;
    const idx = gy * GRID_SIZE + gx;
    const prev = this.grid[idx];
    if (state === CELL_VISITED) {
      if (prev !== CELL_VISITED) {
        this.visitedCount++;
      }
      this.grid[idx] = CELL_VISITED;
    } else if (state === CELL_OBSTACLE && prev !== CELL_VISITED) {
      this.grid[idx] = CELL_OBSTACLE;
    }
  }

  /**
   * Integrate new pose & obstacle hits from wheel encoders (with automatic speed fallback
   * when firmware int16 encoders saturate at ±32767°) + gyro + 88007 bumper + camera corridors.
   */
  update(params: {
    encA: number;
    encB: number;
    gyroHeadingDeg: number | null;
    frontDistancePct: number;
    corridors: [number, number, number, number, number];
    /** Optional measured track speeds (-100..+100) for seamless odometry past int16 saturation */
    speedA?: number;
    speedB?: number;
    /** Optional tick delta in ms (default 100 ms) */
    dtMs?: number;
    /** Optional lateral camera offset in cm (negative = left of robot center) */
    camOffsetCm?: number;
    explicitPoseCm?: { x: number; y: number; headingDeg: number };
  }): void {
    if (params.explicitPoseCm) {
      const dx = params.explicitPoseCm.x - this.xCm;
      const dy = params.explicitPoseCm.y - this.yCm;
      const step = Math.hypot(dx, dy);
      if (step < 80) this.distanceCm += step;
      this.xCm = params.explicitPoseCm.x;
      this.yCm = params.explicitPoseCm.y;
      this.headingDeg = ((params.explicitPoseCm.headingDeg % 360) + 360) % 360;
    } else {
      const satA = Math.abs(params.encA) >= ENC_SATURATION_THRESHOLD;
      const satB = Math.abs(params.encB) >= ENC_SATURATION_THRESHOLD;
      if (satA || satB) {
        this.encoderSaturated = true;
      }

      if (this.lastEncA !== null && this.lastEncB !== null) {
        const dtSec = clamp(params.dtMs ?? 100, 20, 400) / 1000;
        const speedFallbackA =
          typeof params.speedA === "number"
            ? (params.speedA / 100) * MAX_SPEED_DEG_S * dtSec * CM_PER_ENC_DEG
            : 0;
        const speedFallbackB =
          typeof params.speedB === "number"
            ? (params.speedB / 100) * MAX_SPEED_DEG_S * dtSec * CM_PER_ENC_DEG
            : 0;

        const dA = satA
          ? speedFallbackA
          : unwrapInt16Delta(params.encA, this.lastEncA) * CM_PER_ENC_DEG;
        const dB = satB
          ? speedFallbackB
          : unwrapInt16Delta(params.encB, this.lastEncB) * CM_PER_ENC_DEG;

        // Ignore unrealistic sudden jumps
        if (Math.abs(dA) < 40 && Math.abs(dB) < 40) {
          const ds = (dA + dB) / 2;
          const dThetaDeg = ((dA - dB) / TRACK_WIDTH_CM) * (180 / Math.PI);
          if (params.gyroHeadingDeg !== null) {
            this.headingDeg = ((params.gyroHeadingDeg % 360) + 360) % 360;
          } else {
            this.headingDeg = (this.headingDeg + dThetaDeg + 360) % 360;
          }
          const rad = (this.headingDeg * Math.PI) / 180;
          this.xCm = clamp(this.xCm + Math.sin(rad) * ds, -(HALF - 2) * CELL_CM, (HALF - 2) * CELL_CM);
          this.yCm = clamp(this.yCm + Math.cos(rad) * ds, -(HALF - 2) * CELL_CM, (HALF - 2) * CELL_CM);
          this.distanceCm += Math.abs(ds);
        }
      } else if (params.gyroHeadingDeg !== null) {
        this.headingDeg = ((params.gyroHeadingDeg % 360) + 360) % 360;
      }
      this.lastEncA = params.encA;
      this.lastEncB = params.encB;
    }

    // Mark current rover footprint as visited open floor
    const [rx, ry] = this.toGrid(this.xCm, this.yCm);
    this.markCell(rx, ry, CELL_VISITED);

    // Project unobstructed front 88007 bumper obstacle hit
    const headRad = (this.headingDeg * Math.PI) / 180;
    if (params.frontDistancePct <= 36) {
      const distCm = Math.max(15, params.frontDistancePct * 1.1);
      const [ox, oy] = this.toGrid(
        this.xCm + Math.sin(headRad) * distCm,
        this.yCm + Math.cos(headRad) * distCm
      );
      this.markCell(ox, oy, CELL_OBSTACLE);
    }

    // Project blocked vision corridor obstacle markers from camera's lateral mount origin
    const camOff = params.camOffsetCm ?? 0;
    const camXCm = this.xCm + Math.cos(headRad) * camOff;
    const camYCm = this.yCm - Math.sin(headRad) * camOff;
    const sectorAngles = [-26, -13, 0, 13, 26];
    for (let i = 0; i < 5; i++) {
      const clr = params.corridors[i];
      if (clr < 0.28) {
        const distCm = 22 + clr * 110;
        const rayRad = headRad + (sectorAngles[i] * Math.PI) / 180;
        const [ox, oy] = this.toGrid(
          camXCm + Math.sin(rayRad) * distCm,
          camYCm + Math.cos(rayRad) * distCm
        );
        this.markCell(ox, oy, CELL_OBSTACLE);
      }
    }
  }

  /**
   * Compute curiosity frontier steering bias [-1 left .. +1 right] favoring unexplored open cells!
   * Sweeps a deduplicated 3-ray fan on each side (covering vision sectors ±14°/±28° and peripheral ±48°)
   * from 25 cm to 95 cm so mapped nearby obstacles and visited trails cleanly steer toward open unknown space.
   */
  getFrontierBias(): number {
    const scoreFan = (anglesDeg: number[]): number => {
      const seen = new Set<number>();
      let score = 0;
      for (const relDeg of anglesDeg) {
        const rad = ((this.headingDeg + relDeg) * Math.PI) / 180;
        for (const distCm of [25, 45, 70, 95]) {
          const [gx, gy] = this.toGrid(
            this.xCm + Math.sin(rad) * distCm,
            this.yCm + Math.cos(rad) * distCm
          );
          const idx = gy * GRID_SIZE + gx;
          if (seen.has(idx)) continue;
          seen.add(idx);
          const cell = this.grid[idx];
          if (cell === CELL_UNKNOWN) score += 1.0;
          else if (cell === CELL_VISITED) score += 0.25;
          else score -= 1.6;
        }
      }
      return score;
    };

    const leftScore = scoreFan([-48, -28, -14]);
    const rightScore = scoreFan([14, 28, 48]);
    return clamp((rightScore - leftScore) / 6.0, -1, 1);
  }

  /**
   * Return distance (cm) and relative turn error (-180..+180 deg) back toward home origin (0, 0).
   */
  getReturnHomeGuidance(): { distCm: number; turnErrorDeg: number; arrived: boolean } {
    const distCm = Math.hypot(this.xCm, this.yCm);
    if (distCm <= 32) {
      return { distCm, turnErrorDeg: 0, arrived: true };
    }
    const targetRad = Math.atan2(-this.xCm, -this.yCm);
    const targetDeg = ((targetRad * 180) / Math.PI + 360) % 360;
    const turnErrorDeg = wrapAngleDiff(targetDeg, this.headingDeg);
    return { distCm, turnErrorDeg, arrived: false };
  }

  getPoseCm(): { x: number; y: number; headingDeg: number } {
    return { x: this.xCm, y: this.yCm, headingDeg: this.headingDeg };
  }

  getSnapshot(): RoomMapSnapshot {
    const visited: Array<[number, number]> = [];
    const obstacles: Array<[number, number]> = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const v = this.grid[y * GRID_SIZE + x];
        if (v === CELL_VISITED) visited.push([x, y]);
        else if (v === CELL_OBSTACLE) obstacles.push([x, y]);
      }
    }
    const [robotX, robotY] = this.toGrid(this.xCm, this.yCm);
    // Express coverage relative to a typical ~18 m² living-room floor (180 cells)
    const coveragePct = Math.min(100, Math.round((this.visitedCount / 180) * 100));
    return {
      gridSize: GRID_SIZE,
      cellCm: CELL_CM,
      robotX,
      robotY,
      headingDeg: Math.round(this.headingDeg),
      visited,
      obstacles,
      coveragePct,
      distanceMeters: Number((this.distanceCm / 100).toFixed(2)),
    };
  }
}
