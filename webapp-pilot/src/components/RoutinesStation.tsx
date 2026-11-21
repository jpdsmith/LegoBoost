// SPDX-License-Identifier: MIT
// Station 3 — Personalities & LEGO-Inspired Visual Routine Builder (0x06 & 0x07 Flash Macros).

import React, { useEffect, useState } from "react";
import {
  ChestLedState,
  MACRO_MAX_BYTES,
  MACRO_MAX_STEPS,
  MACRO_STEP_BYTES,
  MacroStep,
  MacroStepOp,
} from "@core/ble/protocol";
import { IconPlay, IconShield, IconStop } from "./Icons";

export interface RoutinesStationProps {
  connected: boolean;
  disabled: boolean;
  activeModeId: number | null;
  activeMacroStepIndex: number | null;
  onSetMode: (modeId: number) => void;
  onUploadMacro: (
    steps: MacroStep[],
    options: { saveToFlash?: boolean; playAfter?: boolean }
  ) => Promise<void>;
  onPlayMacro: () => Promise<void>;
  onStopMacro: () => Promise<void>;
  onClearMacro: () => Promise<void>;
}

interface RoutineTemplate {
  id: string;
  label: string;
  summary: string;
  steps: MacroStep[];
}

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "victory-dance",
    label: "Victory Dance",
    summary: "Green glow, fanfare chirp, spin wiggle & head nod",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 2, durMs: 150 },
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
    summary: "Short cruise forward, look left & right, roll back",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 0, durMs: 150 },
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
    label: "Friendly Hello",
    summary: "Warm orange light, startup chime & curious head wave",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 1, durMs: 150 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 1, durMs: 500 },
      { op: MacroStepOp.HEAD, arg0: 25, arg1: 65, durMs: 300 },
      { op: MacroStepOp.HEAD, arg0: -25, arg1: 65, durMs: 300 },
      { op: MacroStepOp.HEAD, arg0: 0, arg1: 65, durMs: 250 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 3, durMs: 400 },
    ],
  },
  {
    id: "sentry-sweep",
    label: "Sentry Sweep",
    summary: "Red alert glow, laser beep & wide room scan",
    steps: [
      { op: MacroStepOp.LED, arg0: 0, arg1: 3, durMs: 150 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 5, durMs: 500 },
      { op: MacroStepOp.HEAD, arg0: -35, arg1: 55, durMs: 400 },
      { op: MacroStepOp.WAIT, arg0: 0, arg1: 0, durMs: 250 },
      { op: MacroStepOp.HEAD, arg0: 35, arg1: 55, durMs: 400 },
      { op: MacroStepOp.SYNTH, arg0: 0, arg1: 6, durMs: 350 },
      { op: MacroStepOp.HEAD, arg0: 0, arg1: 60, durMs: 250 },
    ],
  },
];

const PERSONALITY_CARDS = [
  {
    id: 0,
    title: "Living Pet",
    ledLabel: "Soft Blue",
    dot: "#0EA5E9",
    desc: "Looks around, chirps happily, backs away playfully from hands, and squawks if picked up.",
  },
  {
    id: 1,
    title: "Room Explorer",
    ledLabel: "Soft Green",
    dot: "#16A34A",
    desc: "Cruises around the room on its own, scanning and steering clear of walls and obstacles.",
  },
  {
    id: 2,
    title: "Desk Sentry",
    ledLabel: "Soft Red",
    dot: "#DC2626",
    desc: "Watches your desk with a pulsing red beacon and sounds a siren when someone gets close.",
  },
  {
    id: 3,
    title: "Brick Commander",
    ledLabel: "Soft Yellow",
    dot: "#EAB308",
    desc: "Show a LEGO brick to the chest sensor: Green goes, Red spins, Blue dances, Yellow runs your saved routine.",
  },
  {
    id: 4,
    title: "Remote Control",
    ledLabel: "Soft Violet",
    dot: "#7C3AED",
    desc: "Stays calm and yields full precision control to your joystick, piano, and routines.",
  },
];

const SFX_CHOICES = [
  { id: 1, label: "Startup Chime" },
  { id: 2, label: "Happy Chirp" },
  { id: 3, label: "Curious Beep" },
  { id: 4, label: "Pickup Squawk" },
  { id: 5, label: "Sentry Siren" },
  { id: 6, label: "Laser Zap" },
  { id: 7, label: "Victory Fanfare" },
  { id: 72, label: "Piano Note C5" },
  { id: 76, label: "Piano Note E5" },
  { id: 79, label: "Piano Note G5" },
  { id: 84, label: "Piano Note C6" },
];

const HUB_PALETTE = [
  { idx: 0, label: "Cyan", hex: "#00A8E8" },
  { idx: 1, label: "Orange", hex: "#FF7A00" },
  { idx: 2, label: "Emerald", hex: "#16A34A" },
  { idx: 3, label: "Red", hex: "#DC2626" },
  { idx: 4, label: "Violet", hex: "#7C3AED" },
  { idx: 5, label: "Yellow", hex: "#EAB308" },
];

type DriveDir = "forward" | "reverse" | "spin-left" | "spin-right";

const BLOCK_META: Record<number, { tag: string; colorClass: string }> = {
  [MacroStepOp.DRIVE]: { tag: "MOVE", colorClass: "block-drive" },
  [MacroStepOp.HEAD]: { tag: "HEAD", colorClass: "block-head" },
  [MacroStepOp.SYNTH]: { tag: "SOUND", colorClass: "block-synth" },
  [MacroStepOp.LED]: { tag: "LIGHT", colorClass: "block-led" },
  [MacroStepOp.WAIT]: { tag: "PAUSE", colorClass: "block-wait" },
};

function describeStepFriendly(step: MacroStep): string {
  const sec = (step.durMs / 1000).toFixed(2).replace(/\.?0+$/, "");
  switch (step.op) {
    case MacroStepOp.DRIVE: {
      if (step.arg0 > 0 && step.arg1 > 0 && step.arg0 === step.arg1) {
        return `Drive forward at ${step.arg0}% for ${sec}s`;
      }
      if (step.arg0 < 0 && step.arg1 < 0 && step.arg0 === step.arg1) {
        return `Reverse at ${Math.abs(step.arg0)}% for ${sec}s`;
      }
      if (step.arg0 > 0 && step.arg1 < 0) {
        return `Spin right at ${step.arg0}% for ${sec}s`;
      }
      if (step.arg0 < 0 && step.arg1 > 0) {
        return `Spin left at ${step.arg1}% for ${sec}s`;
      }
      return `Tank drive L:${step.arg0}% R:${step.arg1}% for ${sec}s`;
    }
    case MacroStepOp.HEAD:
      return step.arg0 === 0
        ? `Center head (0°) · ${sec}s`
        : `Turn head to ${step.arg0 > 0 ? `+${step.arg0}` : step.arg0}° · ${sec}s`;
    case MacroStepOp.SYNTH: {
      const found = SFX_CHOICES.find((c) => c.id === step.arg1);
      return `Play ${found ? found.label : `Note #${step.arg1}`} · ${sec}s`;
    }
    case MacroStepOp.LED:
      if (step.arg0 === 0) {
        const pal = HUB_PALETTE[step.arg1];
        return `Hub light → ${pal ? pal.label : `Color ${step.arg1}`} · ${sec}s`;
      }
      return `Chest beacon state ${step.arg1} · ${sec}s`;
    default:
      return `Wait patiently for ${sec}s`;
  }
}

export const RoutinesStation: React.FC<RoutinesStationProps> = ({
  connected,
  disabled,
  activeModeId,
  activeMacroStepIndex,
  onSetMode,
  onUploadMacro,
  onPlayMacro,
  onStopMacro,
  onClearMacro,
}) => {
  const [steps, setSteps] = useState<MacroStep[]>(() => [...ROUTINE_TEMPLATES[0].steps]);
  const [activeTemplateId, setActiveTemplateId] = useState<string>(ROUTINE_TEMPLATES[0].id);
  const [blockType, setBlockType] = useState<number>(MacroStepOp.DRIVE);

  // Human-friendly block builder fields
  const [driveDir, setDriveDir] = useState<DriveDir>("forward");
  const [driveSpeed, setDriveSpeed] = useState(50);
  const [headAngle, setHeadAngle] = useState(25);
  const [headSpeed, setHeadSpeed] = useState(65);
  const [soundChoice, setSoundChoice] = useState(2);
  const [ledPaletteIdx, setLedPaletteIdx] = useState(2);
  const [chestState, setChestState] = useState<number>(ChestLedState.OFF);
  const [ledTarget, setLedTarget] = useState<0 | 1>(0);
  const [durMs, setDurMs] = useState(500);

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) setStatusMsg(null);
  }, [connected]);

  const byteLen = steps.length * MACRO_STEP_BYTES;
  const memPct = Math.round((byteLen / MACRO_MAX_BYTES) * 100);
  const totalSec = (steps.reduce((acc, s) => acc + s.durMs, 0) / 1000).toFixed(1);

  const runAction = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setStatusMsg(null);
    try {
      await fn();
      setStatusMsg(label);
    } catch {
      // Surfacing handled by top error bar
    } finally {
      setBusy(false);
    }
  };

  const handleAddBlock = () => {
    if (steps.length >= MACRO_MAX_STEPS) return;
    setActiveTemplateId("custom");
    const clampedDur = Math.max(
      50,
      Math.min(blockType === MacroStepOp.SYNTH ? 3000 : 5000, Math.round(durMs))
    );

    let step: MacroStep;
    if (blockType === MacroStepOp.DRIVE) {
      const spd = Math.max(15, Math.min(100, Math.round(driveSpeed)));
      const [l, r] =
        driveDir === "forward"
          ? [spd, spd]
          : driveDir === "reverse"
            ? [-spd, -spd]
            : driveDir === "spin-left"
              ? [-spd, spd]
              : [spd, -spd];
      step = { op: MacroStepOp.DRIVE, arg0: l, arg1: r, durMs: clampedDur };
    } else if (blockType === MacroStepOp.HEAD) {
      step = {
        op: MacroStepOp.HEAD,
        arg0: Math.max(-40, Math.min(35, Math.round(headAngle))),
        arg1: Math.max(20, Math.min(100, Math.round(headSpeed))),
        durMs: clampedDur,
      };
    } else if (blockType === MacroStepOp.SYNTH) {
      step = { op: MacroStepOp.SYNTH, arg0: 0, arg1: soundChoice, durMs: clampedDur };
    } else if (blockType === MacroStepOp.LED) {
      step = {
        op: MacroStepOp.LED,
        arg0: ledTarget,
        arg1: ledTarget === 0 ? ledPaletteIdx : chestState,
        durMs: clampedDur,
      };
    } else {
      step = { op: MacroStepOp.WAIT, arg0: 0, arg1: 0, durMs: clampedDur };
    }

    setSteps((prev) => [...prev, step]);
  };

  const moveStep = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    setActiveTemplateId("custom");
    setSteps((prev) => {
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const duplicateStep = (index: number) => {
    if (steps.length >= MACRO_MAX_STEPS) return;
    setActiveTemplateId("custom");
    setSteps((prev) => {
      const copy = [...prev];
      copy.splice(index + 1, 0, { ...copy[index] });
      return copy;
    });
  };

  const removeStep = (index: number) => {
    setActiveTemplateId("custom");
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="station-stack">
      {/* 5 AUTONOMOUS PERSONALITIES */}
      <section className="console-panel" aria-label="Autonomous robot personalities">
        <div className="panel-head">
          <div>
            <h2>Robot Personalities</h2>
            <p className="panel-sub">
              Pick a mood right here, or short-press Vernie&apos;s green button / double-tap his
              torso offline to cycle personalities
            </p>
          </div>
        </div>

        <div className="personality-grid">
          {PERSONALITY_CARDS.map((p) => {
            const active = activeModeId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`personality-card ${active ? "is-active" : ""}`}
                disabled={disabled}
                onClick={() => onSetMode(p.id)}
              >
                <div className="personality-top">
                  <span
                    className="personality-led"
                    style={{
                      background: p.dot,
                      boxShadow: active ? `0 0 12px ${p.dot}` : "none",
                    }}
                  />
                  <div className="personality-title-col">
                    <strong>{p.title}</strong>
                    <span className="helper-micro">{p.ledLabel}</span>
                  </div>
                </div>
                <p className="personality-desc">{p.desc}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* VISUAL ROUTINE BUILDER */}
      <section className="console-panel" aria-label="Visual routine builder">
        <div className="panel-head">
          <div>
            <h2>Routine Builder</h2>
            <p className="panel-sub">
              Chain moves, head poses, sounds &amp; lights — save right inside your robot and replay
              offline with a Yellow LEGO brick
            </p>
          </div>
          <div className="memory-pill" aria-label="Routine memory usage">
            <span className="mono-num">
              {steps.length}/{MACRO_MAX_STEPS} blocks · {totalSec}s
            </span>
            <div className="memory-bar">
              <div className="memory-fill" style={{ width: `${memPct}%` }} />
            </div>
          </div>
        </div>

        {/* Starter routine templates */}
        <div className="template-bar">
          <span className="engraved-label">Starter Routines</span>
          <div className="chip-row">
            {ROUTINE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`chip-btn ${activeTemplateId === t.id ? "chip-btn-active" : ""}`}
                onClick={() => {
                  setActiveTemplateId(t.id);
                  setSteps(t.steps.map((s) => ({ ...s })));
                }}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              className="chip-btn"
              onClick={() => {
                setActiveTemplateId("custom");
                setSteps([]);
              }}
            >
              Start Blank
            </button>
          </div>
        </div>

        {/* Visual Block Composer */}
        <div className="block-builder-tray">
          <div className="block-type-tabs" role="group" aria-label="Choose action block type">
            {[
              { op: MacroStepOp.DRIVE, label: "Move", cls: "tab-drive" },
              { op: MacroStepOp.HEAD, label: "Head", cls: "tab-head" },
              { op: MacroStepOp.SYNTH, label: "Sound", cls: "tab-synth" },
              { op: MacroStepOp.LED, label: "Light", cls: "tab-led" },
              { op: MacroStepOp.WAIT, label: "Pause", cls: "tab-wait" },
            ].map((b) => (
              <button
                key={b.op}
                type="button"
                className={`block-tab ${b.cls} ${blockType === b.op ? "is-active" : ""}`}
                onClick={() => {
                  setBlockType(b.op);
                  if (b.op === MacroStepOp.DRIVE) setDurMs(600);
                  else if (b.op === MacroStepOp.HEAD) setDurMs(350);
                  else if (b.op === MacroStepOp.SYNTH) setDurMs(450);
                  else if (b.op === MacroStepOp.LED) setDurMs(150);
                  else setDurMs(400);
                }}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="block-config-row">
            {blockType === MacroStepOp.DRIVE && (
              <>
                <div className="field-stack">
                  <span className="engraved-label">Direction</span>
                  <div className="chip-row">
                    {(
                      [
                        { id: "forward", label: "Forward" },
                        { id: "reverse", label: "Reverse" },
                        { id: "spin-left", label: "Spin Left" },
                        { id: "spin-right", label: "Spin Right" },
                      ] as const
                    ).map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className={`chip-btn ${driveDir === d.id ? "chip-btn-active" : ""}`}
                        onClick={() => setDriveDir(d.id)}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field-stack field-slider">
                  <span className="engraved-label">
                    Speed · <span className="mono-num">{driveSpeed}%</span>
                  </span>
                  <input
                    aria-label="Drive block speed"
                    className="tactile-slider"
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={driveSpeed}
                    onChange={(e) => setDriveSpeed(Number(e.target.value))}
                  />
                </label>
              </>
            )}

            {blockType === MacroStepOp.HEAD && (
              <>
                <label className="field-stack field-slider">
                  <span className="engraved-label">
                    Angle · <span className="mono-num">{headAngle > 0 ? `+${headAngle}°` : `${headAngle}°`}</span>
                  </span>
                  <input
                    aria-label="Head block angle"
                    className="tactile-slider"
                    type="range"
                    min={-40}
                    max={35}
                    step={5}
                    value={headAngle}
                    onChange={(e) => setHeadAngle(Number(e.target.value))}
                  />
                </label>
                <label className="field-stack field-slider">
                  <span className="engraved-label">
                    Turn Speed · <span className="mono-num">{headSpeed}%</span>
                  </span>
                  <input
                    aria-label="Head block speed"
                    className="tactile-slider"
                    type="range"
                    min={25}
                    max={100}
                    step={5}
                    value={headSpeed}
                    onChange={(e) => setHeadSpeed(Number(e.target.value))}
                  />
                </label>
              </>
            )}

            {blockType === MacroStepOp.SYNTH && (
              <label className="field-stack">
                <span className="engraved-label">Sound Effect or Note</span>
                <select
                  aria-label="Routine sound choice"
                  className="tactile-select"
                  value={soundChoice}
                  onChange={(e) => setSoundChoice(Number(e.target.value))}
                >
                  {SFX_CHOICES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {blockType === MacroStepOp.LED && (
              <>
                <div className="field-stack">
                  <span className="engraved-label">Which Light</span>
                  <div className="segmented-mini">
                    <button
                      type="button"
                      className={ledTarget === 0 ? "is-active" : ""}
                      onClick={() => setLedTarget(0)}
                    >
                      Hub Glow
                    </button>
                    <button
                      type="button"
                      className={ledTarget === 1 ? "is-active" : ""}
                      onClick={() => setLedTarget(1)}
                    >
                      Chest Light
                    </button>
                  </div>
                </div>
                {ledTarget === 0 ? (
                  <div className="field-stack">
                    <span className="engraved-label">Color</span>
                    <div className="chip-row">
                      {HUB_PALETTE.map((c) => (
                        <button
                          key={c.idx}
                          type="button"
                          className={`chip-btn ${ledPaletteIdx === c.idx ? "chip-btn-active" : ""}`}
                          onClick={() => setLedPaletteIdx(c.idx)}
                        >
                          <span className="chip-dot" style={{ background: c.hex }} />
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="field-stack">
                    <span className="engraved-label">Chest Beacon</span>
                    <div className="chip-row">
                      {[
                        { label: "Off", val: ChestLedState.OFF },
                        { label: "Blue", val: ChestLedState.BLUE },
                        { label: "Green", val: ChestLedState.GREEN },
                        { label: "Red", val: ChestLedState.RED },
                      ].map((c) => (
                        <button
                          key={c.val}
                          type="button"
                          className={`chip-btn ${chestState === c.val ? "chip-btn-active" : ""}`}
                          onClick={() => setChestState(c.val)}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <label className="field-stack field-slider">
              <span className="engraved-label">
                Duration · <span className="mono-num">{(durMs / 1000).toFixed(2)}s</span>
              </span>
              <input
                aria-label="Block duration"
                className="tactile-slider"
                type="range"
                min={100}
                max={blockType === MacroStepOp.SYNTH ? 2500 : 3000}
                step={50}
                value={durMs}
                onChange={(e) => setDurMs(Number(e.target.value))}
              />
            </label>

            <button
              type="button"
              id="btn-pilot-add-block"
              className="keycap keycap-orange keycap-sm"
              disabled={steps.length >= MACRO_MAX_STEPS}
              onClick={handleAddBlock}
            >
              + Add Block
            </button>
          </div>
        </div>

        {/* Visual Action Block Timeline */}
        <ol className="routine-timeline" aria-label="Routine action blocks">
          {steps.length === 0 ? (
            <li className="timeline-empty">
              No action blocks yet — pick a starter routine above or add your first block.
            </li>
          ) : (
            steps.map((step, idx) => {
              const meta = BLOCK_META[step.op] ?? { tag: "WAIT", colorClass: "block-wait" };
              const isPlayingHere = activeMacroStepIndex === idx;
              return (
                <li
                  key={idx}
                  className={`timeline-block ${meta.colorClass} ${isPlayingHere ? "is-running" : ""}`}
                >
                  <div className="timeline-block-left">
                    <span className="block-index mono-num">{idx + 1}</span>
                    <span className="block-pill">{meta.tag}</span>
                    <span className="block-text">{describeStepFriendly(step)}</span>
                  </div>
                  <div className="timeline-block-actions">
                    <button
                      type="button"
                      className="mini-icon-btn"
                      aria-label={`Move block ${idx + 1} up`}
                      disabled={idx === 0}
                      onClick={() => moveStep(idx, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="mini-icon-btn"
                      aria-label={`Move block ${idx + 1} down`}
                      disabled={idx === steps.length - 1}
                      onClick={() => moveStep(idx, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="mini-icon-btn"
                      aria-label={`Duplicate block ${idx + 1}`}
                      disabled={steps.length >= MACRO_MAX_STEPS}
                      onClick={() => duplicateStep(idx)}
                      title="Duplicate block"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="mini-icon-btn mini-icon-del"
                      aria-label={`Remove block ${idx + 1}`}
                      onClick={() => removeStep(idx)}
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })
          )}
        </ol>

        {/* Playback & Save to Flash Bar */}
        <div className="routine-actions-bar">
          <div className="action-cluster">
            <button
              type="button"
              id="btn-routine-run"
              className="keycap keycap-green"
              disabled={disabled || busy || steps.length === 0}
              onClick={() =>
                void runAction(`Running ${steps.length}-block routine…`, () =>
                  onUploadMacro(steps, { playAfter: true })
                )
              }
            >
              <IconPlay size={14} />
              <span>Run Now</span>
            </button>
            <button
              type="button"
              id="btn-routine-save"
              className="keycap keycap-amber"
              disabled={disabled || busy || steps.length === 0}
              onClick={() =>
                void runAction(
                  `Saved ${steps.length} blocks (${byteLen} B) to robot memory — hold a Yellow LEGO brick in Brick Commander mode to replay offline!`,
                  () => onUploadMacro(steps, { saveToFlash: true })
                )
              }
            >
              Save to Yellow Brick
            </button>
            <button
              type="button"
              className="keycap keycap-subtle"
              disabled={disabled || busy}
              onClick={() => void runAction("Playing saved routine from robot memory…", onPlayMacro)}
            >
              Play Saved
            </button>
            <button
              type="button"
              className="keycap keycap-stop"
              disabled={!connected || busy}
              onClick={() => void runAction("Routine stopped.", onStopMacro)}
            >
              <IconStop size={13} />
              <span>Stop</span>
            </button>
            <button
              type="button"
              className="keycap keycap-subtle"
              disabled={disabled || busy}
              onClick={() => void runAction("Cleared saved routine from robot memory.", onClearMacro)}
            >
              Clear Memory
            </button>
          </div>
          <span className="safety-footnote">
            <IconShield size={13} />
            <span>Routines can never fire the dart launcher.</span>
          </span>
        </div>

        {statusMsg && <div className="notice notice-success">{statusMsg}</div>}
      </section>
    </div>
  );
};
