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
  encodeMacroSteps,
  encodeSetMode,
  encodeSynth,
  L1_CMD_REBOOT_TO_UPDATE_MODE,
  L1_EVENT_WRITE_APP_DATA,
  MacroStepOp,
  MacroSubcmd,
  splitMacroIntoChunks,
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

  it("Second-review regression: rebootToBootloader rejects if BLE drops BEFORE [0x05] starts writing, and sends Phase 2 synth/chest commands", async () => {
    const writes: number[][] = [];
    let releaseFirstWrite!: () => void;
    const mockChar: BleCharacteristicLike = {
      writeValueWithResponse: async (buf) => {
        const u8 = toBytes(buf);
        writes.push(Array.from(u8));
        if (writes.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
      },
      startNotifications: async () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const client = new VernieClient();
    await client.attachCharacteristic(mockChar, "VernieOS");

    // Start a slow write, queue reboot behind it, then disconnect BEFORE [0x05] starts!
    const p1 = client.sendSynth(1, 69, 250);
    const pReboot = client.rebootToBootloader();
    client.disconnect();
    releaseFirstWrite();

    await expect(p1).resolves.toBeUndefined();
    await expect(pReboot).rejects.toThrow(/BLE disconnected/i);

    // Reconnect and verify sendChestLed wraps exact AppData bytes
    writes.length = 0;
    const fastChar: BleCharacteristicLike = {
      writeValueWithResponse: async (buf) => {
        writes.push(Array.from(toBytes(buf)));
      },
      startNotifications: async () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    await client.attachCharacteristic(fastChar, "VernieOS");
    await client.sendChestLed(ChestLedState.BLUE);
    expect(writes[0]).toEqual([0x07, 0x00, 0x00, 0x05, 0x01, 0x03, 0x00, 0x00]);
  });

  it("Phase 3: encodes 5-byte macro steps, chunks <=14B, and uploads CLEAR -> WRITE_CHUNK -> SAVE -> PLAY in strict order", async () => {
    const writes: number[][] = [];
    const mockChar: BleCharacteristicLike = {
      writeValueWithResponse: async (buf) => {
        const u8 = toBytes(buf);
        expect(u8.length).toBeLessThanOrEqual(20); // BlueNRG-MS ATT_MTU=23 ceiling!
        writes.push(Array.from(u8));
      },
      startNotifications: async () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const client = new VernieClient();
    await client.attachCharacteristic(mockChar, "VernieOS");

    // 3 steps = 15 bytes -> splits into 10B chunk @ offset 0 and 5B chunk @ offset 10
    const steps = [
      { op: MacroStepOp.DRIVE, arg0: 50, arg1: -50, durMs: 400 },
      { op: MacroStepOp.HEAD, arg0: 99, arg1: 70, durMs: 300 }, // clamps +99 -> +35
      { op: MacroStepOp.SYNTH, arg0: 1, arg1: 7, durMs: 5000 }, // clamps 5000 -> 3000 thermal cap
    ];
    const encoded = encodeMacroSteps(steps);
    expect(encoded.length).toBe(15);
    expect(Array.from(encoded)).toEqual([
      1, 50, 206, 0x90, 0x01, // DRIVE(50, -50, 400ms)
      2, 35, 70, 0x2c, 0x01,  // HEAD(clamped +35, 70%, 300ms)
      3, 1, 7, 0xb8, 0x0b,    // SYNTH(v1, preset 7, clamped 3000ms)
    ]);

    expect(() => encodeMacroSteps([{ op: 99, arg0: 0, arg1: 0, durMs: 100 }])).toThrow(RangeError);
    expect(() =>
      encodeMacroSteps(Array.from({ length: 47 }, () => ({ op: MacroStepOp.WAIT, arg0: 0, arg1: 0, durMs: 100 })))
    ).toThrow(RangeError);

    const chunks = splitMacroIntoChunks(encoded, 10);
    expect(chunks.map((c) => [c.offset, c.data.length])).toEqual([
      [0, 10],
      [10, 5],
    ]);

    await client.uploadMacro(steps, { saveToFlash: true, playAfter: true });
    // Expected writes: CLEAR, CHUNK@0 (10B), CHUNK@10 (5B), SAVE, PLAY
    expect(writes).toEqual([
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.CLEAR, 0],
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.WRITE_CHUNK, 0, ...Array.from(encoded.slice(0, 10))],
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.WRITE_CHUNK, 10, ...Array.from(encoded.slice(10, 15))],
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.SAVE, 0],
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.PLAY, 0],
    ]);

    writes.length = 0;
    await client.stopMacro();
    await client.clearMacro(true);
    expect(writes).toEqual([
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.STOP, 0],
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.CLEAR, 0],
      [0x07, 0x00, 0x00, 0x07, MacroSubcmd.SAVE, 0],
    ]);

    // Invalid chest LED state in macro & out-of-bounds chunk offset must throw RangeError
    expect(() =>
      encodeMacroSteps([{ op: MacroStepOp.LED, arg0: 1, arg1: 7, durMs: 100 }])
    ).toThrow(RangeError);
    expect(() => encodeMacroChunk(MacroSubcmd.WRITE_CHUNK, 225, new Uint8Array(10))).toThrow(RangeError);
  });

  it("I6 regressions: urgent STOP jumps ahead of FIFO/slider flood, concurrent uploads serialize, and mid-startNotifications disconnect avoids zombie state", async () => {
    const writes: number[][] = [];
    const mockChar: BleCharacteristicLike = {
      writeValueWithResponse: async (buf) => {
        await new Promise((r) => setTimeout(r, 10));
        writes.push(Array.from(toBytes(buf)));
      },
      startNotifications: async () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const client = new VernieClient();
    await client.attachCharacteristic(mockChar, "VernieOS");

    // Queue 4 slow FIFO writes + rapid coalesced head slider drags, then trigger emergency STOP!
    const pFifo = [
      client.sendHubLed(1, 2, 3),
      client.sendHubLed(4, 5, 6),
      client.sendHubLed(7, 8, 9),
      client.sendHubLed(10, 11, 12),
    ];
    for (let deg = -35; deg <= 35; deg += 5) {
      void client.sendHead(deg, 50, { coalesce: true });
    }
    client.sendDrive(0, 0, 200); // Urgent STOP!

    await Promise.all(pFifo);
    await new Promise((r) => setTimeout(r, 30));

    // Write #0 was already in-flight; write #1 MUST be emergency STOP (0x01 0 0)!
    const stopIdx = writes.findIndex((w) => w[3] === 0x01 && w[4] === 0 && w[5] === 0);
    expect(stopIdx).toBe(1);
    // Rapid 15 slider moves MUST have coalesced down to at most 1 head write!
    const headWrites = writes.filter((w) => w[3] === 0x02);
    expect(headWrites.length).toBeLessThanOrEqual(1);

    // Concurrent uploadMacro calls MUST serialize strictly (CLEAR..SAVE, then CLEAR..PLAY) without interleaving!
    writes.length = 0;
    const s1 = [{ op: MacroStepOp.WAIT, arg0: 0, arg1: 0, durMs: 100 }];
    const s2 = [{ op: MacroStepOp.WAIT, arg0: 0, arg1: 0, durMs: 200 }];
    await Promise.all([
      client.uploadMacro(s1, { saveToFlash: true }),
      client.uploadMacro(s2, { playAfter: true }),
    ]);
    const subcmds = writes.map((w) => w[4]);
    expect(subcmds).toEqual([
      MacroSubcmd.CLEAR,
      MacroSubcmd.WRITE_CHUNK,
      MacroSubcmd.SAVE,
      MacroSubcmd.CLEAR,
      MacroSubcmd.WRITE_CHUNK,
      MacroSubcmd.PLAY,
    ]);

    // Disconnect firing mid-startNotifications MUST NOT transition to zombie "connected" state!
    client.disconnect();
    let resolveNotif!: () => void;
    let disconnectCb: (() => void) | undefined;
    const fakeChar: BleCharacteristicLike = {
      writeValueWithResponse: async () => {},
      startNotifications: () =>
        new Promise<void>((resolve) => {
          resolveNotif = resolve;
        }),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const fakeDevice = {
      name: "VernieOS",
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === "gattserverdisconnected") disconnectCb = fn;
      },
      removeEventListener: vi.fn(),
      gatt: {
        connected: true,
        connect: async () => ({
          getPrimaryService: async () => ({
            getCharacteristic: async () => fakeChar,
          }),
        }),
        disconnect: vi.fn(),
      },
    };
    vi.stubGlobal("navigator", {
      bluetooth: {
        requestDevice: vi.fn().mockResolvedValue(fakeDevice),
      },
    });

    const pConn = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(disconnectCb).toBeDefined();
    disconnectCb!(); // Unexpected BLE drop while awaiting startNotifications()!
    resolveNotif();
    await pConn;
    expect(client.getState()).toBe("disconnected");
  });
});
