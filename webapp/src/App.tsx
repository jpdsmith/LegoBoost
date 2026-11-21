// SPDX-License-Identifier: MIT
import React, { useEffect, useMemo, useRef, useState } from "react";
import { TelemetryFrame } from "./ble/protocol";
import { ConnectionState, VernieClient } from "./ble/vernieClient";
import { FirmwareUpdater } from "./components/FirmwareUpdater";
import { TelemetryHud } from "./components/TelemetryHud";

export const App: React.FC = () => {
  const bleSupported = typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
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

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Vernie OS Cockpit</h1>
          <p className="subtitle">
            Custom native-C LEGO® BOOST Move Hub firmware · Phase 2 Hardware Drivers &amp; 2-Voice Synth
          </p>
        </div>
        <span className={`status-dot status-${connState}`}>
          {connState === "connected"
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

      <main className="grid">
        <FirmwareUpdater
          bleSupported={bleSupported}
          connectionState={connState}
          onRebootToBootloader={() => client.rebootToBootloader()}
        />

        <TelemetryHud
          bleSupported={bleSupported}
          connectionState={connState}
          deviceName={deviceName}
          telemetry={telemetry}
          rxHz={rxHz}
          error={bleError}
          onConnect={() => void runBle(() => client.connect())}
          onDisconnect={() => client.disconnect()}
          onDrive={(l, r, t) => client.sendDrive(l, r, t)}
          onHead={(deg, spd) => void runBle(() => client.sendHead(deg, spd))}
          onSynth={(v, n, d) => void runBle(() => client.sendSynth(v, n, d))}
          onSetHubLed={(r, g, b) => void runBle(() => client.sendHubLed(r, g, b))}
          onSetChestLed={(s) => void runBle(() => client.sendChestLed(s))}
          onSetMode={(m) => void runBle(() => client.sendSetMode(m))}
          onDartSubcmd={(s) => void runBle(() => client.sendDart(s))}
        />
      </main>
    </div>
  );
};
