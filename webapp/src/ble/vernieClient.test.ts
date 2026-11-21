// SPDX-License-Identifier: MIT
// Layer 4 Tests (T4.1 & T4.2): C <-> TS golden parity, boundary safety, coalescing error resilience,
// STM32 0x05 reboot disconnect semantics, and connect/disconnect concurrency races.

import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "../../../tools/protocol_schema.json";
import {
  buildRebootToUpdateModeCommand,
  ChestLedState,
  DartSubcmd,
  decodeTelemetry,
  encodeChestLed,
  encodeDart,
  encodeDrive,
  encodeHead,
  encodeHubLed,
  encodeMacroChunk,
  encodeSetMode,
  encodeSynth,
  L1_CMD_REBOOT_TO_UPDATE_MODE,
  L1_EVENT_WRITE_APP_DATA,
  unwrapPybricksEventNotification,
  wrapPybricksAppData,
} from "./protocol";
import { BleCharacteristicLike, CoalescingGattWriter, VernieClient } from "./vernieClient";

function toBytes(buf: BufferSource): Uint8Array {
  if (buf instanceof ArrayBuffer) {
    return new Uint8Array(buf);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe("Layer 4 — Protocol Golden Vector Parity & Bounds (T4.1)", () => {
  const gv = schema.golden_vectors;

  it("matches C golden vectors for all RX commands", () => {
    expect(Array.from(encodeDrive(-75, 100, 400))).toEqual(gv.rx_drive.bytes);
    expect(Array.from(encodeHead(-25, 60))).toEqual(gv.rx_head_angle.bytes);
    expect(Array.from(encodeHead(127, 25))).toEqual(gv.rx_head_home.bytes);
    expect(Array.from(encodeDart(1, 165))).toEqual(gv.rx_dart_arm.bytes);
    expect(Array.from(encodeSynth(1, 69, 250))).toEqual(gv.rx_synth.bytes);
    expect(Array.from(encodeHubLed(16, 200, 255))).toEqual(gv.rx_led_hub.bytes);
    expect(Array.from(encodeSetMode(4))).toEqual(gv.rx_set_mode.bytes);
    expect(Array.from(encodeMacroChunk(1, 0, new Uint8Array([10, 20, 30, 40])))).toEqual(
      gv.rx_macro_chunk.bytes
    );
  });

  it("safely handles NaN, +/-Infinity, enum checks, and exact 18B/19B telemetry subarrays", () => {
    // NaN/Infinity must never produce invalid 0ms timeout or NaN bytes.
    const nanDrive = encodeDrive(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    const dv = new DataView(nanDrive.buffer);
    expect(dv.getInt8(1)).toBe(0);
    expect(dv.getInt8(2)).toBe(100);
    expect(dv.getUint16(3, true)).toBe(400);

    const negInfDrive = encodeDrive(Number.NEGATIVE_INFINITY, -200, Number.NEGATIVE_INFINITY);
    const dv2 = new DataView(negInfDrive.buffer);
    expect(dv2.getInt8(1)).toBe(-100);
    expect(dv2.getInt8(2)).toBe(-100);
    expect(dv2.getUint16(3, true)).toBe(100);

    // Valid & invalid enum checks
    expect(Array.from(encodeChestLed(ChestLedState.RED))).toEqual([5, 1, 9, 0, 0]);
    expect(() => encodeChestLed(7)).toThrow(RangeError);
    expect(() => encodeDart(9)).toThrow(RangeError);

    // Non-zero byteOffset subarray decoding
    const backing = new Uint8Array(30);
    backing[3] = L1_EVENT_WRITE_APP_DATA;
    backing.set(gv.tx_telemetry.bytes, 4);
    const sliced = backing.subarray(3, 3 + 19);
    const parsed = unwrapPybricksEventNotification(sliced);
    expect(parsed?.batteryMv).toBe(gv.tx_telemetry.fields.battery_mv);
    expect(parsed?.encA).toBe(gv.tx_telemetry.fields.enc_a);

    // Pybricks L1 status report (0x00) and wrong-length telemetry must return null.
    expect(unwrapPybricksEventNotification(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(decodeTelemetry(new Uint8Array([0x80, ...new Array(16).fill(0)]))).toBeNull();
    expect(decodeTelemetry(new Uint8Array([0x80, ...new Array(18).fill(0)]))).toBeNull();
  });

  it("enforces 17-byte RX AppData envelope ceiling & direct L1 reboot opcode", () => {
    const maxPayload = new Uint8Array(17);
    const wrapped = wrapPybricksAppData(maxPayload);
    expect(wrapped.length).toBe(20);
    expect(wrapped[0]).toBe(0x07);
    expect(() => wrapPybricksAppData(new Uint8Array(18))).toThrow(RangeError);
    expect(() => wrapPybricksAppData(new Uint8Array(0))).toThrow(RangeError);
    expect(Array.from(buildRebootToUpdateModeCommand())).toEqual([L1_CMD_REBOOT_TO_UPDATE_MODE]);
  });
});

describe("Layer 4 — Coalescing GATT Scheduler & VernieClient Resilience (T4.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps strictly 1 write in flight, drops stale joystick frames, and always delivers final STOP", async () => {
    let activeWrites = 0;
    let maxConcurrent = 0;
    const delivered: number[][] = [];

    const writer = new CoalescingGattWriter(async (bytes) => {
      activeWrites += 1;
      maxConcurrent = Math.max(maxConcurrent, activeWrites);
      await new Promise((r) => setTimeout(r, 15));
      delivered.push(Array.from(bytes));
      activeWrites -= 1;
    });

    for (let spd = 5; spd <= 100; spd += 5) {
      writer.enqueueCoalesced(wrapPybricksAppData(encodeDrive(spd, spd, 400)));
    }
    const finalStop = wrapPybricksAppData(encodeDrive(0, 0, 400));
    writer.enqueueCoalesced(finalStop);

    await new Promise((r) => setTimeout(r, 80));

    expect(maxConcurrent).toBe(1);
    expect(delivered.length).toBeLessThanOrEqual(3);
    expect(delivered[delivered.length - 1]).toEqual(Array.from(finalStop));
  });

  it("C4 regression: failed coalesced write reports onError and does NOT strand queued FIFO writes", async () => {
    const errors: string[] = [];
    const delivered: number[][] = [];
    let failFirst = true;

    const writer = new CoalescingGattWriter(
      async (bytes) => {
        await new Promise((r) => setTimeout(r, 5));
        if (failFirst) {
          failFirst = false;
          throw new Error("Simulated Watchdog Safe Mode rejection");
        }
        delivered.push(Array.from(bytes));
      },
      (err) => errors.push(err.message)
    );

    writer.enqueueCoalesced(wrapPybricksAppData(encodeDrive(50, 50, 400)));
    const disarmBytes = wrapPybricksAppData(encodeDart(DartSubcmd.DISARM));
    await writer.enqueueReliable(disarmBytes);

    expect(errors).toEqual(["Simulated Watchdog Safe Mode rejection"]);
    expect(delivered).toEqual([Array.from(disarmBytes)]);
  });

  it("C3 regression: rebootToBootloader treats STM32 mid-transaction NetworkError as expected success", async () => {
    const writes: number[][] = [];
    const listeners = new Map<string, (ev: Event) => void>();
    const mockChar: BleCharacteristicLike = {
      writeValueWithResponse: async (buf) => {
        const u8 = toBytes(buf);
        writes.push(Array.from(u8));
        if (u8.length === 1 && u8[0] === 0x05) {
          // Simulates real STM32 calling NVIC_SystemReset() before sending ATT Write Response!
          const err = new Error("GATT Server is disconnected. Cannot perform GATT operations.");
          err.name = "NetworkError";
          throw err;
        }
      },
      startNotifications: async () => {},
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    };

    const received: number[] = [];
    const client = new VernieClient({
      onTelemetry: (f) => received.push(f.batteryMv),
    });

    await client.attachCharacteristic(mockChar, "VernieOS");
    expect(client.getState()).toBe("connected");

    const notifBytes = new Uint8Array([
      L1_EVENT_WRITE_APP_DATA,
      ...schema.golden_vectors.tx_telemetry.bytes,
    ]);
    listeners.get("characteristicvaluechanged")!({
      target: { value: new DataView(notifBytes.buffer) },
    } as unknown as Event);
    expect(received).toEqual([8120]);

    // Must resolve cleanly (NOT reject!) and transition to disconnected.
    await expect(client.rebootToBootloader()).resolves.toBeUndefined();
    expect(writes[writes.length - 1]).toEqual([0x05]);
    expect(client.getState()).toBe("disconnected");
  });

  it("I6 regression: disconnect() during in-flight connect() cancels cleanly without zombie state", async () => {
    let resolveConnect!: (server: unknown) => void;
    let gattConnected = false;
    const disconnectSpy = vi.fn(() => {
      gattConnected = false;
    });
    const fakeDevice = {
      name: "VernieOS",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      gatt: {
        get connected() {
          return gattConnected;
        },
        connect: () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
          }),
        disconnect: disconnectSpy,
      },
    };

    vi.stubGlobal("navigator", {
      bluetooth: {
        requestDevice: vi.fn().mockResolvedValue(fakeDevice),
      },
    });

    const states: string[] = [];
    const client = new VernieClient({ onStateChange: (s) => states.push(s) });

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 0));
    expect(client.getState()).toBe("connecting");

    // Concurrent connect() while connecting must reject immediately.
    await expect(client.connect()).rejects.toThrow(/Already connecting/i);

    // User cancels mid-connect.
    client.disconnect();
    expect(client.getState()).toBe("disconnected");

    // Now the late gatt.connect() resolves -> client MUST disconnect it and stay disconnected!
    gattConnected = true;
    resolveConnect({
      getPrimaryService: vi.fn(),
    });
    await connectPromise;

    expect(disconnectSpy).toHaveBeenCalled();
    expect(client.getState()).toBe("disconnected");
  });
});
