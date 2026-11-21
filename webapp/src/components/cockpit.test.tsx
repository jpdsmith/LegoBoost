// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// Layer 4 React UI Component Tests for TelemetryHud (Phase 2), FirmwareUpdater, and App.

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ChestLedState, DartSubcmd, HEAD_HOME_SENTINEL, TelemetryFlag, TelemetryFrame } from "../ble/protocol";
import { FirmwareUpdater } from "./FirmwareUpdater";
import { TelemetryHud } from "./TelemetryHud";

afterEach(() => {
  cleanup();
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

describe("TelemetryHud UI safety & Phase 2 hardware diagnostics", () => {
  const baseProps = {
    bleSupported: true,
    connectionState: "connected" as const,
    deviceName: "VernieOS",
    telemetry: null,
    rxHz: 10.0,
    error: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onDrive: vi.fn(),
    onHead: vi.fn(),
    onSynth: vi.fn(),
    onSetHubLed: vi.fn(),
    onSetChestLed: vi.fn(),
    onSetMode: vi.fn(),
    onDartSubcmd: vi.fn(),
  };

  it("keeps Mode, Drive, Head, Synth, and Arm controls disabled until first telemetry confirms !safeMode", () => {
    render(<TelemetryHud {...baseProps} telemetry={null} />);
    expect((screen.getByRole("button", { name: /^Arm Lock/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /1: Room Explorer/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Home Head/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Happy Chirp/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Watchdog Safe Mode warning banner and locks out motion/arm/synth controls when SAFE_MODE flag is set", () => {
    render(
      <TelemetryHud
        {...baseProps}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.SAFE_MODE, batteryMv: 7650 })}
      />
    );
    expect(screen.getByText(/Watchdog Safe Mode Active/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Arm Lock/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Fire Dart/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Disarm Lock/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/7650 mV/i)).toBeTruthy();
  });

  it("enforces Armed + Homed interlock on Fire Dart and dispatches Phase 2 hardware commands", () => {
    const onDrive = vi.fn();
    const onHead = vi.fn();
    const onSynth = vi.fn();
    const onSetChestLed = vi.fn();
    const onSetMode = vi.fn();
    const onDartSubcmd = vi.fn();

    // Armed but NOT homed -> Fire Dart MUST stay disabled!
    const { rerender } = render(
      <TelemetryHud
        {...baseProps}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.DART_ARMED | TelemetryFlag.SENSOR_OK })}
        onDrive={onDrive}
        onHead={onHead}
        onSynth={onSynth}
        onSetChestLed={onSetChestLed}
        onSetMode={onSetMode}
        onDartSubcmd={onDartSubcmd}
      />
    );
    expect((screen.getByRole("button", { name: /Fire Dart/i }) as HTMLButtonElement).disabled).toBe(true);

    // Armed AND Homed -> Fire Dart enabled + all live badges rendered!
    rerender(
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
        onDrive={onDrive}
        onHead={onHead}
        onSynth={onSynth}
        onSetChestLed={onSetChestLed}
        onSetMode={onSetMode}
        onDartSubcmd={onDartSubcmd}
      />
    );
    expect(screen.getByText("PICKED UP")).toBeTruthy();
    expect(screen.getByText("BUMP")).toBeTruthy();
    expect(screen.getByText("TAP/BTN")).toBeTruthy();
    expect(screen.getByText("SYNTH ON")).toBeTruthy();
    expect(screen.getByText(/Color: Green/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Home Head/i }));
    expect(onHead).toHaveBeenCalledWith(HEAD_HOME_SENTINEL, 30);

    fireEvent.click(screen.getByRole("button", { name: /Fire Dart/i }));
    expect(onDartSubcmd).toHaveBeenCalledWith(DartSubcmd.FIRE);

    fireEvent.click(screen.getByRole("button", { name: /Happy Chirp/i }));
    expect(onSynth).toHaveBeenCalledWith(0, 2, 0);

    fireEvent.click(screen.getByRole("button", { name: /Chest: Red/i }));
    expect(onSetChestLed).toHaveBeenCalledWith(ChestLedState.RED);

    fireEvent.click(screen.getByRole("button", { name: /Forward/i }));
    expect(onDrive).toHaveBeenCalledWith(45, 45, 400);

    fireEvent.click(screen.getByRole("button", { name: /1: Room Explorer/i }));
    expect(onSetMode).toHaveBeenCalledWith(1);
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

describe("App shell", () => {
  it("shows Web Bluetooth warning when navigator.bluetooth is absent and unmounts cleanly under StrictMode", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { unmount } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    expect(screen.getByText(/Web Bluetooth Not Available/i)).toBeTruthy();
    unmount();
  });
});
