// SPDX-License-Identifier: MIT
// Tactile Tank Drive Controller: Virtual Pointer Joystick + WASD/Arrows + Gamepad API + Emergency STOP.

import React, { useCallback, useEffect, useRef, useState } from "react";

export interface DrivePadProps {
  connected: boolean;
  disabled: boolean;
  onDrive: (left: number, right: number, timeoutMs?: number) => void;
}

/**
 * Mix normalized arcade stick inputs x (turn right +1), y (forward +1) into
 * clamped differential tank speeds [-100, +100] scaled by maxSpeedPct.
 */
export function mixArcadeToTank(
  x: number,
  y: number,
  maxSpeedPct: number
): { left: number; right: number } {
  const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));
  const cx = Math.abs(x) < 0.12 ? 0 : clampUnit(x);
  const cy = Math.abs(y) < 0.12 ? 0 : clampUnit(y);
  const rawL = cy + cx;
  const rawR = cy - cx;
  const peak = Math.max(1, Math.abs(rawL), Math.abs(rawR));
  const scale = Math.max(10, Math.min(100, maxSpeedPct));
  return {
    left: Math.round((rawL / peak) * scale),
    right: Math.round((rawR / peak) * scale),
  };
}

export const DrivePad: React.FC<DrivePadProps> = ({ connected, disabled, onDrive }) => {
  const [speedCap, setSpeedCap] = useState(65);
  const [stick, setStick] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [output, setOutput] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [gamepadName, setGamepadName] = useState<string | null>(null);

  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const activeVecRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const keysRef = useRef<Set<string>>(new Set());
  const wasMovingRef = useRef(false);
  const speedCapRef = useRef(speedCap);
  const connectedRef = useRef(connected);
  const onDriveRef = useRef(onDrive);
  speedCapRef.current = speedCap;
  connectedRef.current = connected;
  onDriveRef.current = onDrive;

  const stopNow = useCallback(() => {
    draggingRef.current = false;
    keysRef.current.clear();
    activeVecRef.current = { x: 0, y: 0 };
    setStick({ x: 0, y: 0 });
    setOutput({ left: 0, right: 0 });
    wasMovingRef.current = false;
    if (connectedRef.current) {
      onDriveRef.current(0, 0, 200);
    }
  }, []);

  // Ensure switching tabs or unmounting while actively driving immediately stops Vernie.
  useEffect(() => {
    return () => {
      if ((wasMovingRef.current || draggingRef.current) && connectedRef.current) {
        wasMovingRef.current = false;
        draggingRef.current = false;
        onDriveRef.current(0, 0, 200);
      }
    };
  }, []);

  const updatePointerStick = useCallback(
    (clientX: number, clientY: number) => {
      const el = padRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const radius = Math.max(1, rect.width / 2 - 18);
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = -(clientY - (rect.top + rect.height / 2));
      const mag = Math.hypot(dx, dy);
      const clampedMag = Math.min(mag, radius);
      const nx = mag > 0 ? (dx / mag) * (clampedMag / radius) : 0;
      const ny = mag > 0 ? (dy / mag) * (clampedMag / radius) : 0;
      activeVecRef.current = { x: nx, y: ny };
      setStick({ x: nx, y: ny });
    },
    []
  );

  // Keyboard WASD / Arrow drive + Spacebar emergency STOP
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
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
        keysRef.current.add(e.code);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
    };

    const onBlur = () => {
      if (wasMovingRef.current || draggingRef.current) {
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

  // 16 Hz coalesced drive loop (combining virtual stick, keyboard, and Gamepad API)
  useEffect(() => {
    if (!connected || disabled) {
      if (wasMovingRef.current) {
        stopNow();
      }
      return;
    }

    const id = window.setInterval(() => {
      let x = activeVecRef.current.x;
      let y = activeVecRef.current.y;

      // Keyboard overrides if pointer isn't actively dragging
      if (!draggingRef.current && keysRef.current.size > 0) {
        const k = keysRef.current;
        y = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        x = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
        setStick({ x, y });
      } else if (!draggingRef.current && typeof navigator.getGamepads === "function") {
        const pads = navigator.getGamepads();
        const pad = pads ? Array.from(pads).find((p): p is Gamepad => Boolean(p && p.connected)) : undefined;
        if (pad) {
          setGamepadName(pad.id.slice(0, 32));
          const gx = pad.axes[0] ?? 0;
          const gy = -(pad.axes[1] ?? 0);
          x = Math.abs(gx) >= 0.15 ? gx : 0;
          y = Math.abs(gy) >= 0.15 ? gy : 0;
          setStick({ x, y });
        } else {
          setGamepadName(null);
        }
      }

      const mixed = mixArcadeToTank(x, y, speedCapRef.current);
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

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Tank Drive Pad</h2>
          <p className="subtitle">
            Touch/mouse joystick · WASD / Arrow keys · Gamepad · 16 Hz coalesced dead-man stream
          </p>
        </div>
        <button
          id="drive-emergency-stop"
          className="btn btn-danger"
          disabled={!connected}
          onClick={stopNow}
          title="Urgent STOP (Spacebar) — preempts running macros and autonomous modes"
        >
          STOP (Space)
        </button>
      </div>

      <div className="drive-layout">
        <div
          ref={padRef}
          className={`joystick-well ${disabled ? "is-disabled" : ""}`}
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
          <div className="joystick-crosshair-h" />
          <div className="joystick-crosshair-v" />
          <div
            className="joystick-knob"
            style={{
              transform: `translate(${Math.round(stick.x * 58)}px, ${Math.round(-stick.y * 58)}px)`,
            }}
          />
        </div>

        <div className="drive-controls">
          <div className="dpad-grid">
            <span />
            <button
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => pulse(100, 100)}
            >
              Forward
            </button>
            <span />
            <button
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => pulse(-80, 80)}
            >
              Spin Left
            </button>
            <button
              className="btn btn-danger"
              disabled={!connected}
              onClick={stopNow}
            >
              STOP
            </button>
            <button
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => pulse(80, -80)}
            >
              Spin Right
            </button>
            <span />
            <button
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => pulse(-100, -100)}
            >
              Reverse
            </button>
            <span />
          </div>

          <div className="diag-row">
            <label className="label" htmlFor="speed-cap-slider">
              Speed Limit: {speedCap}% · Output L:{output.left} R:{output.right}
            </label>
            <input
              id="speed-cap-slider"
              className="full-slider"
              type="range"
              min={25}
              max={100}
              step={5}
              value={speedCap}
              onChange={(e) => setSpeedCap(Number(e.target.value))}
            />
          </div>

          <div className="action-row">
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={keyboardEnabled}
                onChange={(e) => setKeyboardEnabled(e.target.checked)}
              />
              <span>WASD / Arrow keys active</span>
            </label>
            <span className="meta">
              {gamepadName ? `Gamepad: ${gamepadName}` : "No gamepad detected"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
