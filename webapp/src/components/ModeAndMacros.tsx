// SPDX-License-Identifier: MIT
// Autonomous Mode Selector (Modes 0..4) & Visual Flash Macro Sequencer (0x07 -> FLASH_USER_1).

import React, { useEffect, useState } from "react";
import {
  ChestLedState,
  MACRO_MAX_BYTES,
  MACRO_MAX_STEPS,
  MACRO_STEP_BYTES,
  MacroStep,
  MacroStepOp,
  MODE_NAMES,
} from "../ble/protocol";

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

const MODE_DESCRIPTIONS: Record<number, { led: string; desc: string }> = {
  0: { led: "Breathing Blue", desc: "Idle looks & chirps, hand-shy backup, pickup alarm reflex" },
  1: { led: "Breathing Green", desc: "Cruises forward; avoids IR <=40% or IMU/stall bumps via head scan" },
  2: { led: "Breathing Red", desc: "Interleaved red chest pulse; 1.5 s lock; armed+homed-only dart" },
  3: { led: "Breathing Yellow", desc: "Close <=25% >=250 ms bricks: G=Go, R=Spin, B=Dance, Y=Flash Macro" },
  4: { led: "Breathing Purple", desc: "Yields cleanly to Web Bluetooth Cockpit, joystick & synth" },
};

const SFX_LABELS: Record<number, string> = {
  1: "Boot Chime",
  2: "Happy Chirp",
  3: "Curious Beep",
  4: "Alarm Squawk",
  5: "Warning Siren",
  6: "Laser Zap",
  7: "Victory",
};

const PALETTE_LABELS = ["Cyan", "Orange", "Emerald", "Red", "Ultraviolet", "Yellow"];

function describeStep(step: MacroStep): string {
  switch (step.op) {
    case MacroStepOp.DRIVE:
      return `DRIVE L:${step.arg0}% R:${step.arg1}% (${step.durMs} ms)`;
    case MacroStepOp.HEAD:
      return `HEAD ${step.arg0}° @ ${step.arg1}% (${step.durMs} ms)`;
    case MacroStepOp.SYNTH:
      return `SYNTH v${step.arg0} ${SFX_LABELS[step.arg1] ?? `MIDI ${step.arg1}`} (${step.durMs} ms)`;
    case MacroStepOp.LED:
      if (step.arg0 === 0) {
        return `HUB LED ${PALETTE_LABELS[step.arg1] ?? `#${step.arg1}`} (${step.durMs} ms)`;
      }
      return `CHEST LED state ${step.arg1} (${step.durMs} ms)`;
    default:
      return `WAIT (${step.durMs} ms)`;
  }
}

export interface ModeAndMacrosProps {
  connected: boolean;
  disabled: boolean;
  activeModeId: number | null;
  onSetMode: (modeId: number) => void;
  onUploadMacro: (
    steps: MacroStep[],
    options: { saveToFlash?: boolean; playAfter?: boolean }
  ) => Promise<void>;
  onPlayMacro: () => Promise<void>;
  onStopMacro: () => Promise<void>;
  onClearMacro: () => Promise<void>;
}

export const ModeAndMacros: React.FC<ModeAndMacrosProps> = ({
  connected,
  disabled,
  activeModeId,
  onSetMode,
  onUploadMacro,
  onPlayMacro,
  onStopMacro,
  onClearMacro,
}) => {
  const [steps, setSteps] = useState<MacroStep[]>(() => [...MACRO_PRESETS[0].steps]);
  const [activePresetId, setActivePresetId] = useState<string>(MACRO_PRESETS[0].id);
  const [newOp, setNewOp] = useState<number>(MacroStepOp.DRIVE);
  const [newArg0, setNewArg0] = useState<number>(45);
  const [newArg1, setNewArg1] = useState<number>(45);
  const [newDurMs, setNewDurMs] = useState<number>(400);
  const [macroBusy, setMacroBusy] = useState(false);
  const [macroStatus, setMacroStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) {
      setMacroStatus(null);
    }
  }, [connected]);

  const byteLen = steps.length * MACRO_STEP_BYTES;

  const runMacroAction = async (label: string, fn: () => Promise<void>) => {
    setMacroBusy(true);
    setMacroStatus(null);
    try {
      await fn();
      setMacroStatus(label);
    } catch {
      // Error surfaced via parent banner
    } finally {
      setMacroBusy(false);
    }
  };

  const handleOpChange = (op: number) => {
    setNewOp(op);
    if (op === MacroStepOp.DRIVE) {
      setNewArg0(45);
      setNewArg1(45);
      setNewDurMs(450);
    } else if (op === MacroStepOp.HEAD) {
      setNewArg0(25);
      setNewArg1(60);
      setNewDurMs(300);
    } else if (op === MacroStepOp.SYNTH) {
      setNewArg0(0);
      setNewArg1(2);
      setNewDurMs(400);
    } else if (op === MacroStepOp.LED) {
      setNewArg0(0);
      setNewArg1(2);
      setNewDurMs(150);
    } else {
      setNewArg0(0);
      setNewArg1(0);
      setNewDurMs(300);
    }
  };

  const clampInt = (v: number, min: number, max: number, fallback: number): number => {
    if (!Number.isFinite(v)) return fallback;
    return Math.max(min, Math.min(max, Math.round(v)));
  };

  const addStep = () => {
    if (steps.length >= MACRO_MAX_STEPS) return;
    setActivePresetId("custom");
    let safeArg0 = 0;
    let safeArg1 = 0;
    let safeDur = clampInt(newDurMs, 50, 5000, 300);
    if (newOp === MacroStepOp.DRIVE) {
      safeArg0 = clampInt(newArg0, -100, 100, 0);
      safeArg1 = clampInt(newArg1, -100, 100, 0);
    } else if (newOp === MacroStepOp.HEAD) {
      safeArg0 = clampInt(newArg0, -40, 35, 0);
      safeArg1 = clampInt(newArg1, 10, 100, 60);
    } else if (newOp === MacroStepOp.SYNTH) {
      safeArg0 = clampInt(newArg0, 0, 2, 0);
      safeArg1 = clampInt(newArg1, 0, 255, 2);
      safeDur = clampInt(newDurMs, 50, 3000, 400);
    } else if (newOp === MacroStepOp.LED) {
      safeArg0 = clampInt(newArg0, 0, 1, 0);
      safeArg1 =
        safeArg0 === 1
          ? ([ChestLedState.OFF, ChestLedState.BLUE, ChestLedState.GREEN, ChestLedState.RED].includes(
              newArg1 as 0 | 3 | 5 | 9
            )
              ? newArg1
              : ChestLedState.OFF)
          : clampInt(newArg1, 0, 5, 0);
    }
    setSteps((prev) => [...prev, { op: newOp, arg0: safeArg0, arg1: safeArg1, durMs: safeDur }]);
  };

  const moveStep = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    setActivePresetId("custom");
    setSteps((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const removeStep = (index: number) => {
    setActivePresetId("custom");
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="panel-stack">
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Autonomous Brain Modes (0x06)</h2>
            <p className="subtitle">
              Short-press the green button or double-tap Vernie&apos;s torso while stationary to cycle Modes 0–3 offline
            </p>
          </div>
        </div>

        <div className="mode-grid">
          {[0, 1, 2, 3, 4].map((m) => (
            <button
              key={m}
              className={`mode-card ${activeModeId === m ? "mode-card-active" : ""}`}
              disabled={disabled}
              onClick={() => onSetMode(m)}
            >
              <div className="mode-card-top">
                <strong>
                  {m}: {MODE_NAMES[m]}
                </strong>
                <span className="meta">{MODE_DESCRIPTIONS[m].led}</span>
              </div>
              <span className="meta">{MODE_DESCRIPTIONS[m].desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Visual Flash Macro Composer (0x07 → FLASH_USER_1)</h2>
            <p className="subtitle">
              5-byte step ISA (max {MACRO_MAX_STEPS} steps / {MACRO_MAX_BYTES} B · intentionally no dart opcode)
            </p>
          </div>
          <span className="badge badge-cyan">
            {steps.length}/{MACRO_MAX_STEPS} steps · {byteLen}/{MACRO_MAX_BYTES} B
          </span>
        </div>

        <div className="diag-row">
          <span className="label">Load Preset Routine</span>
          <div className="swatch-row">
            {MACRO_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={`btn btn-sm ${activePresetId === preset.id ? "btn-primary" : "btn-ghost"}`}
                onClick={() => {
                  setActivePresetId(preset.id);
                  setSteps([...preset.steps]);
                }}
              >
                {preset.label}
              </button>
            ))}
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setActivePresetId("custom");
                setSteps([]);
              }}
            >
              Empty Sequence
            </button>
          </div>
        </div>

        <div className="composer-form">
          <select
            aria-label="Macro step opcode"
            className="input-ctrl"
            value={newOp}
            onChange={(e) => handleOpChange(Number(e.target.value))}
          >
            <option value={MacroStepOp.DRIVE}>DRIVE (Left/Right %)</option>
            <option value={MacroStepOp.HEAD}>HEAD (Angle° / Speed%)</option>
            <option value={MacroStepOp.SYNTH}>SYNTH (Voice / SFX)</option>
            <option value={MacroStepOp.LED}>LED (Hub Palette)</option>
            <option value={MacroStepOp.WAIT}>WAIT (Coast)</option>
          </select>

          {newOp !== MacroStepOp.WAIT && (
            <label className="mini-field">
              <span className="meta">
                {newOp === MacroStepOp.DRIVE
                  ? "Left %"
                  : newOp === MacroStepOp.HEAD
                    ? "Angle°"
                    : newOp === MacroStepOp.SYNTH
                      ? "Voice (0-2)"
                      : "Target (0=Hub)"}
              </span>
              <input
                aria-label="Macro step arg0"
                className="input-ctrl input-num"
                type="number"
                value={newArg0}
                onChange={(e) => setNewArg0(Number(e.target.value))}
              />
            </label>
          )}

          {newOp !== MacroStepOp.WAIT && (
            <label className="mini-field">
              <span className="meta">
                {newOp === MacroStepOp.DRIVE
                  ? "Right %"
                  : newOp === MacroStepOp.HEAD
                    ? "Speed %"
                    : newOp === MacroStepOp.SYNTH
                      ? "SFX 1-7 / MIDI"
                      : "Palette 0-5"}
              </span>
              <input
                aria-label="Macro step arg1"
                className="input-ctrl input-num"
                type="number"
                value={newArg1}
                onChange={(e) => setNewArg1(Number(e.target.value))}
              />
            </label>
          )}

          <label className="mini-field">
            <span className="meta">Duration ms</span>
            <input
              aria-label="Macro step duration"
              className="input-ctrl input-num"
              type="number"
              min={50}
              max={newOp === MacroStepOp.SYNTH ? 3000 : 5000}
              step={50}
              value={newDurMs}
              onChange={(e) => setNewDurMs(Number(e.target.value))}
            />
          </label>

          <button
            id="btn-add-macro-step"
            className="btn btn-sm btn-secondary"
            disabled={steps.length >= MACRO_MAX_STEPS}
            onClick={addStep}
          >
            + Add Step
          </button>
        </div>

        <ol className="macro-list" aria-label="Macro steps">
          {steps.length === 0 ? (
            <li className="meta">No steps yet — load a preset or add a step above.</li>
          ) : (
            steps.map((s, idx) => (
              <li key={idx} className="macro-item">
                <span className="mono-readout">
                  {idx + 1}. {describeStep(s)}
                </span>
                <div className="swatch-row">
                  <button
                    className="btn btn-sm btn-ghost"
                    aria-label={`Move step ${idx + 1} up`}
                    disabled={idx === 0}
                    onClick={() => moveStep(idx, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    aria-label={`Move step ${idx + 1} down`}
                    disabled={idx === steps.length - 1}
                    onClick={() => moveStep(idx, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    aria-label={`Remove step ${idx + 1}`}
                    onClick={() => removeStep(idx)}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))
          )}
        </ol>

        <div className="swatch-row">
          <button
            className="btn btn-sm btn-primary"
            disabled={disabled || macroBusy || steps.length === 0}
            onClick={() =>
              void runMacroAction(`Playing ${steps.length}-step macro`, () =>
                onUploadMacro(steps, { playAfter: true })
              )
            }
          >
            Upload &amp; Play
          </button>
          <button
            className="btn btn-sm btn-secondary"
            disabled={disabled || macroBusy || steps.length === 0}
            onClick={() =>
              void runMacroAction(
                `Saved ${steps.length} steps (${byteLen} B) to FLASH_USER_1 — Yellow card triggers offline!`,
                () => onUploadMacro(steps, { saveToFlash: true })
              )
            }
          >
            Save to Flash (Yellow Card)
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={disabled || macroBusy}
            onClick={() => void runMacroAction("Playing saved macro", onPlayMacro)}
          >
            Play Saved
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={!connected || macroBusy}
            onClick={() => void runMacroAction("Macro stopped", onStopMacro)}
          >
            Stop Macro
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={disabled || macroBusy}
            onClick={() => void runMacroAction("Cleared saved macro from FLASH_USER_1", onClearMacro)}
          >
            Clear Flash Macro
          </button>
        </div>
        {macroStatus && <span className="hint-ok meta">{macroStatus}</span>}
      </section>
    </div>
  );
};
