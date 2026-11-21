// SPDX-License-Identifier: MIT
// Interactive Virtual Vernie Simulator for Demo Mode.
// Mirrors real Vernie OS firmware telemetry, head homing, 2-step dart interlock,
// Hub/Chest LEDs, 5 autonomous modes, and 5-byte Flash Macro playback.

import {
  ChestLedState,
  DartSubcmd,
  HEAD_HOME_SENTINEL,
  MacroStep,
  MacroStepOp,
  TelemetryFlag,
  TelemetryFrame,
  VernieMode,
} from "@core/ble/protocol";
import { playBrowserSynth, playDartLaunchSound, stopBrowserSynth } from "./browserSynth";

export interface VirtualVisualState {
  hubRgb: [number, number, number];
  chestLedState: number;
  homingInProgress: boolean;
  dartFiredAt: number;
  activeMacroStepIndex: number | null;
  macroPlaying: boolean;
  savedMacroCount: number;
  soundEnabled: boolean;
  floorX: number;
  floorY: number;
  headingDeg: number;
}

export interface VirtualVernieCallbacks {
  onTelemetry: (frame: TelemetryFrame) => void;
  onVisualChange: (visual: VirtualVisualState) => void;
}

const MODE_LED_RGB: Record<number, [number, number, number]> = {
  [VernieMode.PET]: [14, 165, 233],
  [VernieMode.EXPLORER]: [22, 163, 74],
  [VernieMode.SENTRY]: [220, 38, 38],
  [VernieMode.COLOR_CARDS]: [234, 179, 8],
  [VernieMode.REMOTE]: [124, 58, 237],
};

const MACRO_PALETTE_RGB: Array<[number, number, number]> = [
  [0, 168, 232],   // 0 Cyan
  [255, 122, 0],   // 1 Orange
  [16, 220, 96],   // 2 Emerald
  [255, 24, 24],   // 3 Red
  [139, 92, 246],  // 4 Ultraviolet
  [255, 210, 0],   // 5 Yellow
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class VirtualVernieSimulator {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Firmware-equivalent telemetry state
  private batteryMv = 8420;
  private distancePct = 78;
  private colorId = 0;
  private pitchDeg = 0;
  private rollDeg = 0;
  private modeId: number = VernieMode.REMOTE;
  private encA = 0;
  private encB = 0;
  private headDeg = 0;
  private headTargetDeg = 0;
  private speedA = 0;
  private speedB = 0;
  private driveExpireAt = 0;
  private seq = 0;

  // Flags
  private pickedUp = false;
  private bumpUntil = 0;
  private tapUntil = 0;
  private dartArmed = false;
  private headHomed = false;
  private safeMode = false;
  private synthUntil = 0;

  // Visual / extra state
  private hubRgb: [number, number, number] = [0, 168, 232];
  private chestLedState: number = ChestLedState.OFF;
  private homingInProgress = false;
  private homingTimer: ReturnType<typeof setTimeout> | null = null;
  private dartFiredAt = 0;
  private soundEnabled = true;
  private floorX = 0;
  private floorY = 0;
  private headingDeg = 0;

  // Macro sequencer state
  private savedMacro: MacroStep[] = [];
  private macroSteps: MacroStep[] = [];
  private macroIndex: number | null = null;
  private macroStepEndsAt = 0;

  // Autonomous animation phase
  private tickCount = 0;

  constructor(private readonly callbacks: VirtualVernieCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emitAll();
    this.timerId = setInterval(() => this.step(100), 100);
  }

  stop(): void {
    this.running = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.homingTimer) {
      clearTimeout(this.homingTimer);
      this.homingTimer = null;
    }
    stopBrowserSynth();
    this.homingInProgress = false;
    this.macroIndex = null;
    this.speedA = 0;
    this.speedB = 0;
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    if (!enabled) stopBrowserSynth();
    this.emitVisual();
  }

  private getFlags(now: number): number {
    let f = 0;
    if (this.pickedUp) f |= TelemetryFlag.PICKED_UP;
    if (now < this.bumpUntil) f |= TelemetryFlag.BUMP;
    if (now < this.tapUntil) f |= TelemetryFlag.TAP;
    if (this.dartArmed) f |= TelemetryFlag.DART_ARMED;
    if (this.headHomed) f |= TelemetryFlag.HEAD_HOMED;
    if (this.chestLedState === ChestLedState.OFF) f |= TelemetryFlag.SENSOR_OK;
    if (this.safeMode) f |= TelemetryFlag.SAFE_MODE;
    if (now < this.synthUntil) f |= TelemetryFlag.SYNTH_ACTIVE;
    return f;
  }

  private getFrame(now = Date.now()): TelemetryFrame {
    const sensorActive = this.chestLedState === ChestLedState.OFF;
    return {
      batteryMv: Math.round(this.batteryMv),
      distancePct: sensorActive ? clamp(Math.round(this.distancePct), 0, 100) : 255,
      colorId: sensorActive ? this.colorId : 0,
      pitchDeg: Math.round(this.pitchDeg),
      rollDeg: Math.round(this.rollDeg),
      flags: this.getFlags(now),
      modeId: this.modeId,
      encA: Math.round(this.encA),
      encB: Math.round(this.encB),
      headDeg: Math.round(this.headDeg),
      speedA: Math.round(this.speedA),
      speedB: Math.round(this.speedB),
      seq: this.seq & 0xff,
    };
  }

  private getVisual(): VirtualVisualState {
    return {
      hubRgb: [...this.hubRgb] as [number, number, number],
      chestLedState: this.chestLedState,
      homingInProgress: this.homingInProgress,
      dartFiredAt: this.dartFiredAt,
      activeMacroStepIndex: this.macroIndex,
      macroPlaying: this.macroIndex !== null,
      savedMacroCount: this.savedMacro.length,
      soundEnabled: this.soundEnabled,
      floorX: this.floorX,
      floorY: this.floorY,
      headingDeg: this.headingDeg,
    };
  }

  private emitVisual(): void {
    this.callbacks.onVisualChange(this.getVisual());
  }

  private emitAll(): void {
    this.callbacks.onTelemetry(this.getFrame());
    this.emitVisual();
  }

  private step(dtMs: number): void {
    if (!this.running) return;
    const now = Date.now();
    this.tickCount += 1;
    this.seq = (this.seq + 1) & 0xff;

    // 1. Macro sequencer advancement
    if (this.macroIndex !== null && !this.safeMode) {
      if (now >= this.macroStepEndsAt) {
        const nextIdx = this.macroIndex + 1;
        if (nextIdx >= this.macroSteps.length) {
          this.macroIndex = null;
          this.speedA = 0;
          this.speedB = 0;
          this.emitVisual();
        } else {
          this.beginMacroStep(nextIdx, now);
        }
      }
    }

    // 2. Drive timeout expiry (dead-man switch)
    if (this.macroIndex === null && this.driveExpireAt > 0 && now >= this.driveExpireAt) {
      this.speedA = 0;
      this.speedB = 0;
      this.driveExpireAt = 0;
    }

    // 3. Gentle autonomous mode animations when idle & not picked up
    if (
      this.macroIndex === null &&
      this.driveExpireAt === 0 &&
      !this.pickedUp &&
      !this.safeMode &&
      !this.homingInProgress
    ) {
      if (this.modeId === VernieMode.PET && this.tickCount % 32 === 0 && this.headHomed) {
        const poses = [-24, 0, 22, -12, 16];
        this.headTargetDeg = poses[(this.tickCount / 32) % poses.length | 0];
      } else if (this.modeId === VernieMode.SENTRY && this.tickCount % 22 === 0 && this.headHomed) {
        this.headTargetDeg = this.headTargetDeg <= 0 ? 28 : -28;
      } else if (this.modeId === VernieMode.EXPLORER) {
        // Gentle idle cruise feel in Demo Mode
        this.speedA = 22;
        this.speedB = 22;
      }
    }

    // 4. Integrate wheel encoders & virtual floor pose
    const dtSec = dtMs / 1000;
    if (this.speedA !== 0 || this.speedB !== 0) {
      this.encA += this.speedA * 2.8 * dtSec;
      this.encB += this.speedB * 2.8 * dtSec;
      const linear = ((this.speedA + this.speedB) / 2) * 0.45 * dtSec;
      const turn = ((this.speedA - this.speedB) / 2) * 1.6 * dtSec;
      this.headingDeg = (this.headingDeg + turn + 360) % 360;
      const rad = (this.headingDeg * Math.PI) / 180;
      this.floorX = clamp(this.floorX + Math.sin(rad) * linear, -100, 100);
      this.floorY = clamp(this.floorY + Math.cos(rad) * linear, -100, 100);
      // Slight pitch kick on acceleration
      const accelPitch = clamp(((this.speedA + this.speedB) / 2) * 0.06, -6, 6);
      this.pitchDeg = this.pickedUp ? 22 : accelPitch;
    } else if (!this.pickedUp) {
      this.pitchDeg *= 0.6;
      this.rollDeg *= 0.6;
    }

    // 5. Smoothly slew head toward target angle
    const diff = this.headTargetDeg - this.headDeg;
    if (Math.abs(diff) <= 3) {
      this.headDeg = this.headTargetDeg;
    } else {
      this.headDeg += Math.sign(diff) * Math.min(Math.abs(diff), 9);
    }

    // Tiny realistic battery ripple
    const loadDrop = (Math.abs(this.speedA) + Math.abs(this.speedB)) * 0.6;
    this.batteryMv = clamp(8420 - loadDrop + Math.sin(this.tickCount * 0.15) * 8, 6200, 9000);

    this.callbacks.onTelemetry(this.getFrame(now));
  }

  private beginMacroStep(idx: number, now: number): void {
    const step = this.macroSteps[idx];
    this.macroIndex = idx;
    this.macroStepEndsAt = now + clamp(step.durMs, 50, 5000);
    this.speedA = 0;
    this.speedB = 0;

    switch (step.op) {
      case MacroStepOp.DRIVE:
        this.speedA = clamp(step.arg0, -100, 100);
        this.speedB = clamp(step.arg1, -100, 100);
        break;
      case MacroStepOp.HEAD:
        if (this.headHomed) {
          this.headTargetDeg = clamp(step.arg0, -40, 35);
        }
        break;
      case MacroStepOp.SYNTH:
        this.synthUntil = now + Math.max(250, Math.min(3000, step.durMs));
        if (this.soundEnabled) playBrowserSynth(step.arg1, step.durMs);
        break;
      case MacroStepOp.LED:
        if (step.arg0 === 0) {
          this.hubRgb = [...(MACRO_PALETTE_RGB[step.arg1] ?? MACRO_PALETTE_RGB[0])] as [
            number,
            number,
            number,
          ];
        } else {
          this.chestLedState = step.arg1;
        }
        break;
      default:
        break;
    }
    this.emitVisual();
  }

  // --- Commands mirroring VernieClient API ---

  sendDrive(left: number, right: number, timeoutMs = 400): void {
    if (left === 0 && right === 0) {
      this.speedA = 0;
      this.speedB = 0;
      this.driveExpireAt = 0;
      if (this.macroIndex !== null) {
        this.macroIndex = null;
      }
      if (this.modeId !== VernieMode.REMOTE) {
        this.modeId = VernieMode.REMOTE;
      }
      this.emitAll();
      return;
    }
    if (this.safeMode) return;
    this.macroIndex = null;
    this.modeId = VernieMode.REMOTE;
    this.speedA = clamp(left, -100, 100);
    this.speedB = clamp(right, -100, 100);
    this.driveExpireAt = Date.now() + clamp(timeoutMs, 100, 1000);
    this.callbacks.onTelemetry(this.getFrame());
  }

  sendHead(angleDeg: number): Promise<void> {
    if (this.safeMode) return Promise.resolve();
    if (angleDeg === HEAD_HOME_SENTINEL) {
      this.homingInProgress = true;
      this.headTargetDeg = -38;
      this.emitVisual();
      if (this.homingTimer) clearTimeout(this.homingTimer);
      this.homingTimer = setTimeout(() => {
        this.headTargetDeg = 0;
        this.headHomed = true;
        this.homingInProgress = false;
        if (this.soundEnabled) playBrowserSynth(2, 200);
        this.synthUntil = Date.now() + 260;
        this.emitAll();
      }, 650);
      return Promise.resolve();
    }
    if (!this.headHomed) return Promise.resolve();
    this.headTargetDeg = clamp(angleDeg, -40, 35);
    this.callbacks.onTelemetry(this.getFrame());
    return Promise.resolve();
  }

  sendDart(subcmd: number): Promise<void> {
    if (subcmd === DartSubcmd.DISARM) {
      this.dartArmed = false;
      this.emitAll();
      return Promise.resolve();
    }
    if (this.safeMode) return Promise.resolve();
    if (subcmd === DartSubcmd.ARM) {
      this.dartArmed = true;
      this.emitAll();
      return Promise.resolve();
    }
    if (subcmd === DartSubcmd.FIRE) {
      if (this.dartArmed && this.headHomed && !this.pickedUp) {
        this.dartArmed = false;
        this.dartFiredAt = Date.now();
        this.pitchDeg = -8;
        if (this.soundEnabled) playDartLaunchSound();
        this.emitAll();
      }
    }
    return Promise.resolve();
  }

  sendSynth(_voice: number, presetOrNote: number, durMs = 300): Promise<void> {
    if (presetOrNote === 0) {
      this.synthUntil = 0;
      stopBrowserSynth();
      this.callbacks.onTelemetry(this.getFrame());
      return Promise.resolve();
    }
    if (this.safeMode) return Promise.resolve();
    const effectiveDur = presetOrNote <= 7 ? 480 : clamp(durMs, 80, 3000);
    this.synthUntil = Date.now() + effectiveDur;
    if (this.soundEnabled) {
      playBrowserSynth(presetOrNote, effectiveDur);
    }
    this.callbacks.onTelemetry(this.getFrame());
    return Promise.resolve();
  }

  sendHubLed(r: number, g: number, b: number): Promise<void> {
    this.hubRgb = [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
    this.emitVisual();
    return Promise.resolve();
  }

  sendChestLed(state: number): Promise<void> {
    this.chestLedState = state;
    this.emitAll();
    return Promise.resolve();
  }

  sendSetMode(modeId: number): Promise<void> {
    if (this.safeMode) return Promise.resolve();
    this.modeId = clamp(modeId, 0, 4);
    this.speedA = 0;
    this.speedB = 0;
    this.driveExpireAt = 0;
    this.macroIndex = null;
    this.hubRgb = [...(MODE_LED_RGB[this.modeId] ?? [0, 168, 232])] as [number, number, number];
    if (this.soundEnabled) playBrowserSynth(2, 180);
    this.synthUntil = Date.now() + 240;
    this.emitAll();
    return Promise.resolve();
  }

  uploadMacro(
    steps: MacroStep[],
    options: { saveToFlash?: boolean; playAfter?: boolean } = {}
  ): Promise<void> {
    if (this.safeMode) return Promise.resolve();
    this.macroSteps = steps.map((s) => ({ ...s }));
    if (options.saveToFlash) {
      this.savedMacro = steps.map((s) => ({ ...s }));
    }
    if (options.playAfter && this.macroSteps.length > 0) {
      this.beginMacroStep(0, Date.now());
    }
    this.emitVisual();
    return Promise.resolve();
  }

  playMacro(): Promise<void> {
    if (this.safeMode) return Promise.resolve();
    const list = this.savedMacro.length > 0 ? this.savedMacro : this.macroSteps;
    if (list.length === 0) return Promise.resolve();
    this.macroSteps = list.map((s) => ({ ...s }));
    this.beginMacroStep(0, Date.now());
    return Promise.resolve();
  }

  stopMacro(): Promise<void> {
    this.macroIndex = null;
    this.speedA = 0;
    this.speedB = 0;
    this.emitAll();
    return Promise.resolve();
  }

  clearMacro(): Promise<void> {
    this.macroIndex = null;
    this.savedMacro = [];
    this.macroSteps = [];
    this.emitAll();
    return Promise.resolve();
  }

  // --- Interactive Demo Environment Controls ---

  togglePickedUp(): void {
    this.pickedUp = !this.pickedUp;
    if (this.pickedUp) {
      this.dartArmed = false;
      this.pitchDeg = 22;
      this.rollDeg = -14;
      if (this.modeId !== VernieMode.REMOTE) {
        this.speedA = 0;
        this.speedB = 0;
        if (this.soundEnabled) playBrowserSynth(4, 300);
        this.synthUntil = Date.now() + 350;
      }
    } else {
      this.pitchDeg = 0;
      this.rollDeg = 0;
    }
    this.emitAll();
  }

  triggerBump(): void {
    this.bumpUntil = Date.now() + 1400;
    this.pitchDeg = -10;
    if (this.soundEnabled) playBrowserSynth(3, 250);
    this.synthUntil = Date.now() + 260;
    this.emitAll();
  }

  triggerTap(): void {
    this.tapUntil = Date.now() + 1200;
    if (this.soundEnabled) playBrowserSynth(2, 220);
    this.synthUntil = Date.now() + 240;
    this.emitAll();
  }

  presentColorBrick(colorId: number): void {
    this.chestLedState = ChestLedState.OFF;
    this.colorId = colorId;
    this.distancePct = colorId === 0 ? 78 : 18;
    // In Color Cards mode, react authentically!
    if (this.modeId === VernieMode.COLOR_CARDS && !this.safeMode) {
      if (colorId === 5) {
        // Green -> forward & cheer
        this.sendDrive(45, 45, 600);
        void this.sendSynth(0, 2, 0);
      } else if (colorId === 9) {
        // Red -> spin & squawk
        this.sendDrive(55, -55, 500);
        void this.sendSynth(0, 4, 0);
      } else if (colorId === 3) {
        // Blue -> victory dance
        this.sendDrive(-45, 45, 500);
        void this.sendSynth(0, 7, 0);
      } else if (colorId === 7 && this.savedMacro.length > 0) {
        // Yellow -> replay saved flash macro!
        void this.playMacro();
      }
    }
    this.emitAll();
  }
}
