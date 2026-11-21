// SPDX-License-Identifier: MIT
// Persistent Tactile Console Header: Link status, Battery gauge, Connect/Demo controls, and Emergency STOP.

import React from "react";
import { TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";
import { ConnectionState } from "@core/ble/vernieClient";
import { IconBluetooth, IconStop, IconVolume, IconVolumeMute } from "./Icons";

export interface TopConsoleBarProps {
  bleSupported: boolean;
  connectionState: ConnectionState;
  demoMode: boolean;
  demoSound: boolean;
  deviceName: string;
  telemetry: TelemetryFrame | null;
  bleError: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleDemo: () => void;
  onToggleDemoSound: () => void;
  onEmergencyStop: () => void;
  onGoToSetup: () => void;
}

export const TopConsoleBar: React.FC<TopConsoleBarProps> = ({
  bleSupported,
  connectionState,
  demoMode,
  demoSound,
  deviceName,
  telemetry,
  bleError,
  onConnect,
  onDisconnect,
  onToggleDemo,
  onToggleDemoSound,
  onEmergencyStop,
  onGoToSetup,
}) => {
  const isLiveBle = connectionState === "connected";
  const isOnline = isLiveBle || demoMode;
  const safeMode = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SAFE_MODE));

  const battPct = telemetry
    ? Math.max(0, Math.min(100, Math.round(((telemetry.batteryMv - 6000) / (9000 - 6000)) * 100)))
    : null;
  const battLow = Boolean(telemetry && telemetry.batteryMv < 6600);

  return (
    <header className="console-header">
      <div className="console-bar">
        <div className="brand-lockup">
          <img
            src="./pilot-icon.svg"
            alt=""
            className="brand-mark"
            width={38}
            height={38}
          />
          <div className="brand-text">
            <h1>Vernie Pilot</h1>
            <div className="link-caption">
              <span
                className={`led-indicator ${
                  isLiveBle
                    ? "led-live"
                    : demoMode
                      ? "led-demo"
                      : connectionState === "connecting"
                        ? "led-pairing"
                        : "led-idle"
                }`}
              />
              <span>
                {isLiveBle
                  ? `Connected · ${deviceName}`
                  : demoMode
                    ? "Interactive Demo Robot"
                    : connectionState === "connecting"
                      ? "Pairing over Bluetooth…"
                      : "Ready to connect"}
              </span>
            </div>
          </div>
        </div>

        <div className="console-actions">
          {/* Compact visual battery indicator when online */}
          {isOnline && battPct !== null && (
            <div
              className={`battery-pill ${battLow ? "is-low" : ""}`}
              title={`Battery: ${((telemetry?.batteryMv ?? 0) / 1000).toFixed(2)} V (6× AAA)`}
              aria-label={`Battery ${battPct}%`}
            >
              <span className="battery-shell">
                <span
                  className="battery-fill"
                  style={{ width: `${battPct}%` }}
                />
              </span>
              <span className="mono-num">{battPct}%</span>
            </div>
          )}

          {/* Demo Sound mute button when in Demo Mode */}
          {demoMode && !isLiveBle && (
            <button
              type="button"
              id="btn-demo-sound"
              className="keycap keycap-subtle keycap-icon"
              onClick={onToggleDemoSound}
              title={demoSound ? "Mute simulator sound" : "Enable simulator sound"}
              aria-label={demoSound ? "Mute simulator sound" : "Enable simulator sound"}
            >
              {demoSound ? <IconVolume size={16} /> : <IconVolumeMute size={16} />}
            </button>
          )}

          {/* Demo toggle when not actively connected via real BLE */}
          {!isLiveBle && (
            <button
              type="button"
              id="btn-toggle-demo"
              className={`keycap ${demoMode ? "keycap-amber" : "keycap-subtle"}`}
              onClick={onToggleDemo}
            >
              {demoMode ? "Exit Demo" : "Try Demo"}
            </button>
          )}

          {/* Primary Bluetooth Connect / Disconnect keycap */}
          {isLiveBle ? (
            <button
              type="button"
              id="btn-ble-disconnect"
              className="keycap keycap-subtle"
              onClick={onDisconnect}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              id="btn-ble-connect"
              className="keycap keycap-green"
              onClick={onConnect}
              disabled={!bleSupported || connectionState === "connecting"}
              title={
                bleSupported
                  ? "Pair with your LEGO BOOST Move Hub running Vernie OS"
                  : "Web Bluetooth requires Chrome or Edge on Chromebook, desktop, or Android"
              }
            >
              <IconBluetooth size={15} />
              <span>{connectionState === "connecting" ? "Pairing…" : "Connect Robot"}</span>
            </button>
          )}

          {/* Always-accessible Emergency STOP hardware keycap */}
          <button
            type="button"
            id="btn-global-stop"
            className="keycap keycap-stop"
            onClick={onEmergencyStop}
            disabled={!isOnline}
            title="Emergency Stop (Spacebar) — halts wheels, routines, and sound immediately"
          >
            <IconStop size={14} />
            <span>STOP</span>
          </button>
        </div>
      </div>

      {/* Clear browser support notice (with Demo Mode invitation!) */}
      {!bleSupported && !demoMode && (
        <div className="notice notice-info" role="status">
          <div>
            <strong>Web Bluetooth isn&apos;t available in this browser.</strong> Open Vernie Pilot in{" "}
            <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on Chromebook, Windows,
            Mac, Linux, or Android to pair a real Move Hub — or click <strong>Try Demo</strong> to
            explore everything right now.
          </div>
          <button type="button" className="keycap keycap-amber keycap-sm" onClick={onToggleDemo}>
            Launch Demo Robot
          </button>
        </div>
      )}

      {/* Watchdog Safe Mode lockout banner */}
      {safeMode && (
        <div className="notice notice-danger" role="alert">
          <div>
            <strong>Safety Mode Active:</strong> Your robot restarted after an unexpected hiccup or
            low-battery dip, so motion and routines are paused. Check batteries and restart the hub.
          </div>
          <button type="button" className="keycap keycap-subtle keycap-sm" onClick={onGoToSetup}>
            Open Setup &amp; Reboot
          </button>
        </div>
      )}

      {/* BLE Error notice */}
      {bleError && (
        <div className="notice notice-danger" role="alert">
          <span>{bleError}</span>
        </div>
      )}
    </header>
  );
};
