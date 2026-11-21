// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// Layer 4 React UI Component Tests for TelemetryHud, FirmwareUpdater, and App.

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { TelemetryFlag, TelemetryFrame } from "../ble/protocol";
import { FirmwareUpdater } from "./FirmwareUpdater";
import { TelemetryHud } from "./TelemetryHud";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function sampleTelemetry(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    batteryMv: 8120,
    distancePct: 255,
    colorId: 0,
    pitchDeg: 0,
    rollDeg: 0,
    flags: 0,
    modeId: 4,
    encA: 0,
    encB: 0,
    headDeg: 0,
    speedA: 0,
    speedB: 0,
    seq: 7,
    ...overrides,
  };
}

describe("TelemetryHud UI safety & diagnostics", () => {
  const baseProps = {
    bleSupported: true,
    connectionState: "connected" as const,
    deviceName: "VernieOS",
    telemetry: null,
    rxHz: 10.0,
    error: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onSetHubLed: vi.fn(),
    onSetMode: vi.fn(),
    onDartSubcmd: vi.fn(),
  };

  it("keeps Mode and Arm controls disabled until first telemetry confirms !safeMode", () => {
    render(<TelemetryHud {...baseProps} telemetry={null} />);
    const armBtn = screen.getByRole("button", { name: /^Arm Lock/i }) as HTMLButtonElement;
    const modeBtn = screen.getByRole("button", { name: /1: Room Explorer/i }) as HTMLButtonElement;
    expect(armBtn.disabled).toBe(true);
    expect(modeBtn.disabled).toBe(true);
  });

  it("shows Watchdog Safe Mode warning banner and locks out motion/arm controls when SAFE_MODE flag is set", () => {
    render(
      <TelemetryHud
        {...baseProps}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.SAFE_MODE, batteryMv: 7650 })}
      />
    );
    expect(screen.getByText(/Watchdog Safe Mode Active/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Arm Lock/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Disarm Lock/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/7650 mV/i)).toBeTruthy();
  });

  it("enables Mode/Arm smoke tests when connected with healthy telemetry", () => {
    const onSetMode = vi.fn();
    render(
      <TelemetryHud
        {...baseProps}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.TAP | TelemetryFlag.DART_ARMED })}
        onSetMode={onSetMode}
      />
    );
    expect(screen.getByText("PRESSED")).toBeTruthy();
    expect(screen.getByText("ARMED")).toBeTruthy();
    const modeBtn = screen.getByRole("button", { name: /1: Room Explorer/i }) as HTMLButtonElement;
    expect(modeBtn.disabled).toBe(false);
    fireEvent.click(modeBtn);
    expect(onSetMode).toHaveBeenCalledWith(1);
  });
});

describe("FirmwareUpdater Chromebook UX & pre-flash safety", () => {
  it("handles Step 1 reboot cleanly and displays Step 2 hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false })
    );
    const onReboot = vi.fn().mockResolvedValue(undefined);
    render(
      <FirmwareUpdater
        bleSupported={true}
        connectionState="connected"
        onRebootToBootloader={onReboot}
      />
    );

    const btn = screen.getByRole("button", { name: /Send Software Reboot/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText(/Reboot command sent/i)).toBeTruthy();
    });
    expect(onReboot).toHaveBeenCalledTimes(1);
    // Download firmware.zip hidden when manifest failed to load.
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
