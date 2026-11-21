// SPDX-License-Identifier: MIT
// 2-Voice Bipolar Singing-Motor Piano, R2-D2 Soundboard & Hub/Chest LED Controller.

import React, { useState } from "react";
import { ChestLedState } from "../ble/protocol";

export interface MotorSynthPadProps {
  connected: boolean;
  disabled: boolean;
  synthActive: boolean;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetChestLed: (state: number) => void;
}

const SFX_PRESETS: Array<{ label: string; id: number }> = [
  { label: "Boot Chime", id: 1 },
  { label: "Happy Chirp", id: 2 },
  { label: "Curious Beep", id: 3 },
  { label: "Alarm Squawk", id: 4 },
  { label: "Warning Siren", id: 5 },
  { label: "Laser Zap", id: 6 },
  { label: "Victory", id: 7 },
];

const PIANO_KEYS: Array<{ label: string; midi: number; sharp?: boolean }> = [
  { label: "C5", midi: 72 },
  { label: "C#", midi: 73, sharp: true },
  { label: "D5", midi: 74 },
  { label: "D#", midi: 75, sharp: true },
  { label: "E5", midi: 76 },
  { label: "F5", midi: 77 },
  { label: "F#", midi: 78, sharp: true },
  { label: "G5", midi: 79 },
  { label: "G#", midi: 80, sharp: true },
  { label: "A5", midi: 81 },
  { label: "A#", midi: 82, sharp: true },
  { label: "B5", midi: 83 },
  { label: "C6", midi: 84 },
];

const LED_PRESETS: Array<{ name: string; r: number; g: number; b: number; hex: string }> = [
  { name: "Boost Cyan", r: 0, g: 168, b: 232, hex: "#00a8e8" },
  { name: "Vernie Orange", r: 255, g: 122, b: 0, hex: "#ff7a00" },
  { name: "Emerald", r: 16, g: 220, b: 96, hex: "#10dc60" },
  { name: "Sentry Red", r: 255, g: 24, b: 24, hex: "#ff1818" },
  { name: "Solar Yellow", r: 255, g: 210, b: 0, hex: "#ffd200" },
];

const CHEST_LED_BUTTONS: Array<{ label: string; state: number }> = [
  { label: "Off (Sense)", state: ChestLedState.OFF },
  { label: "Blue", state: ChestLedState.BLUE },
  { label: "Green", state: ChestLedState.GREEN },
  { label: "Red", state: ChestLedState.RED },
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = Number.parseInt(clean, 16);
  if (Number.isNaN(n)) return [0, 168, 232];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const MotorSynthPad: React.FC<MotorSynthPadProps> = ({
  connected,
  disabled,
  synthActive,
  onSynth,
  onSetHubLed,
  onSetChestLed,
}) => {
  const [voice, setVoice] = useState(0);
  const [noteDurMs, setNoteDurMs] = useState(280);
  const [customHex, setCustomHex] = useState("#00a8e8");

  return (
    <div className="panel-stack">
      <section className="card">
        <div className="card-header">
          <div>
            <h2>2-Voice Bipolar Singing-Motor Synth (0x04)</h2>
            <p className="subtitle">
              Zero-DC-creep TIM1/TIM3 hardware PWM · ≤ 15% duty · 3 s thermal watchdog
            </p>
          </div>
          <span className={`pill ${synthActive ? "pill-active" : ""}`}>
            {synthActive ? "SYNTH ACTIVE" : "SILENT"}
          </span>
        </div>

        <div className="diag-row">
          <span className="label">Voice Routing &amp; Note Length</span>
          <div className="swatch-row">
            {[
              { v: 0, label: "Auto (Free Voice)" },
              { v: 1, label: "V1 Tracks (TIM1)" },
              { v: 2, label: "V2 Head (TIM3)" },
            ].map((opt) => (
              <button
                key={opt.v}
                className={`btn btn-sm ${voice === opt.v ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setVoice(opt.v)}
              >
                {opt.label}
              </button>
            ))}
            {[150, 280, 500].map((ms) => (
              <button
                key={ms}
                className={`btn btn-sm ${noteDurMs === ms ? "btn-secondary" : "btn-ghost"}`}
                onClick={() => setNoteDurMs(ms)}
              >
                {ms} ms
              </button>
            ))}
            <button
              id="btn-stop-synth"
              className="btn btn-sm btn-danger"
              disabled={!connected}
              onClick={() => onSynth(0, 0, 0)}
            >
              Stop Synth
            </button>
          </div>
        </div>

        <div className="diag-row">
          <span className="label">R2-D2 SFX Soundboard</span>
          <div className="swatch-row">
            {SFX_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn btn-sm btn-ghost"
                disabled={disabled}
                onClick={() => onSynth(voice, p.id, 0)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="diag-row">
          <span className="label">Playable Motor Piano (C5–C6 · MIDI 72–84)</span>
          <div className="piano-row" role="group" aria-label="Singing motor piano keyboard">
            {PIANO_KEYS.map((k) => (
              <button
                key={k.midi}
                className={`piano-key ${k.sharp ? "piano-sharp" : "piano-natural"}`}
                disabled={disabled}
                onClick={() => onSynth(voice, k.midi, noteDurMs)}
                title={`Play ${k.label} (MIDI ${k.midi}) for ${noteDurMs} ms`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Hub RGB &amp; 88007 Chest LED (0x05)</h2>
            <p className="subtitle">
              Hub RGB mood override · 88007 4-state chest LED (select Off to resume color/distance sensing)
            </p>
          </div>
        </div>

        <div className="diag-row">
          <span className="label">Move Hub RGB LED</span>
          <div className="swatch-row">
            {LED_PRESETS.map((p) => (
              <button
                key={p.name}
                className="swatch-btn"
                disabled={!connected}
                onClick={() => {
                  setCustomHex(p.hex);
                  onSetHubLed(p.r, p.g, p.b);
                }}
              >
                <span className="swatch-dot" style={{ background: p.hex }} />
                {p.name}
              </button>
            ))}
            <label className="swatch-btn">
              <span>Custom:</span>
              <input
                aria-label="Custom Hub RGB color"
                type="color"
                value={customHex}
                disabled={!connected}
                onChange={(e) => {
                  const hex = e.target.value;
                  setCustomHex(hex);
                  const [r, g, b] = hexToRgb(hex);
                  onSetHubLed(r, g, b);
                }}
              />
            </label>
          </div>
        </div>

        <div className="diag-row">
          <span className="label">88007 Chest Sensor LED (COL_O ↔ SPEC1)</span>
          <div className="swatch-row">
            {CHEST_LED_BUTTONS.map((c) => (
              <button
                key={c.label}
                className="btn btn-sm btn-ghost"
                disabled={!connected}
                onClick={() => onSetChestLed(c.state)}
              >
                Chest: {c.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};
