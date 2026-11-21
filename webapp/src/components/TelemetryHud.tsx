// SPDX-License-Identifier: MIT
// Persistent Live Vernie OS Telemetry Strip (10 Hz AppData stream + Watchdog Safe Mode Banner).

import React from "react";
import { MODE_NAMES, TelemetryFlag, TelemetryFrame } from "../ble/protocol";
import { ConnectionState } from "../ble/vernieClient";

export interface TelemetryHudProps {
  bleSupported: boolean;
  connectionState: ConnectionState;
  deviceName: string;
  telemetry: TelemetryFrame | null;
  rxHz: number;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onEmergencyStop?: () => void;
}

const LEGO_COLOR_NAMES: Record<number, string> = {
  0: "Black / None",
  3: "Blue",
  5: "Green",
  7: "Yellow",
  9: "Red",
  10: "White",
};

export const TelemetryHud: React.FC<TelemetryHudProps> = ({
  bleSupported,
  connectionState,
  deviceName,
  telemetry,
  rxHz,
  error,
  onConnect,
  onDisconnect,
  onEmergencyStop,
}) => {
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

  const distText =
    telemetry && telemetry.distancePct <= 100 ? `${telemetry.distancePct}%` : "N/A";
  const colorText = telemetry
    ? LEGO_COLOR_NAMES[telemetry.colorId] ?? `ID ${telemetry.colorId}`
    : "--";

  return (
    <section className="card telemetry-strip" aria-label="Live Vernie telemetry">
      <div className="card-header">
        <div>
          <h2>Live Telemetry</h2>
          <p className="subtitle">
            Pybricks GATT <code>0xC5F50001</code> · 18-byte AppData ·{" "}
            {telemetry ? `${rxHz.toFixed(1)} Hz (#${telemetry.seq})` : "Waiting for hub"}
          </p>
        </div>
        <div className="action-row">
          {connectionState === "connected" && onEmergencyStop && (
            <button className="btn btn-danger" onClick={onEmergencyStop}>
              STOP
            </button>
          )}
          {connectionState === "connected" ? (
            <button id="btn-ble-disconnect" className="btn btn-ghost" onClick={onDisconnect}>
              Disconnect {deviceName}
            </button>
          ) : (
            <button
              id="btn-ble-connect"
              className="btn btn-primary"
              onClick={onConnect}
              disabled={!bleSupported || connectionState === "connecting"}
            >
              {connectionState === "connecting" ? "Pairing…" : "Connect to VernieOS"}
            </button>
          )}
        </div>
      </div>

      {safeMode && (
        <div className="alert alert-warn">
          <strong>Watchdog Safe Mode Active:</strong> Hub rebooted from an IWDG watchdog timeout.
          Motion, arm, macro, and synth start commands are locked out for safety. Switch to{" "}
          <strong>Flasher &amp; Recovery</strong> to reboot or re-flash.
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      <div className="telemetry-strip-grid">
        <div className="metric">
          <span className="label">Battery</span>
          <div className="metric-val mono-num">
            {battVolts} <small>V</small>
          </div>
          <div className="mini-bar">
            <div
              className={`mini-fill ${telemetry && telemetry.batteryMv < 6600 ? "fill-warn" : "fill-ok"}`}
              style={{ width: `${battPct}%` }}
            />
          </div>
          <span className="meta">
            {telemetry ? `${telemetry.batteryMv} mV (6× AAA)` : "Offline"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Active Mode</span>
          <div className="metric-val">
            {telemetry ? MODE_NAMES[telemetry.modeId] ?? `Mode ${telemetry.modeId}` : "Offline"}
          </div>
          <span className="meta">
            {telemetry ? `Speed L:${telemetry.speedA}% R:${telemetry.speedB}%` : "Not connected"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Torso IMU</span>
          <div className="metric-val mono-num">
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
          <span className="label">88007 Chest</span>
          <div className="metric-val mono-num">{distText}</div>
          <span className="meta">
            {sensorOk ? `Color: ${colorText}` : "Absent or Chest LED mode"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Encoders &amp; Head</span>
          <div className="metric-val mono-num">{telemetry ? `${telemetry.headDeg}°` : "--"}</div>
          <span className="meta">
            {telemetry
              ? `A:${telemetry.encA}° B:${telemetry.encB}° · ${headHomed ? "HOMED" : "UNHOMED"}`
              : "Waiting for hub…"}
          </span>
        </div>

        <div className="metric">
          <span className="label">Safety &amp; Audio</span>
          <div className="flag-row">
            <span className={`pill ${dartArmed ? "pill-danger" : ""}`}>
              {dartArmed ? "ARMED" : "DISARMED"}
            </span>
            <span className={`pill ${synthActive ? "pill-active" : ""}`}>
              {synthActive ? "SYNTH ON" : "SILENT"}
            </span>
          </div>
          <span className="meta">Boot/disconnect safe</span>
        </div>
      </div>
    </section>
  );
};
