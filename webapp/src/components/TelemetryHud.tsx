// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from "react";
import {
  ChestLedState,
  DartSubcmd,
  HEAD_HOME_SENTINEL,
  MACRO_MAX_BYTES,
  MACRO_STEP_BYTES,
  MacroStep,
  MacroStepOp,
  MODE_NAMES,
  TelemetryFlag,
  TelemetryFrame,
} from "../ble/protocol";
import { ConnectionState } from "../ble/vernieClient";

interface TelemetryHudProps {
  bleSupported: boolean;
  connectionState: ConnectionState;
  deviceName: string;
  telemetry: TelemetryFrame | null;
  rxHz: number;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onDrive: (left: number, right: number, timeoutMs?: number) => void;
  onHead: (angleDeg: number, speed?: number, coalesce?: boolean) => void;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetChestLed: (state: number) => void;
  onSetMode: (modeId: number) => void;
  onDartSubcmd: (subcmd: number) => void;
  onUploadMacro: (
    steps: MacroStep[],
    options: { saveToFlash?: boolean; playAfter?: boolean }
  ) => Promise<void>;
  onPlayMacro: () => Promise<void>;
  onStopMacro: () => Promise<void>;
  onClearMacro: () => Promise<void>;
}

const LED_PRESETS: Array<{ name: string; r: number; g: number; b: number; hex: string }> = [
  { name: "Boost Cyan", r: 0, g: 168, b: 232, hex: "#00a8e8" },
  { name: "Vernie Orange", r: 255, g: 122, b: 0, hex: "#ff7a00" },
  { name: "Emerald", r: 16, g: 220, b: 96, hex: "#10dc60" },
  { name: "Sentry Red", r: 255, g: 24, b: 24, hex: "#ff1818" },
  { name: "Ultraviolet", r: 170, g: 40, b: 255, hex: "#aa28ff" },
];

const CHEST_LED_BUTTONS: Array<{ label: string; state: number }> = [
  { label: "Off (Sense)", state: ChestLedState.OFF },
  { label: "Blue", state: ChestLedState.BLUE },
  { label: "Green", state: ChestLedState.GREEN },
  { label: "Red", state: ChestLedState.RED },
];

const SFX_PRESETS: Array<{ label: string; id: number }> = [
  { label: "Boot Chime", id: 1 },
  { label: "Happy Chirp", id: 2 },
  { label: "Curious Beep", id: 3 },
  { label: "Alarm Squawk", id: 4 },
  { label: "Warning Siren", id: 5 },
  { label: "Laser Zap", id: 6 },
  { label: "Victory", id: 7 },
];

const MIDI_NOTES: Array<{ label: string; midi: number }> = [
  { label: "C5", midi: 72 },
  { label: "E5", midi: 76 },
  { label: "G5", midi: 79 },
  { label: "C6", midi: 84 },
];

const LEGO_COLOR_NAMES: Record<number, string> = {
  0: "Black / None",
  3: "Blue",
  5: "Green",
  7: "Yellow",
  9: "Red",
  10: "White",
};

export interface MacroPreset {
  id: string;
  label: string;
  summary: string;
  steps: MacroStep[];
}

export const MACRO_PRESETS: MacroPreset[] = [
  {
    id: "victory-dance",
    label: "Victory Dance",
    summary: "Emerald LED · Victory chiptune · Left/Right wiggle · Center head",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 2, durMs: 120 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 7, durMs: 600 },
      { op: MacroStepOp.HEAD, arg0: -30, arg1: 70, durMs: 300 },
      { op: MacroStepOp.DRIVE, arg0: 50, arg1: -50, durMs: 400 },
      { op: MacroStepOp.HEAD, arg0: 30, arg1: 70, durMs: 300 },
      { op: MacroStepOp.DRIVE, arg0: -50, arg1: 50, durMs: 400 },
      { op: MacroStepOp.HEAD, arg0: 0, arg1: 60, durMs: 250 },
    ],
  },
  {
    id: "desk-patrol",
    label: "Desk Patrol",
    summary: "Cyan LED · Short forward cruise · Left/Right scan · Return",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 0, durMs: 120 },
      { op: MacroStepOp.DRIVE, arg0: 40, arg1: 40, durMs: 650 },
      { op: MacroStepOp.HEAD, arg0: -35, arg1: 60, durMs: 450 },
      { op: MacroStepOp.HEAD, arg0: 35, arg1: 60, durMs: 450 },
      { op: MacroStepOp.HEAD, arg0: 0, arg1: 60, durMs: 250 },
      { op: MacroStepOp.DRIVE, arg0: -40, arg1: -40, durMs: 650 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 2, durMs: 350 },
    ],
  },
  {
    id: "r2-greeting",
    label: "R2-D2 Greeting",
    summary: "Orange LED · Boot chime · Friendly head nod · Curious beep",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 1, durMs: 120 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 1, durMs: 500 },
      { op: MacroStepOp.HEAD, arg0: 25, arg1: 65, durMs: 300 },
      { op: MacroStepOp.HEAD, arg0: -25, arg1: 65, durMs: 300 },
      { op: MacroStepOp.HEAD, arg0: 0, arg1: 65, durMs: 250 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 3, durMs: 400 },
    ],
  },
];

export const TelemetryHud: React.FC<TelemetryHudProps> = ({
  bleSupported,
  connectionState,
  deviceName,
  telemetry,
  rxHz,
  error,
  onConnect,
  onDisconnect,
  onDrive,
  onHead,
  onSynth,
  onSetHubLed,
  onSetChestLed,
  onSetMode,
  onDartSubcmd,
  onUploadMacro,
  onPlayMacro,
  onStopMacro,
  onClearMacro,
}) => {
  const [headSlider, setHeadSlider] = useState(0);
  const [synthVoice, setSynthVoice] = useState(0);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(MACRO_PRESETS[0].id);
  const [macroBusy, setMacroBusy] = useState(false);
  const [macroStatus, setMacroStatus] = useState<string | null>(null);

  useEffect(() => {
    if (connectionState === "disconnected") {
      setHeadSlider(0);
      setMacroStatus(null);
    }
  }, [connectionState]);

  const selectedPreset =
    MACRO_PRESETS.find((p) => p.id === selectedPresetId) ?? MACRO_PRESETS[0];

  const runMacroAction = async (label: string, fn: () => Promise<void>) => {
    setMacroBusy(true);
    setMacroStatus(null);
    try {
      await fn();
      setMacroStatus(label);
    } catch {
      // Error surfaced via parent bleError banner
    } finally {
      setMacroBusy(false);
    }
  };

  const safeMode = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SAFE_MODE));
  const dartArmed = Boolean(telemetry && (telemetry.flags & TelemetryFlag.DART_ARMED));
  const headHomed = Boolean(telemetry && (telemetry.flags & TelemetryFlag.HEAD_HOMED));
  const sensorOk = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SENSOR_OK));
  const pickedUp = Boolean(telemetry && (telemetry.flags & TelemetryFlag.PICKED_UP));
  const bump = Boolean(telemetry && (telemetry.flags & TelemetryFlag.BUMP));
  const btnOrTap = Boolean(telemetry && (telemetry.flags & TelemetryFlag.TAP));
  const synthActive = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SYNTH_ACTIVE));

  const battVolts = telemetry ? (telemetry.batteryMv / 1000).toFixed(2) : "--";
  const battPct = telemetry
    ? Math.max(0, Math.min(100, Math.round(((telemetry.batteryMv - 6000) / (9000 - 6000)) * 100)))
    : 0;

  // Require first telemetry packet to confirm !safeMode before enabling motion/arm/synth buttons.
  const motionControlsDisabled = connectionState !== "connected" || !telemetry || safeMode;
  const distText =
    telemetry && telemetry.distancePct <= 100 ? `${telemetry.distancePct}%` : "N/A";
  const colorText = telemetry
    ? LEGO_COLOR_NAMES[telemetry.colorId] ?? `ID ${telemetry.colorId}`
    : "--";

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Live Vernie OS Telemetry &amp; Autonomous Cockpit</h2>
          <p className="subtitle">
            Pybricks GATT (<code>0xC5F50001</code>) · 18-byte AppData stream · 10 Hz live sensors.
          </p>
        </div>
        <div className="action-row">
          {connectionState === "connected" ? (
            <button className="btn btn-danger" onClick={onDisconnect}>
              Disconnect {deviceName}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={onConnect}
              disabled={!bleSupported || connectionState === "connecting"}
            >
              {connectionState === "connecting" ? "Connecting…" : "Connect to VernieOS"}
            </button>
          )}
        </div>
      </div>

      {safeMode && (
        <div className="alert alert-warn">
          <strong>Watchdog Safe Mode Active:</strong> Hub rebooted from an IWDG watchdog timeout.
          Motion &amp; synth commands are locked out for safety. Use Step 1 in the flasher to
          re-flash or power-cycle.
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      <div className="telemetry-grid">
        <div className="metric">
          <span className="label">Battery Voltage</span>
          <div className="metric-val">
            {battVolts} <small>V</small>
          </div>
          <div className="mini-bar">
            <div
              className={`mini-fill ${telemetry && telemetry.batteryMv < 6600 ? "fill-warn" : "fill-ok"}`}
              style={{ width: `${battPct}%` }}
            />
          </div>
          <span className="meta">
            {telemetry ? `${telemetry.batteryMv} mV (6× AAA)` : "Waiting for hub…"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Active Mode</span>
          <div className="metric-val">
            {telemetry ? MODE_NAMES[telemetry.modeId] ?? `Mode ${telemetry.modeId}` : "Offline"}
          </div>
          <span className="meta">
            {telemetry ? `Seq #${telemetry.seq} · ${rxHz.toFixed(1)} Hz` : "Not connected"}
          </span>
        </div>

        <div className="metric">
          <span className="label">LIS3DH Torso IMU</span>
          <div className="metric-val">
            {telemetry ? `${telemetry.pitchDeg}° / ${telemetry.rollDeg}°` : "-- / --"}
          </div>
          <div className="flag-row">
            <span className={`pill ${pickedUp ? "pill-danger" : ""}`}>
              {pickedUp ? "PICKED UP" : "UPRIGHT"}
            </span>
            <span className={`pill ${bump ? "pill-active" : ""}`}>
              {bump ? "BUMP" : "CLEAR"}
            </span>
            <span className={`pill ${btnOrTap ? "pill-active" : ""}`}>
              {btnOrTap ? "TAP/BTN" : "IDLE"}
            </span>
          </div>
        </div>

        <div className="metric">
          <span className="label">88007 Chest Sensor</span>
          <div className="metric-val">{distText}</div>
          <span className="meta">
            {sensorOk ? `Color: ${colorText}` : "Sensor absent or in Chest LED mode"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Encoders &amp; Head</span>
          <div className="metric-val">
            {telemetry ? `${telemetry.headDeg}°` : "--"}
          </div>
          <span className="meta">
            {telemetry
              ? `A:${telemetry.encA}° B:${telemetry.encB}° · ${headHomed ? "HOMED" : "UNHOMED"}`
              : "Waiting for hub…"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Dart Lock &amp; Synth</span>
          <div className="flag-row">
            <span className={`pill ${dartArmed ? "pill-danger" : ""}`}>
              {dartArmed ? "ARMED" : "DISARMED"}
            </span>
            <span className={`pill ${synthActive ? "pill-active" : ""}`}>
              {synthActive ? "SYNTH ON" : "SILENT"}
            </span>
          </div>
          <span className="meta">Disarmed on boot, disconnect &amp; after fire</span>
        </div>
      </div>

      <div className="diag-section">
        <h3>Hardware Controls, Autonomous Modes &amp; Flash Macros</h3>

        <div className="diag-row">
          <span className="label">Track Drive Pulse (0x01, 400 ms dead-man):</span>
          <div className="swatch-row">
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled}
              onClick={() => onDrive(45, 45, 400)}
            >
              Forward
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled}
              onClick={() => onDrive(-45, -45, 400)}
            >
              Reverse
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled}
              onClick={() => onDrive(-40, 40, 400)}
            >
              Spin Left
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled}
              onClick={() => onDrive(40, -40, 400)}
            >
              Spin Right
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={connectionState !== "connected"}
              onClick={() => onDrive(0, 0, 200)}
            >
              STOP
            </button>
          </div>
        </div>

        <div className="diag-row">
          <span className="label">
            Head Homing &amp; Angle (0x02, safe -40°..+35° · {headHomed ? "Homed" : "Home Head first"}):
          </span>
          <div className="swatch-row">
            <button
              className="btn btn-sm btn-secondary"
              disabled={motionControlsDisabled}
              onClick={() => onHead(HEAD_HOME_SENTINEL, 30)}
              title="Non-trigger single-direction stall homing (remove dart first!)"
            >
              Home Head (Non-Trigger)
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled || !headHomed}
              title={headHomed ? "Turn head to -35°" : "Home Head first before positioning"}
              onClick={() => {
                setHeadSlider(-35);
                onHead(-35, 50);
              }}
            >
              -35°
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled || !headHomed}
              title={headHomed ? "Center head to 0°" : "Home Head first before positioning"}
              onClick={() => {
                setHeadSlider(0);
                onHead(0, 50);
              }}
            >
              0°
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled || !headHomed}
              title={headHomed ? "Turn head to +35°" : "Home Head first before positioning"}
              onClick={() => {
                setHeadSlider(35);
                onHead(35, 50);
              }}
            >
              +35°
            </button>
            <input
              aria-label="Head target angle"
              className="angle-slider"
              type="range"
              min={-40}
              max={35}
              value={headSlider}
              disabled={motionControlsDisabled || !headHomed}
              onChange={(e) => {
                const deg = Number(e.target.value);
                setHeadSlider(deg);
                onHead(deg, 50, true);
              }}
            />
            <span className="meta">{headSlider}°</span>
          </div>
        </div>

        <div className="diag-row">
          <span className="label">Dart Launcher 2-Step Safety (0x03):</span>
          <div className="swatch-row">
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled}
              onClick={() => onDartSubcmd(DartSubcmd.ARM)}
            >
              Arm Lock (0xA5)
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={motionControlsDisabled || !dartArmed || !headHomed}
              onClick={() => onDartSubcmd(DartSubcmd.FIRE)}
              title="Requires Armed + Head Homed"
            >
              Fire Dart
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={connectionState !== "connected"}
              onClick={() => onDartSubcmd(DartSubcmd.DISARM)}
            >
              Disarm Lock
            </button>
          </div>
        </div>

        <div className="diag-row">
          <span className="label">2-Voice Bipolar Singing-Motor Synth (0x04):</span>
          <div className="swatch-row">
            {[
              { v: 0, label: "Auto" },
              { v: 1, label: "V1 Tracks (TIM1)" },
              { v: 2, label: "V2 Head (TIM3)" },
            ].map((opt) => (
              <button
                key={opt.v}
                className={`btn btn-sm ${synthVoice === opt.v ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setSynthVoice(opt.v)}
              >
                {opt.label}
              </button>
            ))}
            <button
              className="btn btn-sm btn-danger"
              disabled={connectionState !== "connected"}
              onClick={() => onSynth(0, 0, 0)}
            >
              Stop Synth
            </button>
          </div>
          <div className="swatch-row">
            {SFX_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn btn-sm btn-ghost"
                disabled={motionControlsDisabled}
                onClick={() => onSynth(synthVoice, p.id, 0)}
              >
                {p.label}
              </button>
            ))}
            {MIDI_NOTES.map((n) => (
              <button
                key={n.midi}
                className="btn btn-sm btn-ghost"
                disabled={motionControlsDisabled}
                onClick={() => onSynth(synthVoice, n.midi, 280)}
              >
                ♪ {n.label}
              </button>
            ))}
          </div>
        </div>

        <div className="diag-row">
          <span className="label">Hub RGB LED &amp; 88007 Chest LED (0x05):</span>
          <div className="swatch-row">
            {LED_PRESETS.map((p) => (
              <button
                key={p.name}
                className="swatch-btn"
                disabled={connectionState !== "connected"}
                onClick={() => onSetHubLed(p.r, p.g, p.b)}
                title={p.name}
              >
                <span className="swatch-dot" style={{ background: p.hex }} />
                {p.name}
              </button>
            ))}
          </div>
          <div className="swatch-row">
            {CHEST_LED_BUTTONS.map((c) => (
              <button
                key={c.label}
                className="btn btn-sm btn-ghost"
                disabled={connectionState !== "connected"}
                onClick={() => onSetChestLed(c.state)}
              >
                Chest: {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="diag-row">
          <span className="label">Autonomous Brain Mode Switch (0x06 · or green button / double-tap torso):</span>
          <div className="swatch-row">
            {[0, 1, 2, 3, 4].map((m) => (
              <button
                key={m}
                className={`btn btn-sm ${telemetry?.modeId === m ? "btn-primary" : "btn-ghost"}`}
                disabled={motionControlsDisabled}
                onClick={() => onSetMode(m)}
              >
                {m}: {MODE_NAMES[m]}
              </button>
            ))}
          </div>
          <span className="meta">
            0 Pet (hand-shy + pickup alarm) · 1 Explorer (IR+bump scan) · 2 Sentry (1.5 s lock, armed-only dart) · 3 Color Cards (G/R/B/Y ≥ 250 ms close) · 4 Remote
          </span>
        </div>

        <div className="diag-row">
          <span className="label">
            Flash Macro Sequencer (0x07 → <code>FLASH_USER_1</code> · {selectedPreset.steps.length} steps ·{" "}
            {selectedPreset.steps.length * MACRO_STEP_BYTES}/{MACRO_MAX_BYTES} B · no dart opcode):
          </span>
          <div className="swatch-row">
            {MACRO_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`btn btn-sm ${selectedPresetId === preset.id ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setSelectedPresetId(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <span className="meta">{selectedPreset.summary}</span>
          <div className="swatch-row">
            <button
              className="btn btn-sm btn-secondary"
              disabled={motionControlsDisabled || macroBusy}
              onClick={() =>
                void runMacroAction(`Playing "${selectedPreset.label}"`, () =>
                  onUploadMacro(selectedPreset.steps, { playAfter: true })
                )
              }
            >
              Upload &amp; Play
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled || macroBusy}
              onClick={() =>
                void runMacroAction(
                  `Saved "${selectedPreset.label}" to FLASH_USER_1 (Yellow card triggers offline!)`,
                  () => onUploadMacro(selectedPreset.steps, { saveToFlash: true })
                )
              }
            >
              Save to Flash (Yellow Card)
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled || macroBusy}
              onClick={() => void runMacroAction("Playing saved macro", onPlayMacro)}
            >
              Play Saved
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={connectionState !== "connected" || macroBusy}
              onClick={() => void runMacroAction("Macro stopped", onStopMacro)}
            >
              Stop Macro
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled || macroBusy}
              onClick={() => void runMacroAction("Cleared saved macro from FLASH_USER_1", onClearMacro)}
            >
              Clear Flash Macro
            </button>
          </div>
          {macroStatus && <span className="meta">{macroStatus}</span>}
        </div>
      </div>
    </section>
  );
};
