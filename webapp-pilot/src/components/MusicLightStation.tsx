// SPDX-License-Identifier: MIT
// Station 2 — Music & Lights: Authentic Piano Keyboard (C5-C6), 7 R2-D2 Sound Pads,
// Quick Playable Melodies, Move Hub RGB Studio, and 88007 Chest Sensor Light.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChestLedState } from "@core/ble/protocol";
import { IconPlay, IconStop } from "./Icons";

export interface MusicLightStationProps {
  connected: boolean;
  disabled: boolean;
  synthActive: boolean;
  hubRgb: [number, number, number];
  chestLedState: number;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetChestLed: (state: number) => void;
}

const WHITE_KEYS = [
  { label: "C5", midi: 72, kbd: "A" },
  { label: "D5", midi: 74, kbd: "S" },
  { label: "E5", midi: 76, kbd: "D" },
  { label: "F5", midi: 77, kbd: "F" },
  { label: "G5", midi: 79, kbd: "G" },
  { label: "A5", midi: 81, kbd: "H" },
  { label: "B5", midi: 83, kbd: "J" },
  { label: "C6", midi: 84, kbd: "K" },
];

// Positioned over the seams between the 8 white keys (each white key = 12.5% width)
const BLACK_KEYS = [
  { label: "C#", midi: 73, kbd: "W", leftPct: 12.5 },
  { label: "D#", midi: 75, kbd: "E", leftPct: 25.0 },
  { label: "F#", midi: 78, kbd: "T", leftPct: 50.0 },
  { label: "G#", midi: 80, kbd: "Y", leftPct: 62.5 },
  { label: "A#", midi: 82, kbd: "U", leftPct: 75.0 },
];

const KEYBOARD_MIDI_MAP: Record<string, number> = {
  KeyA: 72,
  KeyW: 73,
  KeyS: 74,
  KeyE: 75,
  KeyD: 76,
  KeyF: 77,
  KeyT: 78,
  KeyG: 79,
  KeyY: 80,
  KeyH: 81,
  KeyU: 82,
  KeyJ: 83,
  KeyK: 84,
};

const SFX_PADS = [
  { id: 1, label: "Startup Chime", tag: "4-NOTE", accent: "#0EA5E9" },
  { id: 2, label: "Happy Chirp", tag: "GREET", accent: "#16A34A" },
  { id: 3, label: "Curious Beep", tag: "ASK", accent: "#0284C7" },
  { id: 4, label: "Pickup Squawk", tag: "REACT", accent: "#EA580C" },
  { id: 5, label: "Sentry Siren", tag: "ALERT", accent: "#DC2626" },
  { id: 6, label: "Laser Zap", tag: "FX", accent: "#F59E0B" },
  { id: 7, label: "Victory Fanfare", tag: "WIN", accent: "#10B981" },
];

const QUICK_MELODIES: Array<{
  id: string;
  label: string;
  notes: Array<{ midi: number; dur: number; gap: number }>;
}> = [
  {
    id: "fanfare",
    label: "Robot Fanfare",
    notes: [
      { midi: 72, dur: 160, gap: 190 },
      { midi: 76, dur: 160, gap: 190 },
      { midi: 79, dur: 160, gap: 190 },
      { midi: 84, dur: 380, gap: 400 },
    ],
  },
  {
    id: "scale",
    label: "Bright Scale",
    notes: [
      { midi: 72, dur: 140, gap: 170 },
      { midi: 74, dur: 140, gap: 170 },
      { midi: 76, dur: 140, gap: 170 },
      { midi: 77, dur: 140, gap: 170 },
      { midi: 79, dur: 140, gap: 170 },
      { midi: 81, dur: 140, gap: 170 },
      { midi: 83, dur: 140, gap: 170 },
      { midi: 84, dur: 280, gap: 300 },
    ],
  },
  {
    id: "twinkle",
    label: "Star Melody",
    notes: [
      { midi: 72, dur: 200, gap: 240 },
      { midi: 72, dur: 200, gap: 240 },
      { midi: 79, dur: 200, gap: 240 },
      { midi: 79, dur: 200, gap: 240 },
      { midi: 81, dur: 200, gap: 240 },
      { midi: 81, dur: 200, gap: 240 },
      { midi: 79, dur: 380, gap: 400 },
    ],
  },
];

const HUB_COLORS = [
  { name: "Boost Cyan", r: 0, g: 168, b: 232, hex: "#00A8E8" },
  { name: "Vernie Orange", r: 255, g: 122, b: 0, hex: "#FF7A00" },
  { name: "LEGO Green", r: 16, g: 220, b: 96, hex: "#10DC60" },
  { name: "Sentry Red", r: 255, g: 24, b: 24, hex: "#FF1818" },
  { name: "Solar Yellow", r: 255, g: 210, b: 0, hex: "#FFD200" },
  { name: "Studio White", r: 245, g: 248, b: 255, hex: "#F5F8FF" },
];

const CHEST_MODES = [
  { label: "Sense Mode (Off)", sub: "Reads distance & bricks", state: ChestLedState.OFF, dot: "#64748B" },
  { label: "Blue Light", sub: "Solid chest beacon", state: ChestLedState.BLUE, dot: "#38BDF8" },
  { label: "Green Light", sub: "Solid chest beacon", state: ChestLedState.GREEN, dot: "#22C55E" },
  { label: "Red Light", sub: "Solid chest beacon", state: ChestLedState.RED, dot: "#EF4444" },
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = Number.parseInt(clean, 16);
  if (Number.isNaN(n)) return [0, 168, 232];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  return (
    "#" +
    rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")
  );
}

export const MusicLightStation: React.FC<MusicLightStationProps> = ({
  connected,
  disabled,
  synthActive,
  hubRgb,
  chestLedState,
  onSynth,
  onSetHubLed,
  onSetChestLed,
}) => {
  const [voice, setVoice] = useState(0);
  const [noteDurMs, setNoteDurMs] = useState(280);
  const [activeMidi, setActiveMidi] = useState<number | null>(null);
  const [kbdPlay, setKbdPlay] = useState(true);
  const [playingMelody, setPlayingMelody] = useState<string | null>(null);
  const [customHex, setCustomHex] = useState(() => rgbToHex(hubRgb));

  const melodyTimersRef = useRef<number[]>([]);
  const activeKeyTimerRef = useRef<number | null>(null);

  const cancelMelody = useCallback(() => {
    for (const id of melodyTimersRef.current) {
      window.clearTimeout(id);
    }
    melodyTimersRef.current = [];
    setPlayingMelody(null);
  }, []);

  useEffect(() => {
    setCustomHex(rgbToHex(hubRgb));
  }, [hubRgb]);

  useEffect(() => {
    if (!connected || disabled) {
      cancelMelody();
    }
  }, [connected, disabled, cancelMelody]);

  useEffect(() => {
    return () => {
      cancelMelody();
      if (activeKeyTimerRef.current) window.clearTimeout(activeKeyTimerRef.current);
    };
  }, [cancelMelody]);

  const playNote = useCallback(
    (midi: number, dur = noteDurMs) => {
      if (disabled) return;
      onSynth(voice, midi, dur);
      setActiveMidi(midi);
      if (activeKeyTimerRef.current) window.clearTimeout(activeKeyTimerRef.current);
      activeKeyTimerRef.current = window.setTimeout(() => setActiveMidi(null), Math.min(dur, 260));
    },
    [disabled, noteDurMs, onSynth, voice]
  );

  // Computer keyboard piano playing (A-K & W,E,T,Y,U)
  useEffect(() => {
    if (!kbdPlay || disabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) {
        return;
      }
      const midi = KEYBOARD_MIDI_MAP[e.code];
      if (midi !== undefined) {
        e.preventDefault();
        playNote(midi);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [kbdPlay, disabled, playNote]);

  const runMelody = (melodyId: string) => {
    cancelMelody();
    const melody = QUICK_MELODIES.find((m) => m.id === melodyId);
    if (!melody || disabled) return;
    setPlayingMelody(melodyId);
    let offset = 0;
    melody.notes.forEach((n, idx) => {
      const tid = window.setTimeout(() => {
        playNote(n.midi, n.dur);
        if (idx === melody.notes.length - 1) {
          const endId = window.setTimeout(() => setPlayingMelody(null), n.dur + 80);
          melodyTimersRef.current.push(endId);
        }
      }, offset);
      melodyTimersRef.current.push(tid);
      offset += n.gap;
    });
  };

  const handleStopAudio = () => {
    cancelMelody();
    setActiveMidi(null);
    onSynth(0, 0, 0);
  };

  const hubPreviewCss = `rgb(${hubRgb[0]}, ${hubRgb[1]}, ${hubRgb[2]})`;

  return (
    <div className="station-stack">
      {/* SINGING-MOTOR PIANO & SYNTH */}
      <section className="console-panel" aria-label="Singing motor piano">
        <div className="panel-head">
          <div>
            <h2>Singing-Motor Piano</h2>
            <p className="panel-sub">
              Vibrates the motor coils to play clean notes without moving Vernie&apos;s wheels
            </p>
          </div>
          <div className="synth-head-right">
            <div className={`eq-meter ${synthActive ? "is-singing" : ""}`} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <button
              type="button"
              id="btn-pilot-stop-synth"
              className="keycap keycap-stop keycap-sm"
              disabled={!connected}
              onClick={handleStopAudio}
            >
              <IconStop size={12} />
              <span>Silence</span>
            </button>
          </div>
        </div>

        {/* Voice routing & note length hardware controls */}
        <div className="synth-toolbar">
          <div className="toolbar-group">
            <span className="engraved-label">Motor Voice</span>
            <div className="segmented-mini" role="group" aria-label="Motor voice routing">
              {[
                { v: 0, label: "Auto" },
                { v: 1, label: "Wheels" },
                { v: 2, label: "Head" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  className={voice === opt.v ? "is-active" : ""}
                  onClick={() => setVoice(opt.v)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-group">
            <span className="engraved-label">Note Length</span>
            <div className="segmented-mini" role="group" aria-label="Note duration">
              {[
                { ms: 150, label: "Short" },
                { ms: 280, label: "Normal" },
                { ms: 500, label: "Long" },
              ].map((opt) => (
                <button
                  key={opt.ms}
                  type="button"
                  className={noteDurMs === opt.ms ? "is-active" : ""}
                  onClick={() => setNoteDurMs(opt.ms)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <label className="toggle-check">
            <input
              type="checkbox"
              checked={kbdPlay}
              onChange={(e) => setKbdPlay(e.target.checked)}
            />
            <span>Play with A–K keys</span>
          </label>
        </div>

        {/* Authentic Piano Keyboard Geometry */}
        <div className="piano-chassis" role="group" aria-label="Singing motor piano keyboard">
          <div className="piano-white-layer">
            {WHITE_KEYS.map((k) => (
              <button
                key={k.midi}
                type="button"
                className={`key-white ${activeMidi === k.midi ? "is-pressed" : ""}`}
                disabled={disabled}
                onPointerDown={() => playNote(k.midi)}
                aria-label={`${k.label} (MIDI ${k.midi})`}
              >
                <span className="key-shortcut">{k.kbd}</span>
                <span className="key-note">{k.label}</span>
              </button>
            ))}
          </div>
          <div className="piano-black-layer">
            {BLACK_KEYS.map((k) => (
              <button
                key={k.midi}
                type="button"
                className={`key-black ${activeMidi === k.midi ? "is-pressed" : ""}`}
                style={{ left: `${k.leftPct}%` }}
                disabled={disabled}
                onPointerDown={() => playNote(k.midi)}
                aria-label={`${k.label} (MIDI ${k.midi})`}
              >
                <span className="key-shortcut-dark">{k.kbd}</span>
                <span className="key-note-dark">{k.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Quick Playable Melodies */}
        <div className="melody-bar">
          <span className="engraved-label">Quick Tunes</span>
          <div className="chip-row">
            {QUICK_MELODIES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`chip-btn ${playingMelody === m.id ? "chip-btn-active" : ""}`}
                disabled={disabled}
                onClick={() => runMelody(m.id)}
              >
                <IconPlay size={11} />
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 7 R2-D2 SOUNDBOARD PADS */}
      <section className="console-panel" aria-label="Robot soundboard">
        <div className="panel-head">
          <div>
            <h2>Robot Soundboard</h2>
            <p className="panel-sub">Tap a tactile pad for instant expressive robot vocalizations</p>
          </div>
        </div>
        <div className="sfx-pad-grid">
          {SFX_PADS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="sfx-pad"
              disabled={disabled}
              onClick={() => onSynth(voice, p.id, 0)}
            >
              <span className="sfx-pad-led" style={{ background: p.accent }} />
              <span className="sfx-pad-tag">{p.tag}</span>
              <strong className="sfx-pad-name">{p.label}</strong>
            </button>
          ))}
        </div>
      </section>

      {/* HUB RGB & CHEST SENSOR LIGHT STUDIO */}
      <section className="console-panel" aria-label="Robot light studio">
        <div className="panel-head">
          <div>
            <h2>Light Studio</h2>
            <p className="panel-sub">
              Customize Vernie&apos;s Move Hub glow and chest sensor beacon
            </p>
          </div>
          <div className="orb-preview-wrap" aria-label="Active Hub LED color">
            <span
              className="hub-orb"
              style={{
                background: hubPreviewCss,
                boxShadow: `0 0 20px ${hubPreviewCss}`,
              }}
            />
            <span className="mono-readout-muted">{customHex.toUpperCase()}</span>
          </div>
        </div>

        <div className="light-studio-grid">
          <div className="light-group">
            <span className="engraved-label">Move Hub Button Light</span>
            <div className="swatch-grid">
              {HUB_COLORS.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className="color-tile"
                  disabled={!connected}
                  onClick={() => {
                    setCustomHex(c.hex);
                    onSetHubLed(c.r, c.g, c.b);
                  }}
                >
                  <span className="color-tile-dot" style={{ background: c.hex }} />
                  <span>{c.name}</span>
                </button>
              ))}
              <label className={`color-tile color-picker-tile ${!connected ? "is-disabled" : ""}`}>
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
                <span>Custom Color</span>
              </label>
            </div>
          </div>

          <div className="light-group">
            <span className="engraved-label">Chest Sensor Light</span>
            <div className="chest-mode-grid">
              {CHEST_MODES.map((m) => (
                <button
                  key={m.state}
                  type="button"
                  className={`chest-tile ${chestLedState === m.state ? "is-active" : ""}`}
                  disabled={!connected}
                  onClick={() => onSetChestLed(m.state)}
                >
                  <span className="chest-tile-head">
                    <span className="chip-dot" style={{ background: m.dot }} />
                    <strong>{m.label}</strong>
                  </span>
                  <span className="helper-micro">{m.sub}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
