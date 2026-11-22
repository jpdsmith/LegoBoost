// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
// Comprehensive Component & Navigation Tests for Vernie Pilot PWA.

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChestLedState,
  DartSubcmd,
  HEAD_HOME_SENTINEL,
  TelemetryFlag,
  TelemetryFrame,
} from "@core/ble/protocol";
import { App } from "./App";
import { DriveStation } from "./components/DriveStation";
import { EyesVoiceStation } from "./components/EyesVoiceStation";
import { MusicLightStation } from "./components/MusicLightStation";
import { RoutinesStation } from "./components/RoutinesStation";
import { SetupStation } from "./components/SetupStation";
import { mixArcadeToTank } from "./utils/driveMath";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function sampleTelemetry(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    batteryMv: 8250,
    distancePct: 55,
    colorId: 5,
    pitchDeg: 0,
    rollDeg: 0,
    flags: TelemetryFlag.SENSOR_OK,
    modeId: 4,
    encA: 0,
    encB: 0,
    headDeg: 0,
    speedA: 0,
    speedB: 0,
    seq: 1,
    ...overrides,
  };
}

describe("DriveStation joystick, speed presets, C2 head lock & flip-cover dart", () => {
  it("mixArcadeToTank normalizes arcade stick into tank speeds", () => {
    expect(mixArcadeToTank(0.05, 0.05, 65)).toEqual({ left: 0, right: 0 });
    expect(mixArcadeToTank(0, 1, 65)).toEqual({ left: 65, right: 65 });
    expect(mixArcadeToTank(1, 0, 60)).toEqual({ left: 60, right: -60 });
  });

  it("enforces unhomed head lock, 3-condition flip-cover dart interlock, and Spacebar STOP in Safe Mode", () => {
    const onDrive = vi.fn();
    const onHead = vi.fn();
    const onDartSubcmd = vi.fn();

    const baseProps = {
      connected: true,
      disabled: false,
      hubRgb: [0, 168, 232] as [number, number, number],
      chestLedState: ChestLedState.OFF,
      homingInProgress: false,
      dartFiredAt: 0,
      onDrive,
      onHead,
      onDartSubcmd,
      onSetMode: vi.fn(),
      onSynth: vi.fn(),
    };

    // Unhomed -> head poses disabled, dart cover closed
    const { rerender } = render(
      <DriveStation {...baseProps} telemetry={sampleTelemetry({ flags: TelemetryFlag.SENSOR_OK })} />
    );
    expect((screen.getByRole("button", { name: /Curious/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Calibrate Head/i }));
    expect(onHead).toHaveBeenCalledWith(HEAD_HOME_SENTINEL, 30);

    // Lift Safety Cover sends ARM
    fireEvent.click(screen.getByRole("button", { name: /Lift Safety Cover to Arm/i }));
    expect(onDartSubcmd).toHaveBeenCalledWith(DartSubcmd.ARM);

    // Armed + Unhomed -> FIRE button stays locked!
    rerender(
      <DriveStation
        {...baseProps}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.DART_ARMED })}
      />
    );
    expect((screen.getByRole("button", { name: /FIRE DART/i }) as HTMLButtonElement).disabled).toBe(true);

    // Armed + Homed + Picked Up -> FIRE STILL locked!
    rerender(
      <DriveStation
        {...baseProps}
        telemetry={sampleTelemetry({
          flags: TelemetryFlag.DART_ARMED | TelemetryFlag.HEAD_HOMED | TelemetryFlag.PICKED_UP,
        })}
      />
    );
    expect((screen.getByRole("button", { name: /FIRE DART/i }) as HTMLButtonElement).disabled).toBe(true);

    // Armed + Homed + Upright -> FIRE unlocked!
    rerender(
      <DriveStation
        {...baseProps}
        telemetry={sampleTelemetry({
          flags: TelemetryFlag.DART_ARMED | TelemetryFlag.HEAD_HOMED,
        })}
      />
    );
    const fireBtn = screen.getByRole("button", { name: /FIRE DART/i }) as HTMLButtonElement;
    expect(fireBtn.disabled).toBe(false);
    fireEvent.click(fireBtn);
    expect(onDartSubcmd).toHaveBeenCalledWith(DartSubcmd.FIRE);

    // Safe Mode disabled state still honors Spacebar urgent STOP
    rerender(
      <DriveStation
        {...baseProps}
        disabled={true}
        telemetry={sampleTelemetry({ flags: TelemetryFlag.SAFE_MODE })}
      />
    );
    onDrive.mockClear();
    fireEvent.keyDown(window, { code: "Space" });
    expect(onDrive).toHaveBeenCalledWith(0, 0, 200);
  });
});

describe("MusicLightStation authentic piano, soundboard & LED studio", () => {
  it("plays piano notes, soundboard pads, Hub RGB, and Chest LED modes", () => {
    const onSynth = vi.fn();
    const onSetHubLed = vi.fn();
    const onSetChestLed = vi.fn();

    render(
      <MusicLightStation
        connected={true}
        disabled={false}
        synthActive={true}
        hubRgb={[0, 168, 232]}
        chestLedState={ChestLedState.OFF}
        onSynth={onSynth}
        onSetHubLed={onSetHubLed}
        onSetChestLed={onSetChestLed}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^Head$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Long$/i }));
    fireEvent.pointerDown(screen.getByRole("button", { name: /C5 \(MIDI 72\)/i }));
    expect(onSynth).toHaveBeenCalledWith(2, 72, 500);

    fireEvent.click(screen.getByRole("button", { name: /Happy Chirp/i }));
    expect(onSynth).toHaveBeenCalledWith(2, 2, 0);

    fireEvent.click(screen.getByRole("button", { name: /Silence/i }));
    expect(onSynth).toHaveBeenCalledWith(0, 0, 0);

    fireEvent.click(screen.getByRole("button", { name: /Vernie Orange/i }));
    expect(onSetHubLed).toHaveBeenCalledWith(255, 122, 0);

    fireEvent.click(screen.getByRole("button", { name: /Red Light/i }));
    expect(onSetChestLed).toHaveBeenCalledWith(ChestLedState.RED);
  });
});

describe("RoutinesStation personalities & LEGO-style visual routine builder", () => {
  it("switches personalities, builds/reorders blocks, and saves to robot memory", async () => {
    const onSetMode = vi.fn();
    const onUploadMacro = vi.fn().mockResolvedValue(undefined);
    render(
      <RoutinesStation
        connected={true}
        disabled={false}
        activeModeId={4}
        activeMacroStepIndex={null}
        onSetMode={onSetMode}
        onUploadMacro={onUploadMacro}
        onPlayMacro={vi.fn().mockResolvedValue(undefined)}
        onStopMacro={vi.fn().mockResolvedValue(undefined)}
        onClearMacro={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Room Explorer/i }));
    expect(onSetMode).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: /Start Blank/i }));
    fireEvent.click(screen.getByRole("button", { name: /\+ Add Block/i }));
    expect(screen.getByText(/Drive forward at 50%/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save to Yellow Brick/i }));
    await waitFor(() => {
      expect(onUploadMacro).toHaveBeenCalledWith(expect.any(Array), { saveToFlash: true });
      expect(screen.getByText(/Saved 1 blocks/i)).toBeTruthy();
    });
  });
});

describe("EyesVoiceStation vision guard & voice dart safety", () => {
  it("blocks head-follow when unhomed and permanently refuses voice dart commands", () => {
    const onHead = vi.fn();
    const onDrive = vi.fn();
    const onSynth = vi.fn();
    render(
      <EyesVoiceStation
        connected={true}
        disabled={false}
        safeMode={false}
        headHomed={false}
        headDeg={0}
        pickedUp={false}
        distancePct={70}
        onDrive={onDrive}
        onHead={onHead}
        onSynth={onSynth}
        onSetHubLed={vi.fn()}
        onSetMode={vi.fn()}
        onPlayMacro={vi.fn().mockResolvedValue(undefined)}
        onStopMacro={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Target Right/i }));
    expect(onHead).not.toHaveBeenCalled();

    const input = screen.getByLabelText(/Voice or text command/i);
    fireEvent.change(input, { target: { value: "fire the dart" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));
    expect(screen.getByText(/dart-refused/i)).toBeTruthy();
  });
});

describe("SetupStation wireless updater validation", () => {
  it("rejects invalid custom .bin upload with clear error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { container } = render(
      <SetupStation
        bleSupported={true}
        connectionState="disconnected"
        telemetry={null}
        rxHz={0}
        onRebootToBootloader={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File([new Uint8Array([1, 2, 3, 4])], "broken.bin");
    Object.defineProperty(badFile, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    fireEvent.change(input, { target: { files: [badFile] } });

    await waitFor(() => {
      expect(screen.getByText(/failed Move Hub 108,544-byte zero-sum verification/i)).toBeTruthy();
    });
  });
});

describe("App shell 5-station navigation & zero Demo Mode", () => {
  it("renders cleanly without any Demo Mode buttons, navigates all 5 stations, and unmounts cleanly", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { unmount } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );

    expect(screen.getByRole("heading", { level: 1, name: /Vernie Pilot/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Demo/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Music & Lights/i }));
    expect(screen.getByText(/Singing-Motor Piano/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Routines/i }));
    expect(screen.getByText(/Routine Builder/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /FPV Rover/i }));
    expect(screen.getByText(/Automatic Wi-Fi Discovery · No IP Address Needed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Demo/i })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Setup/i }));
    expect(screen.getByText(/Wireless Firmware Setup/i)).toBeTruthy();

    unmount();
  });
});
