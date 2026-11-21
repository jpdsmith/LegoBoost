// SPDX-License-Identifier: MIT
import React from "react";
import {
  DartSubcmd,
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
  onSetHubLed: (r: number, g: number, b: number) => void;
  onSetMode: (modeId: number) => void;
  onDartSubcmd: (subcmd: number) => void;
}

const LED_PRESETS: Array<{ name: string; r: number; g: number; b: number; hex: string }> = [
  { name: "Boost Cyan", r: 0, g: 168, b: 232, hex: "#00a8e8" },
  { name: "Vernie Orange", r: 255, g: 122, b: 0, hex: "#ff7a00" },
  { name: "Emerald", r: 16, g: 220, b: 96, hex: "#10dc60" },
  { name: "Sentry Red", r: 255, g: 24, b: 24, hex: "#ff1818" },
  { name: "Ultraviolet", r: 170, g: 40, b: 255, hex: "#aa28ff" },
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
  onSetHubLed,
  onSetMode,
  onDartSubcmd,
}) => {
  const safeMode = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SAFE_MODE));
  const dartArmed = Boolean(telemetry && (telemetry.flags & TelemetryFlag.DART_ARMED));
  const btnOrTap = Boolean(telemetry && (telemetry.flags & TelemetryFlag.TAP));
  const battVolts = telemetry ? (telemetry.batteryMv / 1000).toFixed(2) : "--";
  // 6x AAA spans ~6.0 V cutoff to ~9.0 V fresh alkaline (NiMH ~7.2-7.8 V nominal).
  const battPct = telemetry
    ? Math.max(0, Math.min(100, Math.round(((telemetry.batteryMv - 6000) / (9000 - 6000)) * 100)))
    : 0;
  // Require first telemetry packet to confirm !safeMode before enabling motion/arm buttons.
  const motionControlsDisabled = connectionState !== "connected" || !telemetry || safeMode;

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Live Vernie OS Telemetry &amp; Phase 1 Diagnostics</h2>
          <p className="subtitle">
            Pybricks GATT (<code>0xC5F50001</code>) · 18-byte AppData stream · 10 Hz target.
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
          Motion commands are locked out for safety. Use Step 1 in the flasher to re-flash or
          power-cycle.
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
          <span className="label">Green Button / Tap</span>
          <div className={`pill ${btnOrTap ? "pill-active" : ""}`}>
            {btnOrTap ? "PRESSED" : "IDLE"}
          </div>
          <span className="meta">Press hub button to verify live input</span>
        </div>

        <div className="metric">
          <span className="label">Dart Safety Lock</span>
          <div className={`pill ${dartArmed ? "pill-danger" : ""}`}>
            {dartArmed ? "ARMED" : "DISARMED"}
          </div>
          <span className="meta">Always disarmed on boot &amp; disconnect</span>
        </div>
      </div>

      <div className="diag-section">
        <h3>Phase 1 Command Smoke Tests</h3>
        <div className="diag-row">
          <span className="label">Hub RGB LED (0x05):</span>
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
        </div>

        <div className="diag-row">
          <span className="label">Mode Switch (0x06):</span>
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
        </div>

        <div className="diag-row">
          <span className="label">Dart Interlock Test (0x03):</span>
          <div className="swatch-row">
            <button
              className="btn btn-sm btn-ghost"
              disabled={motionControlsDisabled}
              onClick={() => onDartSubcmd(DartSubcmd.ARM)}
            >
              Arm Lock (0xA5)
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
      </div>
    </section>
  );
};
