// SPDX-License-Identifier: MIT
// Station 1 — Drive & Control: Live Vernie Twin, Sculpted Joystick / Dual-Track Tank Deck,
// Expressive Head & Eyebrow Studio, and Flip-Cover 2-Step Dart Launcher.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  DartSubcmd,
  HEAD_HOME_SENTINEL,
  TelemetryFlag,
  TelemetryFrame,
} from "@core/ble/protocol";
import { mixArcadeToTank } from "../utils/driveMath";
import { IconShield, IconSpark, IconStop } from "./Icons";
import { VernieTwin } from "./VernieTwin";

export interface DriveStationProps {
  connected: boolean;
  demoMode: boolean;
  disabled: boolean;
  telemetry: TelemetryFrame | null;
  hubRgb: [number, number, number];
  chestLedState: number;
  homingInProgress: boolean;
  dartFiredAt: number;
  onDrive: (left: number, right: number, timeoutMs?: number) => void;
  onHead: (angleDeg: number, speed?: number, coalesce?: boolean) => void;
  onDartSubcmd: (subcmd: number) => void;
  onSetMode: (modeId: number) => void;
  onSynth: (voice: number, presetOrNote: number, durMs?: number) => void;
  onLaunchDemo?: () => void;
  onDemoTogglePickup?: () => void;
  onDemoBump?: () => void;
  onDemoBrick?: (colorId: number) => void;
}

const SPEED_PRESETS = [
  { label: "Indoor", pct: 40 },
  { label: "Normal", pct: 65 },
  { label: "Turbo", pct: 100 },
];

const QUICK_MODES = [
  { id: 0, label: "Pet", dot: "#0EA5E9" },
  { id: 1, label: "Explorer", dot: "#16A34A" },
  { id: 2, label: "Sentry", dot: "#DC2626" },
  { id: 3, label: "Bricks", dot: "#EAB308" },
  { id: 4, label: "Remote", dot: "#7C3AED" },
];

const EXPRESSION_POSES: Array<{
  label: string;
  deg: number;
  lTilt: number;
  rTilt: number;
}> = [
  { label: "Far Left", deg: -35, lTilt: -18, rTilt: 6 },
  { label: "Curious", deg: -20, lTilt: -14, rTilt: 2 },
  { label: "Center", deg: 0, lTilt: 0, rTilt: 0 },
  { label: "Stern", deg: 20, lTilt: 14, rTilt: -14 },
  { label: "Far Right", deg: 35, lTilt: 8, rTilt: -18 },
];

export const DriveStation: React.FC<DriveStationProps> = ({
  connected,
  demoMode,
  disabled,
  telemetry,
  hubRgb,
  chestLedState,
  homingInProgress,
  dartFiredAt,
  onDrive,
  onHead,
  onDartSubcmd,
  onSetMode,
  onSynth,
  onLaunchDemo,
  onDemoTogglePickup,
  onDemoBump,
  onDemoBrick,
}) => {
  const [driveMode, setDriveMode] = useState<"joystick" | "dual">("joystick");
  const [speedCap, setSpeedCap] = useState(65);
  const [stick, setStick] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dualL, setDualL] = useState(0);
  const [dualR, setDualR] = useState(0);
  const [output, setOutput] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [gamepadName, setGamepadName] = useState<string | null>(null);
  const [sliderDeg, setSliderDeg] = useState(0);

  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const activeVecRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dualRef = useRef<{ l: number; r: number }>({ l: 0, r: 0 });
  const dualActiveRef = useRef<{ l: boolean; r: boolean }>({ l: false, r: false });
  const keysRef = useRef<Set<string>>(new Set());
  const wasMovingRef = useRef(false);

  const speedCapRef = useRef(speedCap);
  const driveModeRef = useRef(driveMode);
  const connectedRef = useRef(connected);
  const onDriveRef = useRef(onDrive);
  speedCapRef.current = speedCap;
  driveModeRef.current = driveMode;
  connectedRef.current = connected;
  onDriveRef.current = onDrive;

  const flags = telemetry?.flags ?? 0;
  const headHomed = Boolean(flags & TelemetryFlag.HEAD_HOMED);
  const dartArmed = Boolean(flags & TelemetryFlag.DART_ARMED);
  const pickedUp = Boolean(flags & TelemetryFlag.PICKED_UP);
  const headDeg = telemetry?.headDeg ?? 0;
  const activeModeId = telemetry?.modeId ?? null;

  useEffect(() => {
    if (!connected) {
      setSliderDeg(0);
    }
  }, [connected]);

  const stopNow = useCallback(() => {
    draggingRef.current = false;
    dualActiveRef.current = { l: false, r: false };
    dualRef.current = { l: 0, r: 0 };
    keysRef.current.clear();
    activeVecRef.current = { x: 0, y: 0 };
    setStick({ x: 0, y: 0 });
    setDualL(0);
    setDualR(0);
    setOutput({ left: 0, right: 0 });
    wasMovingRef.current = false;
    if (connectedRef.current) {
      onDriveRef.current(0, 0, 200);
    }
  }, []);

  // Immediately stop motors on unmount (e.g., station switch)
  useEffect(() => {
    return () => {
      if (
        (wasMovingRef.current || draggingRef.current || dualActiveRef.current.l || dualActiveRef.current.r) &&
        connectedRef.current
      ) {
        wasMovingRef.current = false;
        draggingRef.current = false;
        dualActiveRef.current = { l: false, r: false };
        onDriveRef.current(0, 0, 200);
      }
    };
  }, []);

  const updatePointerStick = useCallback((clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const radius = Math.max(1, rect.width / 2 - 22);
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = -(clientY - (rect.top + rect.height / 2));
    const mag = Math.hypot(dx, dy);
    const clampedMag = Math.min(mag, radius);
    const nx = mag > 0 ? (dx / mag) * (clampedMag / radius) : 0;
    const ny = mag > 0 ? (dy / mag) * (clampedMag / radius) : 0;
    activeVecRef.current = { x: nx, y: ny };
    setStick({ x: nx, y: ny });
  }, []);

  const updateDualFader = useCallback(
    (side: "l" | "r", el: HTMLDivElement, clientY: number) => {
      const rect = el.getBoundingClientRect();
      const half = Math.max(1, rect.height / 2 - 14);
      const dy = -(clientY - (rect.top + rect.height / 2));
      const norm = Math.max(-1, Math.min(1, dy / half));
      const dead = Math.abs(norm) < 0.1 ? 0 : norm;
      if (side === "l") {
        dualRef.current.l = dead;
        setDualL(dead);
      } else {
        dualRef.current.r = dead;
        setDualR(dead);
      }
    },
    []
  );

  // Keyboard WASD / Arrows + Spacebar urgent STOP
  useEffect(() => {
    if (!keyboardEnabled || !connected) return;

    const isEditable = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        stopNow();
        return;
      }
      if (disabled) return;
      if (
        ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
          e.code
        )
      ) {
        e.preventDefault();
        keysRef.current.add(e.code);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
    };

    const onBlur = () => {
      if (wasMovingRef.current || draggingRef.current || dualActiveRef.current.l || dualActiveRef.current.r) {
        stopNow();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [connected, disabled, keyboardEnabled, stopNow]);

  // 16 Hz coalesced drive loop (joystick, dual faders, keyboard, gamepad)
  useEffect(() => {
    if (!connected || disabled) {
      if (wasMovingRef.current) stopNow();
      return;
    }

    const id = window.setInterval(() => {
      let mixed: { left: number; right: number };

      if (driveModeRef.current === "dual" && (dualActiveRef.current.l || dualActiveRef.current.r)) {
        const cap = speedCapRef.current;
        mixed = {
          left: Math.round(dualRef.current.l * cap),
          right: Math.round(dualRef.current.r * cap),
        };
      } else {
        let x = activeVecRef.current.x;
        let y = activeVecRef.current.y;

        if (!draggingRef.current && keysRef.current.size > 0) {
          const k = keysRef.current;
          y =
            (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) -
            (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
          x =
            (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) -
            (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
          setStick({ x, y });
        } else if (!draggingRef.current && typeof navigator.getGamepads === "function") {
          const pads = navigator.getGamepads();
          const pad = pads
            ? Array.from(pads).find((p): p is Gamepad => Boolean(p && p.connected))
            : undefined;
          if (pad) {
            setGamepadName(pad.id.slice(0, 28));
            const gx = pad.axes[0] ?? 0;
            const gy = -(pad.axes[1] ?? 0);
            x = Math.abs(gx) >= 0.15 ? gx : 0;
            y = Math.abs(gy) >= 0.15 ? gy : 0;
            setStick({ x, y });
          } else {
            setGamepadName(null);
          }
        }
        mixed = mixArcadeToTank(x, y, speedCapRef.current);
      }

      setOutput(mixed);

      if (mixed.left !== 0 || mixed.right !== 0) {
        wasMovingRef.current = true;
        onDriveRef.current(mixed.left, mixed.right, 400);
      } else if (wasMovingRef.current) {
        wasMovingRef.current = false;
        onDriveRef.current(0, 0, 200);
        setStick({ x: 0, y: 0 });
      }
    }, 62);

    return () => window.clearInterval(id);
  }, [connected, disabled, stopNow]);

  const pulse = (l: number, r: number) => {
    const scale = speedCap / 100;
    onDrive(Math.round(l * scale), Math.round(r * scale), 400);
  };

  const angleLocked = disabled || !headHomed;
  const fireLocked = disabled || !dartArmed || !headHomed || pickedUp;

  return (
    <div className="drive-grid">
      {/* Left Hero Stage: Live Vernie Digital Twin + Quick Mode Switcher */}
      <div className="drive-hero-col">
        <VernieTwin
          connected={connected}
          demoMode={demoMode}
          telemetry={telemetry}
          hubRgb={hubRgb}
          chestLedState={chestLedState}
          homingInProgress={homingInProgress}
          dartFiredAt={dartFiredAt}
          onTapFace={() => {
            if (!disabled) {
              onSynth(0, 2, 0);
            }
          }}
          onLaunchDemo={onLaunchDemo}
          onDemoTogglePickup={onDemoTogglePickup}
          onDemoBump={onDemoBump}
          onDemoBrick={onDemoBrick}
        />

        <section className="console-panel compact-panel" aria-label="Quick personality selector">
          <div className="panel-head-inline">
            <span className="engraved-label">Robot Personality</span>
            <span className="helper-micro">Changes standalone behavior</span>
          </div>
          <div className="mode-pill-strip">
            {QUICK_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mode-pill ${activeModeId === m.id ? "is-active" : ""}`}
                disabled={disabled}
                onClick={() => onSetMode(m.id)}
              >
                <span className="mode-pill-dot" style={{ background: m.dot }} />
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Right Control Deck: Drive Gimbal + Head/Eyebrows & Flip-Cover Dart */}
      <div className="drive-control-col">
        {/* DRIVE DECK */}
        <section className="console-panel" aria-label="Tank drive controller">
          <div className="panel-head">
            <div>
              <h2>Drive Console</h2>
              <p className="panel-sub">
                Joystick, WASD / Arrows · Space stops instantly
              </p>
            </div>
            <div className="segmented-mini" role="group" aria-label="Drive controller style">
              <button
                type="button"
                className={driveMode === "joystick" ? "is-active" : ""}
                onClick={() => {
                  stopNow();
                  setDriveMode("joystick");
                }}
              >
                Joystick
              </button>
              <button
                type="button"
                className={driveMode === "dual" ? "is-active" : ""}
                onClick={() => {
                  stopNow();
                  setDriveMode("dual");
                }}
              >
                Dual Tracks
              </button>
            </div>
          </div>

          {driveMode === "joystick" ? (
            <div className="joystick-deck">
              <div
                ref={padRef}
                id="pilot-joystick"
                className={`gimbal-well ${disabled ? "is-disabled" : ""}`}
                role="application"
                aria-label="Virtual tank drive joystick"
                onPointerDown={(e) => {
                  if (disabled) return;
                  draggingRef.current = true;
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  updatePointerStick(e.clientX, e.clientY);
                }}
                onPointerMove={(e) => {
                  if (!draggingRef.current || disabled) return;
                  updatePointerStick(e.clientX, e.clientY);
                }}
                onPointerUp={stopNow}
                onPointerCancel={stopNow}
              >
                <span className="gimbal-dir gimbal-n">FWD</span>
                <span className="gimbal-dir gimbal-s">REV</span>
                <span className="gimbal-dir gimbal-w">L</span>
                <span className="gimbal-dir gimbal-e">R</span>
                <div className="gimbal-ring-inner" />
                <div className="gimbal-cross-h" />
                <div className="gimbal-cross-v" />
                <div
                  className="gimbal-puck"
                  style={{
                    transform: `translate(${Math.round(stick.x * 62)}px, ${Math.round(-stick.y * 62)}px)`,
                  }}
                >
                  <div className="gimbal-puck-dimple" />
                </div>
              </div>

              <div className="nudge-pad" role="group" aria-label="Quick drive nudges">
                <span />
                <button
                  type="button"
                  className="keycap keycap-subtle nudge-btn"
                  disabled={disabled}
                  onClick={() => pulse(100, 100)}
                >
                  ▲<span>Fwd</span>
                </button>
                <span />
                <button
                  type="button"
                  className="keycap keycap-subtle nudge-btn"
                  disabled={disabled}
                  onClick={() => pulse(-80, 80)}
                >
                  ↺<span>Left</span>
                </button>
                <button
                  type="button"
                  id="drive-pad-stop"
                  className="keycap keycap-stop nudge-btn"
                  disabled={!connected}
                  onClick={stopNow}
                  aria-label="Stop drive"
                >
                  <IconStop size={16} />
                  <span>Stop</span>
                </button>
                <button
                  type="button"
                  className="keycap keycap-subtle nudge-btn"
                  disabled={disabled}
                  onClick={() => pulse(80, -80)}
                >
                  ↻<span>Right</span>
                </button>
                <span />
                <button
                  type="button"
                  className="keycap keycap-subtle nudge-btn"
                  disabled={disabled}
                  onClick={() => pulse(-100, -100)}
                >
                  ▼<span>Rev</span>
                </button>
                <span />
              </div>
            </div>
          ) : (
            <div className="dual-fader-deck">
              {(["l", "r"] as const).map((side) => {
                const val = side === "l" ? dualL : dualR;
                return (
                  <div key={side} className="fader-col">
                    <span className="engraved-label">
                      {side === "l" ? "Left Tread" : "Right Tread"}
                    </span>
                    <div
                      className={`fader-well ${disabled ? "is-disabled" : ""}`}
                      role="slider"
                      aria-label={side === "l" ? "Left tread throttle" : "Right tread throttle"}
                      aria-valuemin={-100}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(val * speedCap)}
                      tabIndex={disabled ? -1 : 0}
                      onPointerDown={(e) => {
                        if (disabled) return;
                        dualActiveRef.current[side] = true;
                        e.currentTarget.setPointerCapture?.(e.pointerId);
                        updateDualFader(side, e.currentTarget, e.clientY);
                      }}
                      onPointerMove={(e) => {
                        if (!dualActiveRef.current[side] || disabled) return;
                        updateDualFader(side, e.currentTarget, e.clientY);
                      }}
                      onPointerUp={() => {
                        dualActiveRef.current[side] = false;
                        dualRef.current[side] = 0;
                        if (side === "l") setDualL(0);
                        else setDualR(0);
                      }}
                      onPointerCancel={() => {
                        dualActiveRef.current[side] = false;
                        dualRef.current[side] = 0;
                        if (side === "l") setDualL(0);
                        else setDualR(0);
                      }}
                    >
                      <div className="fader-center-mark" />
                      <div
                        className="fader-handle"
                        style={{ transform: `translateY(${Math.round(-val * 66)}px)` }}
                      />
                    </div>
                    <span className="mono-num fader-readout">
                      {Math.round(val * speedCap)}%
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Speed Selector + Keyboard/Gamepad strip */}
          <div className="speed-control-block">
            <div className="panel-head-inline">
              <label htmlFor="pilot-speed-slider" className="engraved-label">
                Speed Cap · <span className="mono-num">{speedCap}%</span>
              </label>
              <span className="mono-readout-muted">
                L:{output.left}% · R:{output.right}%
              </span>
            </div>
            <div className="speed-row">
              <div className="speed-presets">
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`chip-btn ${speedCap === p.pct ? "chip-btn-active" : ""}`}
                    onClick={() => setSpeedCap(p.pct)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                id="pilot-speed-slider"
                className="tactile-slider"
                type="range"
                min={25}
                max={100}
                step={5}
                value={speedCap}
                onChange={(e) => setSpeedCap(Number(e.target.value))}
              />
            </div>
            <div className="drive-footer-meta">
              <label className="toggle-check">
                <input
                  type="checkbox"
                  checked={keyboardEnabled}
                  onChange={(e) => setKeyboardEnabled(e.target.checked)}
                />
                <span>WASD / Arrows</span>
              </label>
              <span className="helper-micro">
                {gamepadName ? `Gamepad: ${gamepadName}` : "USB/BT Gamepad ready"}
              </span>
            </div>
          </div>
        </section>

        {/* HEAD, EYEBROWS & FLIP-COVER DART MODULE */}
        <section className="console-panel" aria-label="Head expressions and dart launcher">
          <div className="panel-head">
            <div>
              <h2>Head &amp; Expressions</h2>
              <p className="panel-sub">
                {headHomed
                  ? `Calibrated & ready · Live angle ${headDeg}°`
                  : "Calibrate once after power-on so Vernie knows where center is"}
              </p>
            </div>
            <button
              type="button"
              id="btn-calibrate-head"
              className={`keycap keycap-sm ${headHomed ? "keycap-subtle" : "keycap-orange"}`}
              disabled={disabled}
              onClick={() => {
                setSliderDeg(0);
                onHead(HEAD_HOME_SENTINEL, 30);
              }}
              title="Safely turns away from dart trigger to find center (remove dart first)"
            >
              {homingInProgress
                ? "Calibrating…"
                : headHomed
                  ? "Recalibrate"
                  : "Calibrate Head"}
            </button>
          </div>

          {!headHomed && connected && (
            <div className="inline-callout">
              <IconShield size={15} />
              <span>
                Remove any loaded dart, then tap <strong>Calibrate Head</strong> to unlock eyebrow
                poses and steering safely away from the trigger.
              </span>
            </div>
          )}

          {/* 5 Illustrated Eyebrow Pose Cards */}
          <div className="pose-grid" role="group" aria-label="Eyebrow expression presets">
            {EXPRESSION_POSES.map((pose) => (
              <button
                key={pose.deg}
                type="button"
                className={`pose-card ${headHomed && Math.abs(sliderDeg - pose.deg) <= 6 ? "is-selected" : ""}`}
                disabled={angleLocked}
                onClick={() => {
                  setSliderDeg(pose.deg);
                  onHead(pose.deg, 55);
                }}
              >
                <svg className="pose-brow-icon" viewBox="0 0 44 20" aria-hidden="true">
                  <rect
                    x="4"
                    y="7"
                    width="14"
                    height="4.5"
                    rx="2.2"
                    fill="#EA580C"
                    transform={`rotate(${pose.lTilt} 11 9)`}
                  />
                  <rect
                    x="26"
                    y="7"
                    width="14"
                    height="4.5"
                    rx="2.2"
                    fill="#EA580C"
                    transform={`rotate(${pose.rTilt} 33 9)`}
                  />
                </svg>
                <span className="pose-name">{pose.label}</span>
                <span className="pose-deg mono-num">{pose.deg > 0 ? `+${pose.deg}°` : `${pose.deg}°`}</span>
              </button>
            ))}
          </div>

          <div className="angle-slider-wrap">
            <span className="mono-readout-muted">-40°</span>
            <input
              id="pilot-head-slider"
              aria-label="Head target angle"
              className="tactile-slider"
              type="range"
              min={-40}
              max={35}
              value={sliderDeg}
              disabled={angleLocked}
              onChange={(e) => {
                const deg = Number(e.target.value);
                setSliderDeg(deg);
                onHead(deg, 55, true);
              }}
            />
            <span className="mono-readout-muted">+35°</span>
          </div>

          {/* 2-Step Physical Flip-Cover Dart Launcher */}
          <div className="dart-dock">
            <div className="panel-head-inline">
              <span className="engraved-label">Shoulder Dart Launcher</span>
              <div className="safety-checks">
                <span className={`check-dot ${headHomed ? "is-ok" : ""}`}>Head Calibrated</span>
                <span className={`check-dot ${!pickedUp ? "is-ok" : ""}`}>Upright</span>
                <span className={`check-dot ${dartArmed ? "is-armed" : ""}`}>
                  {dartArmed ? "Armed" : "Locked"}
                </span>
              </div>
            </div>

            <div className={`dart-switch-bay ${dartArmed ? "is-open" : ""}`}>
              {!dartArmed ? (
                <button
                  type="button"
                  id="btn-dart-arm"
                  className="dart-safety-cover"
                  disabled={disabled}
                  onClick={() => onDartSubcmd(DartSubcmd.ARM)}
                >
                  <span className="hazard-stripe" aria-hidden="true" />
                  <span className="cover-text">
                    <IconShield size={15} />
                    <span>Lift Safety Cover to Arm</span>
                  </span>
                </button>
              ) : (
                <div className="dart-armed-controls">
                  <button
                    type="button"
                    id="btn-dart-fire"
                    className="keycap keycap-fire"
                    disabled={fireLocked}
                    onClick={() => onDartSubcmd(DartSubcmd.FIRE)}
                    title={
                      fireLocked
                        ? "Requires Calibrated Head & Upright posture"
                        : "Launch shoulder dart now"
                    }
                  >
                    <IconSpark size={16} />
                    <span>FIRE DART</span>
                  </button>
                  <button
                    type="button"
                    id="btn-dart-disarm"
                    className="keycap keycap-subtle"
                    disabled={!connected}
                    onClick={() => onDartSubcmd(DartSubcmd.DISARM)}
                  >
                    Close Cover (Disarm)
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
