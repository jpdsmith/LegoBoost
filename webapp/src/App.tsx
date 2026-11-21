// SPDX-License-Identifier: MIT
// Vernie OS Phase 4 Tactile Robotics Cockpit & Chromebook Web Bluetooth Flasher PWA.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { TelemetryFlag, TelemetryFrame } from "./ble/protocol";
import { ConnectionState, VernieClient } from "./ble/vernieClient";
import { DrivePad } from "./components/DrivePad";
import { FirmwareUpdater } from "./components/FirmwareUpdater";
import { HeadAndDart } from "./components/HeadAndDart";
import { ModeAndMacros } from "./components/ModeAndMacros";
import { MotorSynthPad } from "./components/MotorSynthPad";
import { TelemetryHud } from "./components/TelemetryHud";

type CockpitTab = "cockpit" | "synth" | "macros" | "flasher";

export const App: React.FC = () => {
  const bleSupported = typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
  const [activeTab, setActiveTab] = useState<CockpitTab>("cockpit");
  const [connState, setConnState] = useState<ConnectionState>("disconnected");
  const [deviceName, setDeviceName] = useState("VernieOS");
  const [telemetry, setTelemetry] = useState<TelemetryFrame | null>(null);
  const [rxHz, setRxHz] = useState(0);
  const [bleError, setBleError] = useState<string | null>(null);

  const timestampsRef = useRef<number[]>([]);
  const lastRxRef = useRef<number>(0);

  const client = useMemo(
    () =>
      new VernieClient({
        onStateChange: (next, name) => {
          setConnState(next);
          if (name) setDeviceName(name);
          if (next === "disconnected") {
            setTelemetry(null);
            setRxHz(0);
            timestampsRef.current = [];
            lastRxRef.current = 0;
          }
        },
        onTelemetry: (frame) => {
          setTelemetry(frame);
          const now = performance.now();
          lastRxRef.current = now;
          const buf = timestampsRef.current;
          buf.push(now);
          while (buf.length > 0 && now - buf[0] > 2000) {
            buf.shift();
          }
          if (buf.length >= 2) {
            const spanSec = (buf[buf.length - 1] - buf[0]) / 1000;
            setRxHz(spanSec > 0 ? (buf.length - 1) / spanSec : 0);
          }
        },
        onError: (err) => {
          setBleError(err.message);
        },
      }),
    []
  );

  // Cleanly tear down BLE connection on unmount (including React.StrictMode double-invoke).
  useEffect(() => {
    return () => {
      client.disconnect();
    };
  }, [client]);

  // Decay RX Hz to 0 if telemetry silently stalls while still connected.
  useEffect(() => {
    if (connState !== "connected") return;
    const id = window.setInterval(() => {
      if (lastRxRef.current > 0 && performance.now() - lastRxRef.current > 1500) {
        timestampsRef.current = [];
        setRxHz(0);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [connState]);

  const runBle = async (fn: () => Promise<void>) => {
    setBleError(null);
    try {
      await fn();
    } catch (err) {
      setBleError(err instanceof Error ? err.message : String(err));
    }
  };

  const runBleThrowing = async (fn: () => Promise<void>) => {
    setBleError(null);
    try {
      await fn();
    } catch (err) {
      setBleError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const connected = connState === "connected";
  const safeMode = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SAFE_MODE));
  const dartArmed = Boolean(telemetry && (telemetry.flags & TelemetryFlag.DART_ARMED));
  const headHomed = Boolean(telemetry && (telemetry.flags & TelemetryFlag.HEAD_HOMED));
  const pickedUp = Boolean(telemetry && (telemetry.flags & TelemetryFlag.PICKED_UP));
  const synthActive = Boolean(telemetry && (telemetry.flags & TelemetryFlag.SYNTH_ACTIVE));
  const motionDisabled = !connected || !telemetry || safeMode;

  const tabs: Array<{ id: CockpitTab; label: string }> = [
    { id: "cockpit", label: "Drive & Head" },
    { id: "synth", label: "Motor Synth & LEDs" },
    { id: "macros", label: "Modes & Macros" },
    { id: "flasher", label: "Flasher & Recovery" },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Vernie OS Cockpit</h1>
          <p className="subtitle">
            Pure-MIT native-C LEGO® BOOST Move Hub firmware · Chromebook Web Bluetooth Controller &amp; Flasher
          </p>
        </div>
        <span className={`status-dot status-${connState}`}>
          {connected
            ? `Connected · ${deviceName}`
            : connState === "connecting"
              ? "Pairing…"
              : "Disconnected"}
        </span>
      </header>

      {!bleSupported && (
        <div className="alert alert-error">
          <strong>Web Bluetooth Not Available:</strong> Open this page in{" "}
          <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on ChromeOS
          (Chromebook), macOS, Windows, Linux, or Android over HTTPS. iOS Safari does not support
          Web Bluetooth.
        </div>
      )}

      <TelemetryHud
        bleSupported={bleSupported}
        connectionState={connState}
        deviceName={deviceName}
        telemetry={telemetry}
        rxHz={rxHz}
        error={bleError}
        onConnect={() => void runBle(() => client.connect())}
        onDisconnect={() => client.disconnect()}
        onEmergencyStop={() => client.sendDrive(0, 0, 200)}
      />

      <nav className="tab-bar" role="tablist" aria-label="Vernie OS Cockpit views">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`tab-btn ${activeTab === tab.id ? "tab-btn-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main className="workspace">
        {activeTab === "cockpit" && (
          <div className="grid">
            <DrivePad
              connected={connected}
              disabled={motionDisabled}
              onDrive={(l, r, t) => client.sendDrive(l, r, t)}
            />
            <HeadAndDart
              connected={connected}
              disabled={motionDisabled}
              headHomed={headHomed}
              headDeg={telemetry?.headDeg ?? 0}
              dartArmed={dartArmed}
              pickedUp={pickedUp}
              onHead={(deg, spd, coalesce) =>
                void runBle(() => client.sendHead(deg, spd, { coalesce }))
              }
              onDartSubcmd={(s) => void runBle(() => client.sendDart(s))}
            />
          </div>
        )}

        {activeTab === "synth" && (
          <MotorSynthPad
            connected={connected}
            disabled={motionDisabled}
            synthActive={synthActive}
            onSynth={(v, n, d) => void runBle(() => client.sendSynth(v, n, d))}
            onSetHubLed={(r, g, b) => void runBle(() => client.sendHubLed(r, g, b))}
            onSetChestLed={(s) => void runBle(() => client.sendChestLed(s))}
          />
        )}

        {activeTab === "macros" && (
          <ModeAndMacros
            connected={connected}
            disabled={motionDisabled}
            activeModeId={telemetry ? telemetry.modeId : null}
            onSetMode={(m) => void runBle(() => client.sendSetMode(m))}
            onUploadMacro={(steps, opts) =>
              runBleThrowing(() => client.uploadMacro(steps, opts))
            }
            onPlayMacro={() => runBleThrowing(() => client.playMacro())}
            onStopMacro={() => runBleThrowing(() => client.stopMacro())}
            onClearMacro={() => runBleThrowing(() => client.clearMacro(true))}
          />
        )}

        {activeTab === "flasher" && (
          <FirmwareUpdater
            bleSupported={bleSupported}
            connectionState={connState}
            onRebootToBootloader={() => client.rebootToBootloader()}
          />
        )}
      </main>
    </div>
  );
};
