// SPDX-License-Identifier: MIT
// Vernie Pilot — Tactile, User-Friendly Progressive Web App for LEGO BOOST Vernie OS.
// Supports both live Web Bluetooth hardware control and a built-in interactive Demo Simulator.

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
import { EyesVoiceStation } from "./components/EyesVoiceStation";
import {
  IconBlocks,
  IconEye,
  IconJoystick,
  IconMusic,
  IconWrench,
} from "./components/Icons";
import { MusicLightStation } from "./components/MusicLightStation";
import { RoutinesStation } from "./components/RoutinesStation";
import { SetupStation } from "./components/SetupStation";
import { TopConsoleBar } from "./components/TopConsoleBar";
import { VirtualVernieSimulator, VirtualVisualState } from "./sim/virtualVernie";

type PilotStation = "drive" | "music" | "routines" | "eyes" | "setup";

const INITIAL_VISUAL: VirtualVisualState = {
  hubRgb: [0, 168, 232],
  chestLedState: ChestLedState.OFF,
  homingInProgress: false,
  dartFiredAt: 0,
  activeMacroStepIndex: null,
  macroPlaying: false,
  savedMacroCount: 0,
  soundEnabled: true,
  floorX: 0,
  floorY: 0,
  headingDeg: 0,
};

export const App: React.FC = () => {
  const bleSupported = typeof navigator !== "undefined" && Boolean(navigator.bluetooth);
  const [station, setStation] = useState<PilotStation>("drive");
  const [connState, setConnState] = useState<ConnectionState>("disconnected");
  const [deviceName, setDeviceName] = useState("VernieOS");
  const [bleTelemetry, setBleTelemetry] = useState<TelemetryFrame | null>(null);
  const [rxHz, setRxHz] = useState(0);
  const [bleError, setBleError] = useState<string | null>(null);

  // Optimistic visual state for live BLE (mirrors Hub LED, Chest LED, and dart launch animation)
  const [bleHubRgb, setBleHubRgb] = useState<[number, number, number]>([0, 168, 232]);
  const [bleChestLed, setBleChestLed] = useState<number>(ChestLedState.OFF);
  const [bleHoming, setBleHoming] = useState(false);
  const [bleDartFiredAt, setBleDartFiredAt] = useState(0);

  // Interactive Demo Mode state
  const [demoMode, setDemoMode] = useState(false);
  const [demoTelemetry, setDemoTelemetry] = useState<TelemetryFrame | null>(null);
  const [demoVisual, setDemoVisual] = useState<VirtualVisualState>(INITIAL_VISUAL);

  const timestampsRef = useRef<number[]>([]);
  const lastRxRef = useRef<number>(0);

  const sim = useMemo(
    () =>
      new VirtualVernieSimulator({
        onTelemetry: (frame) => setDemoTelemetry(frame),
        onVisualChange: (vis) => setDemoVisual(vis),
      }),
    []
  );

  const client = useMemo(
    () =>
      new VernieClient({
        onStateChange: (next, name) => {
          setConnState(next);
          if (name) setDeviceName(name);
          if (next === "connected") {
            setDemoMode(false);
            sim.stop();
          }
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
    [sim]
  );

  // Clean unmount teardown
  useEffect(() => {
    return () => {
      client.disconnect();
      sim.stop();
    };
  }, [client, sim]);

  // Start/stop virtual robot simulator cleanly when toggling Demo Mode
  useEffect(() => {
    if (demoMode && connState !== "connected") {
      sim.start();
      return () => sim.stop();
    }
    sim.stop();
    return undefined;
  }, [demoMode, connState, sim]);

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
  const isDemoActive = demoMode && !isLiveBle;
  const isOnline = isLiveBle || isDemoActive;
  const activeTelemetry = isLiveBle ? bleTelemetry : isDemoActive ? demoTelemetry : null;
  const activeHubRgb = isLiveBle ? bleHubRgb : demoVisual.hubRgb;
  const activeChestLed = isLiveBle ? bleChestLed : demoVisual.chestLedState;
  const activeHoming = isLiveBle ? bleHoming : demoVisual.homingInProgress;
  const activeDartFiredAt = isLiveBle ? bleDartFiredAt : demoVisual.dartFiredAt;

  const safeMode = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.SAFE_MODE));
  const headHomed = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.HEAD_HOMED));
  const pickedUp = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.PICKED_UP));
  const synthActive = Boolean(activeTelemetry && (activeTelemetry.flags & TelemetryFlag.SYNTH_ACTIVE));
  const motionDisabled = !isOnline || !activeTelemetry || safeMode;

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

  // Unified command dispatchers (route to Live BLE or Demo Simulator cleanly)
  const handleDrive = useCallback(
    (left: number, right: number, timeoutMs = 400) => {
      if (isLiveBle) {
        client.sendDrive(left, right, timeoutMs);
      } else if (isDemoActive) {
        sim.sendDrive(left, right, timeoutMs);
      }
    },
    [client, isDemoActive, isLiveBle, sim]
  );

  const handleHead = useCallback(
    (angleDeg: number, speed = 50, coalesce = false) => {
      if (isLiveBle) {
        if (angleDeg === HEAD_HOME_SENTINEL) setBleHoming(true);
        void runBle(() => client.sendHead(angleDeg, speed, { coalesce }));
      } else if (isDemoActive) {
        void sim.sendHead(angleDeg);
      }
    },
    [client, isDemoActive, isLiveBle, runBle, sim]
  );

  const handleDart = useCallback(
    (subcmd: number) => {
      if (isLiveBle) {
        if (subcmd === DartSubcmd.FIRE) setBleDartFiredAt(Date.now());
        void runBle(() => client.sendDart(subcmd));
      } else if (isDemoActive) {
        void sim.sendDart(subcmd);
      }
    },
    [client, isDemoActive, isLiveBle, runBle, sim]
  );

  const handleSynth = useCallback(
    (voice: number, presetOrNote: number, durMs = 280) => {
      if (isLiveBle) {
        void runBle(() => client.sendSynth(voice, presetOrNote, durMs));
      } else if (isDemoActive) {
        void sim.sendSynth(voice, presetOrNote, durMs);
      }
    },
    [client, isDemoActive, isLiveBle, runBle, sim]
  );

  const handleHubLed = useCallback(
    (r: number, g: number, b: number) => {
      if (isLiveBle) {
        setBleHubRgb([r, g, b]);
        void runBle(() => client.sendHubLed(r, g, b));
      } else if (isDemoActive) {
        void sim.sendHubLed(r, g, b);
      }
    },
    [client, isDemoActive, isLiveBle, runBle, sim]
  );

  const handleChestLed = useCallback(
    (state: number) => {
      if (isLiveBle) {
        setBleChestLed(state);
        void runBle(() => client.sendChestLed(state));
      } else if (isDemoActive) {
        void sim.sendChestLed(state);
      }
    },
    [client, isDemoActive, isLiveBle, runBle, sim]
  );

  const handleSetMode = useCallback(
    (modeId: number) => {
      if (isLiveBle) {
        void runBle(() => client.sendSetMode(modeId));
      } else if (isDemoActive) {
        void sim.sendSetMode(modeId);
      }
    },
    [client, isDemoActive, isLiveBle, runBle, sim]
  );

  const handleUploadMacro = useCallback(
    (steps: MacroStep[], options: { saveToFlash?: boolean; playAfter?: boolean }) => {
      if (isLiveBle) {
        return runBleThrowing(() => client.uploadMacro(steps, options));
      }
      if (isDemoActive) {
        return sim.uploadMacro(steps, options);
      }
      return Promise.resolve();
    },
    [client, isDemoActive, isLiveBle, runBleThrowing, sim]
  );

  const handlePlayMacro = useCallback(() => {
    if (isLiveBle) return runBleThrowing(() => client.playMacro());
    if (isDemoActive) return sim.playMacro();
    return Promise.resolve();
  }, [client, isDemoActive, isLiveBle, runBleThrowing, sim]);

  const handleStopMacro = useCallback(() => {
    if (isLiveBle) return runBleThrowing(() => client.stopMacro());
    if (isDemoActive) return sim.stopMacro();
    return Promise.resolve();
  }, [client, isDemoActive, isLiveBle, runBleThrowing, sim]);

  const handleClearMacro = useCallback(() => {
    if (isLiveBle) return runBleThrowing(() => client.clearMacro(true));
    if (isDemoActive) return sim.clearMacro();
    return Promise.resolve();
  }, [client, isDemoActive, isLiveBle, runBleThrowing, sim]);

  const handleEmergencyStop = useCallback(() => {
    handleDrive(0, 0, 200);
    if (isLiveBle) {
      void client.stopMacro().catch(() => undefined);
      void client.sendSynth(0, 0, 0).catch(() => undefined);
    } else if (isDemoActive) {
      void sim.stopMacro();
      void sim.sendSynth(0, 0, 0);
    }
  }, [client, handleDrive, isDemoActive, isLiveBle, sim]);

  const navItems: Array<{
    id: PilotStation;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: "drive", label: "Drive", icon: <IconJoystick size={18} /> },
    { id: "music", label: "Music & Lights", icon: <IconMusic size={18} /> },
    { id: "routines", label: "Routines", icon: <IconBlocks size={18} /> },
    { id: "eyes", label: "Eyes & Voice", icon: <IconEye size={18} /> },
    { id: "setup", label: "Setup", icon: <IconWrench size={18} /> },
  ];

  return (
    <div className="pilot-shell">
      <TopConsoleBar
        bleSupported={bleSupported}
        connectionState={connState}
        demoMode={isDemoActive}
        demoSound={demoVisual.soundEnabled}
        deviceName={deviceName}
        telemetry={activeTelemetry}
        bleError={bleError}
        onConnect={() => void runBle(() => client.connect())}
        onDisconnect={() => client.disconnect()}
        onToggleDemo={() => {
          setBleError(null);
          setDemoMode((v) => !v);
        }}
        onToggleDemoSound={() => sim.setSoundEnabled(!demoVisual.soundEnabled)}
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
            connected={isOnline}
            demoMode={isDemoActive}
            disabled={motionDisabled}
            telemetry={activeTelemetry}
            hubRgb={activeHubRgb}
            chestLedState={activeChestLed}
            homingInProgress={activeHoming}
            dartFiredAt={activeDartFiredAt}
            onDrive={handleDrive}
            onHead={handleHead}
            onDartSubcmd={handleDart}
            onSetMode={handleSetMode}
            onSynth={handleSynth}
            onLaunchDemo={() => {
              setBleError(null);
              setDemoMode(true);
            }}
            onDemoTogglePickup={() => sim.togglePickedUp()}
            onDemoBump={() => sim.triggerBump()}
            onDemoBrick={(cid) => sim.presentColorBrick(cid)}
          />
        )}

        {station === "music" && (
          <MusicLightStation
            connected={isOnline}
            disabled={motionDisabled}
            synthActive={synthActive}
            hubRgb={activeHubRgb}
            chestLedState={activeChestLed}
            onSynth={handleSynth}
            onSetHubLed={handleHubLed}
            onSetChestLed={handleChestLed}
          />
        )}

        {station === "routines" && (
          <RoutinesStation
            connected={isOnline}
            disabled={motionDisabled}
            activeModeId={activeTelemetry ? activeTelemetry.modeId : null}
            activeMacroStepIndex={isDemoActive ? demoVisual.activeMacroStepIndex : null}
            onSetMode={handleSetMode}
            onUploadMacro={handleUploadMacro}
            onPlayMacro={handlePlayMacro}
            onStopMacro={handleStopMacro}
            onClearMacro={handleClearMacro}
          />
        )}

        {station === "eyes" && (
          <EyesVoiceStation
            connected={isOnline}
            disabled={motionDisabled}
            safeMode={safeMode}
            headHomed={headHomed}
            headDeg={activeTelemetry?.headDeg ?? 0}
            pickedUp={pickedUp}
            distancePct={activeTelemetry?.distancePct ?? 255}
            onDrive={handleDrive}
            onHead={handleHead}
            onSynth={handleSynth}
            onSetHubLed={handleHubLed}
            onSetMode={handleSetMode}
            onPlayMacro={handlePlayMacro}
            onStopMacro={handleStopMacro}
          />
        )}

        {station === "setup" && (
          <SetupStation
            bleSupported={bleSupported}
            connectionState={connState}
            demoMode={isDemoActive}
            telemetry={activeTelemetry}
            rxHz={isDemoActive ? 10.0 : rxHz}
            onRebootToBootloader={() => client.rebootToBootloader()}
          />
        )}
      </main>
    </div>
  );
};
