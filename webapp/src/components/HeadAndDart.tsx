// SPDX-License-Identifier: MIT
// Safe Head Positioning, Eyebrow Expressions & 2-Step Arm + Fire Dart Interlock Panel.

import React, { useEffect, useState } from "react";
import { DartSubcmd, HEAD_HOME_SENTINEL } from "../ble/protocol";

export interface HeadAndDartProps {
  connected: boolean;
  disabled: boolean;
  headHomed: boolean;
  headDeg: number;
  dartArmed: boolean;
  pickedUp: boolean;
  onHead: (angleDeg: number, speed?: number, coalesce?: boolean) => void;
  onDartSubcmd: (subcmd: number) => void;
}

const EYEBROW_PRESETS: Array<{ label: string; deg: number }> = [
  { label: "Far Left (-35°)", deg: -35 },
  { label: "Curious (-20°)", deg: -20 },
  { label: "Center (0°)", deg: 0 },
  { label: "Stern (+20°)", deg: 20 },
  { label: "Far Right (+35°)", deg: 35 },
];

export const HeadAndDart: React.FC<HeadAndDartProps> = ({
  connected,
  disabled,
  headHomed,
  headDeg,
  dartArmed,
  pickedUp,
  onHead,
  onDartSubcmd,
}) => {
  const [sliderDeg, setSliderDeg] = useState(0);

  useEffect(() => {
    if (!connected) {
      setSliderDeg(0);
    }
  }, [connected]);

  const angleLocked = disabled || !headHomed;
  const fireLocked = disabled || !dartArmed || !headHomed || pickedUp;

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Head, Eyebrows &amp; Dart Launcher</h2>
          <p className="subtitle">
            Non-trigger homing (<code>-180°/s</code>, 28% duty) · Safe clamp{" "}
            <code>-40°..+35°</code> · Live: {headDeg}°
          </p>
        </div>
        <span className={`pill ${headHomed ? "pill-active" : ""}`}>
          {headHomed ? "HEAD HOMED" : "UNHOMED"}
        </span>
      </div>

      <div className="diag-row">
        <span className="label">1. Calibration &amp; Eyebrow Poses (0x02)</span>
        <div className="swatch-row">
          <button
            id="btn-home-head"
            className="btn btn-sm btn-secondary"
            disabled={disabled}
            onClick={() => {
              setSliderDeg(0);
              onHead(HEAD_HOME_SENTINEL, 30);
            }}
            title="Single-direction non-trigger stall homing (remove dart first!)"
          >
            Home Head (Non-Trigger)
          </button>
          {EYEBROW_PRESETS.map((p) => (
            <button
              key={p.deg}
              className="btn btn-sm btn-ghost"
              disabled={angleLocked}
              title={headHomed ? `Move head to ${p.deg}°` : "Home Head first before positioning"}
              onClick={() => {
                setSliderDeg(p.deg);
                onHead(p.deg, 55);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="slider-row">
          <input
            id="head-angle-slider"
            aria-label="Head target angle"
            className="full-slider"
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
          <span className="mono-readout">{sliderDeg}°</span>
        </div>
        {!headHomed && connected && (
          <span className="meta">
            Positioning controls stay locked until Home Head completes (prevents relative-encoder trigger drift).
          </span>
        )}
      </div>

      <div className="diag-section">
        <div className="diag-row">
          <span className="label">2. Two-Step Dart Safety Interlock (0x03 · Magic 0xA5)</span>
          <div className="swatch-row">
            <button
              id="btn-dart-arm"
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              onClick={() => onDartSubcmd(DartSubcmd.ARM)}
            >
              Arm Lock (0xA5)
            </button>
            <button
              id="btn-dart-fire"
              className="btn btn-sm btn-danger"
              disabled={fireLocked}
              onClick={() => onDartSubcmd(DartSubcmd.FIRE)}
              title="Requires Armed + Head Homed + Upright"
            >
              Fire Dart
            </button>
            <button
              id="btn-dart-disarm"
              className="btn btn-sm btn-ghost"
              disabled={!connected}
              onClick={() => onDartSubcmd(DartSubcmd.DISARM)}
            >
              Disarm Lock
            </button>
            <span className={`pill ${dartArmed ? "pill-danger" : ""}`}>
              {dartArmed ? "ARMED" : "DISARMED"}
            </span>
          </div>
          <span className="meta">
            Always boots disarmed; auto-disarms on disconnect, pickup, or immediately after firing.
          </span>
        </div>
      </div>
    </section>
  );
};
