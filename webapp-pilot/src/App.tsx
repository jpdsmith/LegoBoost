// SPDX-License-Identifier: MIT
// Vernie Pilot — Tactile Progressive Web App for LEGO BOOST Vernie OS.
// Supports Tank/Rover FPV mode (Android Phone <-> Chromebook + Xbox Controller with Same-Wi-Fi Auto-Discovery),
// Vernie humanoid mode, live Web Bluetooth control, Smart Co-Pilot & Smooth Autonomous Explorer.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChestLedState,
  DartSubcmd,
  HEAD_HOME_SENTINEL,
  MacroStep,
  TelemetryFlag,
  TelemetryFrame,
} from "@core/ble/protocol";
import { ConnectionState, VernieClient } from "@core/ble/vernieClient";
import { DriveStation } from "./components/DriveStation";
import {
  IconBlocks,
  IconCamera,
  IconJoystick,
  IconMusic,
  IconWrench,
} from "./components/Icons";
import { MusicLightStation } from "./components/MusicLightStation";
import { RoutinesStation } from "./components/RoutinesStation";
import { RoverCockpitStation } from "./components/RoverCockpitStation";
import { SetupStation } from "./components/SetupStation";
import { TopConsoleBar } from "./components/TopConsoleBar";
import { ChassisProfile } from "./components/VernieTwin";
import { isMetaQuestBrowser } from "./xr/questVrCockpit";

type PilotStation = "drive" | "fpv" | "music" | "routines" | "setup";

function readInitialChassis(): ChassisProfile {
  try {
    const saved = window.localStorage.getItem("vernie-pilot-chassis");
    if (saved === "vernie" || saved === "rover") return saved;
  } catch {
    // ignore storage restrictions
  }
  return "rover";
}

function readInitialStation(): PilotStation {
  if (typeof window === "undefined") return "drive";
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("role") === "host" || params.get("role") === "fold" || params.get("join")) {
      return "fpv";
    }
    if (isMetaQuestBrowser()) {
      return "fpv";
    }
  } catch {
    // ignore
  }
  return "drive";
}

export const App: React.FC = () => {
  const bleSupported = typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
  const [station, setStation] = useState<PilotStation>(readInitialStation);
  const [chassis, setChassis] = useState<ChassisProfile>(readInitialChassis);
  const [headlightsOn, setHeadlightsOn] = useState(false);

  const [connState, setConnState] = useState<ConnectionState>("disconnected");
  const [deviceName, setDeviceName] = useState("VernieOS");
  const [bleTelemetry, setBleTelemetry] = useState<TelemetryFrame | null>(null);
  const [rxHz, setRxHz] = useState(0);
  const [bleError, setBleError] = useState<string | null>(null);

  // Wi-Fi FPV remote status mirrored up to TopConsoleBar
  const [wifiConnected, setWifiConnected] = useState(false);
  const [wifiLabel, setWifiLabel] = useState("");
  const [wifiTelemetry, setWifiTelemetry] = useState<TelemetryFrame | null>(null);
  const [emergencyStopSeq, setEmergencyStopSeq] = useState(0);

  // Optimistic visual state for live BLE
  const [bleHubRgb, setBleHubRgb] = useState<[number, number, number]>([0, 168, 232]);
  const [bleChestLed, setBleChestLed] = useState<number>(ChestLedState.OFF);
  const [bleHoming, setBleHoming] = useState(false);
  const [bleDartFiredAt, setBleDartFiredAt] = useState(0);

  const timestampsRef = useRef<number[]>([]);
  const lastRxRef = useRef<number>(0);

  const handleChassisChange = useCallback((next: ChassisProfile) => {
    setChassis(next);
    try {
      window.localStorage.setItem("vernie-pilot-chassis", next);
    } catch {
      // ignore
    }
  }, []);

  const handleWifiStatusChange = useCallback(
    (isConnected: boolean, label: string, remoteTelem: TelemetryFrame | null) => {
      setWifiConnected(isConnected);
      setWifiLabel(label);
      setWifiTelemetry(remoteTelem);
    },
    []
  );

  const client = useMemo(
    () =>
      new VernieClient({
        onStateChange: (next, name) => {
          setConnState(next);
          if (name) setDeviceName(name);
          if (next === "disconnected") {
            setBleTelemetry(null);
            setRxHz(0);
            setBleHoming(false);
            timestampsRef.current = [];
            lastRxRef.current = 0;
          }
        },
        onTelemetry: (frame) => {
          setBleTelemetry(frame);
          if (frame.flags & TelemetryFlag.HEAD_HOMED) {
            setBleHoming(false);
          }
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
        onError: (err) => setBleError(err.message),
      }),
    []
  );

  // Clean unmount teardown
  useEffect(() => {
    return () => {
      client.disconnect();
    };
  }, [client]);

  // Decay BLE RX Hz to 0 if telemetry stalls
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

  const isLiveBle = connState === "connected";
  const activeTelemetry = isLiveBle ? bleTelemetry : wifiTelemetry;
  const safeMode = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.SAFE_MODE));
  const headHomed = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.HEAD_HOMED));
  const pickedUp = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.PICKED_UP));
  const synthActive = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.SYNTH_ACTIVE));
  const motionDisabled = !isLiveBle || !bleTelemetry || safeMode;

  const runBle = useCallback(async (fn: () => Promise<void>) => {
    setBleError(null);
    try {
      await fn();
    } catch (err) {
      setBleError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const runBleThrowing = useCallback(async (fn: () => Promise<void>) => {
    setBleError(null);
    try {
      await fn();
    } catch (err) {
      setBleError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const handleDrive = useCallback(
    (left: number, right: number, timeoutMs = 400) => {
      if (isLiveBle) {
        client.sendDrive(left, right, timeoutMs);
      }
    },
    [client, isLiveBle]
  );

  const handleHead = useCallback(
    (angleDeg: number, speed = 50, coalesce = false) => {
      if (isLiveBle) {
        if (angleDeg === HEAD_HOME_SENTINEL) setBleHoming(true);
        void runBle(() => client.sendHead(angleDeg, speed, { coalesce }));
      }
    },
    [client, isLiveBle, runBle]
  );

  const handleDart = useCallback(
    (subcmd: number) => {
      if (isLiveBle) {
        if (subcmd === DartSubcmd.FIRE) setBleDartFiredAt(Date.now());
        void runBle(() => client.sendDart(subcmd));
      }
    },
    [client, isLiveBle, runBle]
  );

  const handleSynth = useCallback(
    (voice: number, presetOrNote: number, durMs = 280) => {
      if (isLiveBle) {
        void runBle(() => client.sendSynth(voice, presetOrNote, durMs));
      }
    },
    [client, isLiveBle, runBle]
  );

  const handleHubLed = useCallback(
    (r: number, g: number, b: number) => {
      if (isLiveBle) {
        setBleHubRgb([r, g, b]);
        void runBle(() => client.sendHubLed(r, g, b));
      }
    },
    [client, isLiveBle, runBle]
  );

  const handleChestLed = useCallback(
    (state: number) => {
      if (isLiveBle) {
        setBleChestLed(state);
        void runBle(() => client.sendChestLed(state));
      }
    },
    [client, isLiveBle, runBle]
  );

  const handleSetMode = useCallback(
    (modeId: number) => {
      if (isLiveBle) {
        void runBle(() => client.sendSetMode(modeId));
      }
    },
    [client, isLiveBle, runBle]
  );

  const handleUploadMacro = useCallback(
    (steps: MacroStep[], options: { saveToFlash?: boolean; playAfter?: boolean }) => {
      if (isLiveBle) {
        return runBleThrowing(() => client.uploadMacro(steps, options));
      }
      return Promise.resolve();
    },
    [client, isLiveBle, runBleThrowing]
  );

  const handlePlayMacro = useCallback(() => {
    if (isLiveBle) return runBleThrowing(() => client.playMacro());
    return Promise.resolve();
  }, [client, isLiveBle, runBleThrowing]);

  const handleStopMacro = useCallback(() => {
    if (isLiveBle) return runBleThrowing(() => client.stopMacro());
    return Promise.resolve();
  }, [client, isLiveBle, runBleThrowing]);

  const handleClearMacro = useCallback(() => {
    if (isLiveBle) return runBleThrowing(() => client.clearMacro(true));
    return Promise.resolve();
  }, [client, isLiveBle, runBleThrowing]);

  const handleEmergencyStop = useCallback(() => {
    setEmergencyStopSeq((s) => s + 1);
    handleDrive(0, 0, 200);
    if (isLiveBle) {
      void client.stopMacro().catch(() => undefined);
      void client.sendSynth(0, 0, 0).catch(() => undefined);
    }
  }, [client, handleDrive, isLiveBle]);

  const navItems: Array<{
    id: PilotStation;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: "drive", label: "Drive", icon: <IconJoystick size={18} /> },
    { id: "fpv", label: "FPV Rover", icon: <IconCamera size={18} /> },
    { id: "music", label: "Music & Lights", icon: <IconMusic size={18} /> },
    { id: "routines", label: "Routines", icon: <IconBlocks size={18} /> },
    { id: "setup", label: "Setup", icon: <IconWrench size={18} /> },
  ];

  return (
    <div className="pilot-shell">
      <TopConsoleBar
        bleSupported={bleSupported}
        connectionState={connState}
        remoteWifiConnected={wifiConnected}
        remoteWifiLabel={wifiLabel}
        deviceName={deviceName}
        telemetry={activeTelemetry}
        bleError={bleError}
        onConnect={() => void runBle(() => client.connect())}
        onDisconnect={() => client.disconnect()}
        onEmergencyStop={handleEmergencyStop}
        onGoToSetup={() => setStation("setup")}
      />

      {/* Responsive Hardware Navigation Deck */}
      <nav className="station-nav" role="tablist" aria-label="Vernie Pilot stations">
        {navItems.map((item) => (
          <button
            key={item.id}
            id={`nav-${item.id}`}
            type="button"
            role="tab"
            aria-selected={station === item.id}
            className={`station-tab ${station === item.id ? "is-active" : ""}`}
            onClick={() => setStation(item.id)}
          >
            <span className="station-tab-icon">{item.icon}</span>
            <span className="station-tab-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Main Active Station */}
      <main className="pilot-workspace">
        {station === "drive" && (
          <DriveStation
            chassis={chassis}
            headlightsOn={headlightsOn}
            connected={isLiveBle}
            disabled={motionDisabled}
            telemetry={bleTelemetry}
            hubRgb={bleHubRgb}
            chestLedState={bleChestLed}
            homingInProgress={bleHoming}
            dartFiredAt={bleDartFiredAt}
            onDrive={handleDrive}
            onHead={handleHead}
            onDartSubcmd={handleDart}
            onSetMode={handleSetMode}
            onSynth={handleSynth}
            onChangeChassis={handleChassisChange}
            onOpenFpv={() => setStation("fpv")}
          />
        )}

        {/* Kept mounted across tab switches so Wi-Fi FPV & Android Host camera never drop! */}
        <RoverCockpitStation
          isActiveTab={station === "fpv"}
          connected={isLiveBle}
          disabled={motionDisabled}
          safeMode={safeMode}
          headHomed={headHomed}
          headDeg={bleTelemetry?.headDeg ?? 0}
          pickedUp={pickedUp}
          distancePct={bleTelemetry?.distancePct ?? 255}
          telemetry={bleTelemetry}
          headlightsOn={headlightsOn}
          emergencyStopSeq={emergencyStopSeq}
          onHeadlightsChange={setHeadlightsOn}
          onWifiStatusChange={handleWifiStatusChange}
          onDrive={handleDrive}
          onHead={handleHead}
          onSynth={handleSynth}
          onSetHubLed={handleHubLed}
          onSetMode={handleSetMode}
          onPlayMacro={handlePlayMacro}
          onStopMacro={handleStopMacro}
        />

        {station === "music" && (
          <MusicLightStation
            connected={isLiveBle}
            disabled={motionDisabled}
            synthActive={synthActive}
            hubRgb={bleHubRgb}
            chestLedState={bleChestLed}
            onSynth={handleSynth}
            onSetHubLed={handleHubLed}
            onSetChestLed={handleChestLed}
          />
        )}

        {station === "routines" && (
          <RoutinesStation
            connected={isLiveBle}
            disabled={motionDisabled}
            activeModeId={bleTelemetry ? bleTelemetry.modeId : null}
            activeMacroStepIndex={null}
            onSetMode={handleSetMode}
            onUploadMacro={handleUploadMacro}
            onPlayMacro={handlePlayMacro}
            onStopMacro={handleStopMacro}
            onClearMacro={handleClearMacro}
          />
        )}

        {station === "setup" && (
          <SetupStation
            bleSupported={bleSupported}
            connectionState={connState}
            telemetry={bleTelemetry}
            rxHz={rxHz}
            onRebootToBootloader={() => client.rebootToBootloader()}
          />
        )}
      </main>
    </div>
  );
};
