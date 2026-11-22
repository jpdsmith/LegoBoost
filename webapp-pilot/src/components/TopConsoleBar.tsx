// SPDX-License-Identifier: MIT
// Persistent Tactile Console Header: Link status (BLE or Wi-Fi FPV), Battery gauge, Connect, and Emergency STOP.

import React from "react";
import { TelemetryFlag, TelemetryFrame } from "@core/ble/protocol";
import { ConnectionState } from "@core/ble/vernieClient";
import { IconBluetooth, IconStop } from "./Icons";

export interface TopConsoleBarProps {
  bleSupported: boolean;
  connectionState: ConnectionState;
  remoteWifiConnected?: boolean;
  remoteWifiLabel?: string;
  deviceName: string;
  telemetry: TelemetryFrame | null;
  bleError: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onEmergencyStop: () => void;
  onGoToSetup: () => void;
}

export const TopConsoleBar: React.FC<TopConsoleBarProps> = ({
  bleSupported,
  connectionState,
  remoteWifiConnected = false,
  remoteWifiLabel,
  deviceName,
  telemetry,
  bleError,
  onConnect,
  onDisconnect,
  onEmergencyStop,
  onGoToSetup,
}) => {
  const isLiveBle = connectionState === "connected";
  const isOnline = isLiveBle || remoteWifiConnected;
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
                  isOnline
                    ? "led-live"
                    : connectionState === "connecting"
                      ? "led-pairing"
                      : "led-idle"
                }`}
              />
              <span>
                {isLiveBle
                  ? `Bluetooth · ${deviceName}`
                  : remoteWifiConnected
                    ? remoteWifiLabel ?? "Wi-Fi FPV Connected"
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
                  ? "Pair directly with your LEGO BOOST Move Hub over Bluetooth"
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

      {/* Clear browser support notice (Quest Browser uses Wi-Fi FPV + WebXR instead of local BLE!) */}
      {!bleSupported && !remoteWifiConnected && (
        <div className="notice notice-info" role="status">
          {typeof navigator !== "undefined" && /OculusBrowser|Quest/i.test(navigator.userAgent || "") ? (
            <div>
              <strong>Meta Quest Browser Ready!</strong> Pair with the Android phone on your tank
              using <strong>Automatic Wi-Fi Discovery</strong> below, then click{" "}
              <strong>Enter VR Cockpit</strong> to drive immersively with your Touch hand controllers.
            </div>
          ) : (
            <div>
              <strong>Web Bluetooth isn&apos;t available in this browser.</strong> Open Vernie Pilot in{" "}
              <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> to pair a Move Hub
              directly over Bluetooth, or use the <strong>FPV Rover</strong> tab to drive over Wi-Fi.
            </div>
          )}
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
