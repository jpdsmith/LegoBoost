// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// Layer 4 React UI Component Tests for Phase 4 Tactile Cockpit PWA.

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import {
  ChestLedState,
  DartSubcmd,
  HEAD_HOME_SENTINEL,
  MacroStepOp,
  TelemetryFlag,
  TelemetryFrame,
} from "../ble/protocol";
import { DrivePad, mixArcadeToTank } from "./DrivePad";
import { FirmwareUpdater } from "./FirmwareUpdater";
import { HeadAndDart } from "./HeadAndDart";
import { ModeAndMacros } from "./ModeAndMacros";
import { MotorSynthPad } from "./MotorSynthPad";
import { TelemetryHud } from "./TelemetryHud";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function sampleTelemetry(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    batteryMv: 8120,
    distancePct: 40,
    colorId: 5,
    pitchDeg: -4,
    rollDeg: 2,
    flags: TelemetryFlag.SENSOR_OK,
    modeId: 4,
    encA: 120,
    encB: -120,
    headDeg: 0,
    speedA: 0,
    speedB: 0,
    seq: 7,
    ...overrides,
  };
}

describe("TelemetryHud live telemetry strip & Watchdog Safe Mode banner", () => {
  const baseProps = {
    bleSupported: true,
    connectionState: "connected" as const,
    deviceName: "VernieOS",
    telemetry: null,
    rxHz: 10.0,
    error: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onEmergencyStop: vi.fn(),
  };

  it("shows Watchdog Safe Mode banner and battery voltage when SAFE_MODE flag is set", () => {
    const onEmergencyStop = vi.fn();
    render(
      <TelemetryHud
        {...baseProps}
        onEmergencyStop={onEmergencyStop}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.SAFE_MODE, batteryMv: 7650 })}
      />
    );
    expect(screen.getByText(/Watchdog Safe Mode Active/i)).toBeTruthy();
    expect(screen.getByText(/7650 mV/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^STOP$/i }));
    expect(onEmergencyStop).toHaveBeenCalledTimes(1);
  });

  it("renders all live IMU, 88007 chest color/distance, head homed, dart, and synth badges", () => {
    render(
      <TelemetryHud
        {...baseProps}
        telemetry={sampleTelemetry({
          flags:
            TelemetryFlag.DART_ARMED |
            TelemetryFlag.HEAD_HOMED |
            TelemetryFlag.SENSOR_OK |
            TelemetryFlag.PICKED_UP |
            TelemetryFlag.BUMP |
            TelemetryFlag.TAP |
            TelemetryFlag.SYNTH_ACTIVE,
        })}
      />
    );
    expect(screen.getByText("PICKED UP")).toBeTruthy();
    expect(screen.getByText("BUMP")).toBeTruthy();
    expect(screen.getByText("TAP/BTN")).toBeTruthy();
    expect(screen.getByText("SYNTH ON")).toBeTruthy();
    expect(screen.getByText("ARMED")).toBeTruthy();
    expect(screen.getByText(/Color: Green/i)).toBeTruthy();
    expect(screen.getByText(/HOMED/i)).toBeTruthy();
  });

  it("disables Connect when Web Bluetooth is unsupported and invokes disconnect when connected", () => {
    const onDisconnect = vi.fn();
    const { rerender } = render(
      <TelemetryHud
        {...baseProps}
        bleSupported={false}
        connectionState="disconnected"
        onDisconnect={onDisconnect}
      />
    );
    expect((screen.getByRole("button", { name: /Connect to VernieOS/i }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <TelemetryHud
        {...baseProps}
        bleSupported={true}
        connectionState="connected"
        onDisconnect={onDisconnect}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Disconnect VernieOS/i }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe("DrivePad arcade mixer, D-pad, keyboard drive & safety STOP", () => {
  it("mixArcadeToTank applies deadzone, differential tank normalization, and speed cap", () => {
    expect(mixArcadeToTank(0.05, -0.1, 80)).toEqual({ left: 0, right: 0 });
    expect(mixArcadeToTank(0, 1, 60)).toEqual({ left: 60, right: 60 });
    expect(mixArcadeToTank(1, 0, 50)).toEqual({ left: 50, right: -50 });
    expect(mixArcadeToTank(1, 1, 80)).toEqual({ left: 80, right: 0 });
  });

  it("scales D-pad pulses by speed cap and handles Spacebar urgent STOP even in disabled Safe Mode", () => {
    const onDrive = vi.fn();
    const { rerender } = render(<DrivePad connected={true} disabled={false} onDrive={onDrive} />);

    fireEvent.change(screen.getByLabelText(/Speed Limit/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Forward$/i }));
    expect(onDrive).toHaveBeenCalledWith(50, 50, 400);

    fireEvent.click(screen.getByRole("button", { name: /Spin Left/i }));
    expect(onDrive).toHaveBeenCalledWith(-40, 40, 400);

    // Spacebar STOP still fires when connected even if Safe Mode disables motion buttons
    rerender(<DrivePad connected={true} disabled={true} onDrive={onDrive} />);
    expect((screen.getByRole("button", { name: /^Forward$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^STOP$/i }) as HTMLButtonElement).disabled).toBe(false);

    onDrive.mockClear();
    fireEvent.keyDown(window, { code: "Space" });
    expect(onDrive).toHaveBeenCalledWith(0, 0, 200);
  });

  it("streams WASD drive at 16 Hz and sends immediate STOP on unmount while driving", () => {
    vi.useFakeTimers();
    const onDrive = vi.fn();
    const { unmount } = render(<DrivePad connected={true} disabled={false} onDrive={onDrive} />);

    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(onDrive).toHaveBeenCalledWith(65, 65, 400);

    onDrive.mockClear();
    unmount();
    expect(onDrive).toHaveBeenCalledWith(0, 0, 200);
  });
});

describe("HeadAndDart non-trigger homing, C2 unhomed lock & 2-step dart interlock", () => {
  it("locks head positioning & Fire Dart until headHomed && dartArmed && !pickedUp", () => {
    const onHead = vi.fn();
    const onDartSubcmd = vi.fn();

    // Unhomed + Armed -> positioning and Fire Dart MUST stay disabled (C2)
    const { rerender } = render(
      <HeadAndDart
        connected={true}
        disabled={false}
        headHomed={false}
        headDeg={0}
        dartArmed={true}
        pickedUp={false}
        onHead={onHead}
        onDartSubcmd={onDartSubcmd}
      />
    );
    expect((screen.getByRole("button", { name: /Far Right/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Head target angle/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Fire Dart/i }) as HTMLButtonElement).disabled).toBe(true);

    // Homed + Armed + Picked Up -> head unlocked, Fire Dart STILL blocked!
    rerender(
      <HeadAndDart
        connected={true}
        disabled={false}
        headHomed={true}
        headDeg={0}
        dartArmed={true}
        pickedUp={true}
        onHead={onHead}
        onDartSubcmd={onDartSubcmd}
      />
    );
    expect((screen.getByLabelText(/Head target angle/i) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /Fire Dart/i }) as HTMLButtonElement).disabled).toBe(true);

    // Homed + Armed + Upright -> all enabled
    rerender(
      <HeadAndDart
        connected={true}
        disabled={false}
        headHomed={true}
        headDeg={0}
        dartArmed={true}
        pickedUp={false}
        onHead={onHead}
        onDartSubcmd={onDartSubcmd}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Home Head/i }));
    expect(onHead).toHaveBeenCalledWith(HEAD_HOME_SENTINEL, 30);

    fireEvent.click(screen.getByRole("button", { name: /Curious \(-20°\)/i }));
    expect(onHead).toHaveBeenCalledWith(-20, 55);

    fireEvent.change(screen.getByLabelText(/Head target angle/i), { target: { value: "20" } });
    expect(onHead).toHaveBeenCalledWith(20, 55, true);

    fireEvent.click(screen.getByRole("button", { name: /Fire Dart/i }));
    expect(onDartSubcmd).toHaveBeenCalledWith(DartSubcmd.FIRE);

    fireEvent.click(screen.getByRole("button", { name: /Disarm Lock/i }));
    expect(onDartSubcmd).toHaveBeenCalledWith(DartSubcmd.DISARM);

    // Disconnect resets slider back to 0°
    rerender(
      <HeadAndDart
        connected={false}
        disabled={true}
        headHomed={false}
        headDeg={0}
        dartArmed={false}
        pickedUp={false}
        onHead={onHead}
        onDartSubcmd={onDartSubcmd}
      />
    );
    expect((screen.getByLabelText(/Head target angle/i) as HTMLInputElement).value).toBe("0");
  });
});

describe("MotorSynthPad piano, voice routing, SFX & LEDs", () => {
  it("routes SFX, chromatic piano notes, Stop Synth, Hub RGB & Chest LED commands", () => {
    const onSynth = vi.fn();
    const onSetHubLed = vi.fn();
    const onSetChestLed = vi.fn();

    render(
      <MotorSynthPad
        connected={true}
        disabled={false}
        synthActive={true}
        onSynth={onSynth}
        onSetHubLed={onSetHubLed}
        onSetChestLed={onSetChestLed}
      />
    );
    expect(screen.getByText("SYNTH ACTIVE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /V2 Head/i }));
    fireEvent.click(screen.getByRole("button", { name: /500 ms/i }));
    fireEvent.click(screen.getByRole("button", { name: /Happy Chirp/i }));
    expect(onSynth).toHaveBeenCalledWith(2, 2, 0);

    fireEvent.click(screen.getByRole("button", { name: /^C5$/i }));
    expect(onSynth).toHaveBeenCalledWith(2, 72, 500);

    fireEvent.click(screen.getByRole("button", { name: /Stop Synth/i }));
    expect(onSynth).toHaveBeenCalledWith(0, 0, 0);

    fireEvent.click(screen.getByRole("button", { name: /Vernie Orange/i }));
    expect(onSetHubLed).toHaveBeenCalledWith(255, 122, 0);

    fireEvent.change(screen.getByLabelText(/Custom Hub RGB color/i), {
      target: { value: "#112233" },
    });
    expect(onSetHubLed).toHaveBeenCalledWith(0x11, 0x22, 0x33);

    fireEvent.click(screen.getByRole("button", { name: /Chest: Red/i }));
    expect(onSetChestLed).toHaveBeenCalledWith(ChestLedState.RED);
  });
});

describe("ModeAndMacros selector & visual Flash Macro composer", () => {
  it("switches modes, composes/clamps/reorders/deletes macro steps, and persists to FLASH_USER_1", async () => {
    const onSetMode = vi.fn();
    const onUploadMacro = vi.fn().mockResolvedValue(undefined);
    const onPlayMacro = vi.fn().mockResolvedValue(undefined);
    const onStopMacro = vi.fn().mockResolvedValue(undefined);
    const onClearMacro = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <ModeAndMacros
        connected={true}
        disabled={false}
        activeModeId={4}
        onSetMode={onSetMode}
        onUploadMacro={onUploadMacro}
        onPlayMacro={onPlayMacro}
        onStopMacro={onStopMacro}
        onClearMacro={onClearMacro}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /1: Room Explorer/i }));
    expect(onSetMode).toHaveBeenCalledWith(1);

    // Clear composer and add two custom steps (with out-of-range HEAD angle clamped to 35°)
    fireEvent.click(screen.getByRole("button", { name: /Empty Sequence/i }));
    expect(screen.getByText(/0\/46 steps · 0\/232 B/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Macro step opcode/i), {
      target: { value: String(MacroStepOp.HEAD) },
    });
    fireEvent.change(screen.getByLabelText(/Macro step arg0/i), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Step/i }));

    fireEvent.change(screen.getByLabelText(/Macro step opcode/i), {
      target: { value: String(MacroStepOp.WAIT) },
    });
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Step/i }));
    expect(screen.getByText(/2\/46 steps · 10\/232 B/i)).toBeTruthy();
    expect(screen.getByText(/1\. HEAD 35°/i)).toBeTruthy();

    // Move step 2 up so WAIT becomes step 1
    fireEvent.click(screen.getByRole("button", { name: /Move step 2 up/i }));
    expect(screen.getByText(/1\. WAIT/i)).toBeTruthy();

    // Remove step 1
    fireEvent.click(screen.getByRole("button", { name: /Remove step 1/i }));
    expect(screen.getByText(/1\/46 steps · 5\/232 B/i)).toBeTruthy();

    // Load Desk Patrol preset and Save to Flash
    fireEvent.click(screen.getByRole("button", { name: /Desk Patrol/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save to Flash/i }));
    await waitFor(() => {
      expect(onUploadMacro).toHaveBeenCalledWith(expect.any(Array), { saveToFlash: true });
      expect(screen.getByText(/Saved 7 steps \(35 B\) to FLASH_USER_1/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Play Saved/i }));
    await waitFor(() => expect(onPlayMacro).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Stop Macro/i }));
    await waitFor(() => expect(onStopMacro).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Clear Flash Macro/i }));
    await waitFor(() => expect(onClearMacro).toHaveBeenCalledTimes(1));

    // Disconnect clears stale status banner
    rerender(
      <ModeAndMacros
        connected={false}
        disabled={true}
        activeModeId={null}
        onSetMode={onSetMode}
        onUploadMacro={onUploadMacro}
        onPlayMacro={onPlayMacro}
        onStopMacro={onStopMacro}
        onClearMacro={onClearMacro}
      />
    );
    expect(screen.queryByText(/Cleared saved macro/i)).toBeNull();
  });
});

describe("FirmwareUpdater Chromebook UX & pre-flash safety", () => {
  it("handles Step 1 reboot cleanly and displays Step 2 hint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const onReboot = vi.fn().mockResolvedValue(undefined);
    render(
      <FirmwareUpdater
        bleSupported={true}
        connectionState="connected"
        onRebootToBootloader={onReboot}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Send Software Reboot/i }));

    await waitFor(() => {
      expect(screen.getByText(/Reboot command sent/i)).toBeTruthy();
    });
    expect(onReboot).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Download firmware\.zip/i)).toBeNull();
  });

  it("rejects invalid custom .bin upload with clear error and resets file input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { container } = render(
      <FirmwareUpdater
        bleSupported={true}
        connectionState="disconnected"
        onRebootToBootloader={vi.fn()}
      />
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File([new Uint8Array([1, 2, 3, 4])], "bad.bin", {
      type: "application/octet-stream",
    });
    Object.defineProperty(badFile, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    fireEvent.change(input, { target: { files: [badFile] } });

    await waitFor(() => {
      expect(screen.getByText(/failed Move Hub 108,544-byte zero-sum verification/i)).toBeTruthy();
    });
    expect(input.value).toBe("");
  });
});

describe("App multi-tab shell", () => {
  it("shows Web Bluetooth warning, navigates across all 4 tabs, and unmounts cleanly under StrictMode", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { unmount } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    expect(screen.getByText(/Web Bluetooth Not Available/i)).toBeTruthy();
    expect(screen.getByText(/Tank Drive Pad/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Motor Synth & LEDs/i }));
    expect(screen.getByText(/Playable Motor Piano/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Modes & Macros/i }));
    expect(screen.getByText(/Visual Flash Macro Composer/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Flasher & Recovery/i }));
    expect(screen.getByText(/Chromebook Web Bluetooth Flasher/i)).toBeTruthy();

    unmount();
  });
});
