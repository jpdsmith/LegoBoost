// SPDX-License-Identifier: MIT
// Layer 4 Tests (T4.3): Simulated LWP3 Move Hub bootloader flashing, XOR checksum & error validation.

import { describe, expect, it, vi } from "vitest";
import {
  BootloaderCmd,
  BootloaderGattCharLike,
  BootloaderMessageKind,
  computeBootloaderXorChecksum,
  flashMoveHubViaWebBluetooth,
  flashOverBootloaderChar,
  MOVE_HUB_CHECKSUM_SIZE,
  MOVE_HUB_DEVICE_ID,
  MOVE_HUB_MAX_FIRMWARE_BYTES,
  verifyMoveHubZeroSum,
} from "./lwp3Flasher";

function toBytes(buf: BufferSource): Uint8Array {
  if (buf instanceof ArrayBuffer) {
    return new Uint8Array(buf);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function makeValidMoveHubFirmware(baseWords = 48): Uint8Array {
  const baseLen = baseWords * 4;
  const buf = new Uint8Array(baseLen + 4);
  const view = new DataView(buf.buffer);
  let sum = 0;
  for (let i = 0; i < baseLen; i += 4) {
    const word = ((i + 1) * 0x01020304) >>> 0;
    view.setUint32(i, word, true);
    sum = (sum + word) >>> 0;
  }
  const remainingWords = (MOVE_HUB_CHECKSUM_SIZE - 4 - baseLen) / 4;
  sum = (sum - remainingWords) >>> 0;
  const complement = (0x100000000 - sum) >>> 0;
  view.setUint32(baseLen, complement, true);
  return buf;
}

function createMockBootloader(opts?: {
  typeId?: number;
  endAddr?: number;
  eraseStatus?: number;
  eraseWriteError?: Error;
  initStatus?: number;
  simulateWindowsLateEraseReply?: boolean;
  corruptIncrementalChecksum?: boolean;
  corruptFinalChecksum?: boolean;
  corruptFinalCount?: number;
  truncateFinalReply?: boolean;
  sendEmptyNotificationOnInfo?: boolean;
  sendErrorFrameOnInit?: boolean;
  hangOnErase?: boolean;
}) {
  const typeId = opts?.typeId ?? MOVE_HUB_DEVICE_ID;
  const endAddr = opts?.endAddr ?? 0x0801f000;
  let listener: ((ev: Event) => void) | null = null;
  let expectedTotal = 0;
  let runningXor = 0xff;
  const writtenBytes: number[] = [];
  const log: Array<{ cmd: number; len: number; withResp: boolean }> = [];
  let pendingLateErase = false;

  const emit = (bytes: Uint8Array) => {
    const copy = new Uint8Array(bytes);
    queueMicrotask(() => {
      listener?.({ target: { value: new DataView(copy.buffer) } } as unknown as Event);
    });
  };

  const handleWrite = (raw: Uint8Array, withResp: boolean) => {
    const cmd = raw[0];
    log.push({ cmd, len: raw.length, withResp });

    if (cmd === BootloaderCmd.GET_INFO) {
      if (opts?.sendEmptyNotificationOnInfo) {
        emit(new Uint8Array(0));
        return;
      }
      const reply = new Uint8Array(14);
      const v = new DataView(reply.buffer);
      reply[0] = BootloaderCmd.GET_INFO;
      v.setInt32(1, 0x01000000, true);
      v.setUint32(5, 0x08005000, true);
      v.setUint32(9, endAddr, true);
      reply[13] = typeId;
      emit(reply);
    } else if (cmd === BootloaderCmd.ERASE_FLASH) {
      if (opts?.eraseWriteError) {
        throw opts.eraseWriteError;
      }
      if (opts?.hangOnErase) {
        return;
      }
      if (opts?.simulateWindowsLateEraseReply) {
        pendingLateErase = true;
      } else {
        emit(new Uint8Array([BootloaderCmd.ERASE_FLASH, opts?.eraseStatus ?? 0x00]));
      }
    } else if (cmd === BootloaderCmd.INIT_LOADER) {
      expectedTotal = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1, true);
      runningXor = 0xff;
      if (pendingLateErase) {
        pendingLateErase = false;
        emit(new Uint8Array([BootloaderCmd.ERASE_FLASH, 0x00]));
      }
      if (opts?.sendErrorFrameOnInit) {
        emit(new Uint8Array([BootloaderMessageKind.ERROR, 0x05]));
      } else {
        emit(new Uint8Array([BootloaderCmd.INIT_LOADER, opts?.initStatus ?? 0x00]));
      }
    } else if (cmd === BootloaderCmd.GET_CHECKSUM) {
      const csum = opts?.corruptIncrementalChecksum ? runningXor ^ 0x01 : runningXor;
      emit(new Uint8Array([BootloaderCmd.GET_CHECKSUM, csum]));
    } else if (cmd === BootloaderCmd.PROGRAM_FLASH) {
      const fieldLen = raw[1];
      const payload = raw.subarray(6);
      expect(fieldLen).toBe(payload.length + 4);
      expect(payload.length).toBeLessThanOrEqual(14);
      expect(raw.length).toBeLessThanOrEqual(20);
      for (const b of payload) {
        writtenBytes.push(b);
        runningXor ^= b;
      }
      if (writtenBytes.length === expectedTotal) {
        if (opts?.truncateFinalReply) {
          emit(new Uint8Array([BootloaderCmd.PROGRAM_FLASH, runningXor]));
          return;
        }
        const reply = new Uint8Array(6);
        reply[0] = BootloaderCmd.PROGRAM_FLASH;
        reply[1] = opts?.corruptFinalChecksum ? runningXor ^ 0x55 : runningXor;
        const count = opts?.corruptFinalCount ?? writtenBytes.length;
        new DataView(reply.buffer).setUint32(2, count, true);
        emit(reply);
      }
    }
  };

  const char: BootloaderGattCharLike = {
    writeValueWithResponse: async (buf) => {
      handleWrite(toBytes(buf), true);
    },
    writeValueWithoutResponse: async (buf) => {
      handleWrite(toBytes(buf), false);
    },
    startNotifications: async () => {},
    addEventListener: (_type, fn) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
  };

  return { char, writtenBytes, log };
}

describe("Layer 4 — LWP3 Move Hub Browser Flasher (T4.3)", () => {
  it("flashes valid Move Hub firmware in <=14B chunks, verifies XOR checksums & byte count", async () => {
    const fw = makeValidMoveHubFirmware(60); // 244 bytes -> 18 chunks -> triggers GET_CHECKSUM!
    expect(verifyMoveHubZeroSum(fw)).toBe(true);

    const mock = createMockBootloader();
    const res = await flashOverBootloaderChar(mock.char, fw, undefined, {
      eraseTimeoutMs: 50,
      replyTimeoutMs: 200,
    });

    expect(res.startAddr).toBe(0x08005000);
    expect(res.bytesWritten).toBe(fw.length);
    expect(res.finalCount).toBe(fw.length);
    expect(res.finalChecksum).toBe(computeBootloaderXorChecksum(fw));
    expect(new Uint8Array(mock.writtenBytes)).toEqual(fw);

    const checksumCalls = mock.log.filter((e) => e.cmd === BootloaderCmd.GET_CHECKSUM);
    expect(checksumCalls.length).toBeGreaterThanOrEqual(1);
    expect(mock.log[mock.log.length - 1].cmd).toBe(BootloaderCmd.START_APP);
  });

  it("handles non-zero unaligned subarray byteOffset cleanly", () => {
    const fw = makeValidMoveHubFirmware(16);
    const padded = new Uint8Array(fw.length + 7);
    padded.set(fw, 3);
    const subarray = padded.subarray(3, 3 + fw.length);
    expect(subarray.byteOffset).toBe(3);
    expect(verifyMoveHubZeroSum(subarray)).toBe(true);
  });

  it("handles Windows ERASE_FLASH timeout + stray late 0x11 reply cleanly", async () => {
    const fw = makeValidMoveHubFirmware(16);
    const mock = createMockBootloader({ simulateWindowsLateEraseReply: true });
    const res = await flashOverBootloaderChar(mock.char, fw, undefined, {
      eraseTimeoutMs: 30,
      replyTimeoutMs: 200,
    });
    expect(res.bytesWritten).toBe(fw.length);
    expect(new Uint8Array(mock.writtenBytes)).toEqual(fw);
  });

  it("refuses tampered firmware and firmware exceeding 104 KiB FLASH_FIRMWARE", async () => {
    const fw = makeValidMoveHubFirmware(8);
    fw[0] ^= 0xff;
    const mock = createMockBootloader();
    await expect(flashOverBootloaderChar(mock.char, fw)).rejects.toThrow(/zero-sum/i);

    // 106,500 B (> 106,496 B FLASH_FIRMWARE, even though <= 108,544 B checksum size) -> MUST reject!
    const oversized = new Uint8Array(MOVE_HUB_MAX_FIRMWARE_BYTES + 4);
    expect(verifyMoveHubZeroSum(oversized)).toBe(false);
  });

  it("rejects wrong device ID and firmware exceeding GET_INFO endAddr", async () => {
    const fw = makeValidMoveHubFirmware(8);
    const wrongHub = createMockBootloader({ typeId: 0x41 });
    await expect(flashOverBootloaderChar(wrongHub.char, fw)).rejects.toThrow(/Wrong hub type 0x41/i);

    const tinyFlash = createMockBootloader({ endAddr: 0x08005010 });
    await expect(flashOverBootloaderChar(tinyFlash.char, fw)).rejects.toThrow(/exceeds bootloader flash range/i);
  });

  it("C5 regressions: rejects ERASE/INIT errors, non-timeout ERASE BLE errors, bad counts & bad XOR checksums", async () => {
    const fw = makeValidMoveHubFirmware(60); // triggers incremental GET_CHECKSUM

    // ERASE_FLASH status 0xFF must NOT continue!
    const badErase = createMockBootloader({ eraseStatus: 0xff });
    await expect(flashOverBootloaderChar(badErase.char, fw)).rejects.toThrow(/ERASE_FLASH failed/i);

    // BLE write error during ERASE_FLASH must NOT be swallowed by timeout workaround!
    const bleErr = createMockBootloader({ eraseWriteError: new Error("BLE link dropped") });
    await expect(flashOverBootloaderChar(bleErr.char, fw)).rejects.toThrow(/BLE link dropped/i);

    // INIT_LOADER status 0xFF
    const badInit = createMockBootloader({ initStatus: 0xff });
    await expect(flashOverBootloaderChar(badInit.char, fw)).rejects.toThrow(/INIT_LOADER failed/i);

    // Bootloader ERROR frame (0x05)
    const errFrame = createMockBootloader({ sendErrorFrameOnInit: true });
    await expect(flashOverBootloaderChar(errFrame.char, fw)).rejects.toThrow(/ERROR frame/i);

    // Empty notification does not throw TypeError
    const emptyNotif = createMockBootloader({ sendEmptyNotificationOnInfo: true });
    await expect(flashOverBootloaderChar(emptyNotif.char, fw)).rejects.toThrow(/empty bootloader notification/i);

    // Bad incremental XOR checksum -> aborts BEFORE START_APP
    const badIncXor = createMockBootloader({ corruptIncrementalChecksum: true });
    await expect(flashOverBootloaderChar(badIncXor.char, fw)).rejects.toThrow(/incremental XOR checksum mismatch/i);
    expect(badIncXor.log.some((e) => e.cmd === BootloaderCmd.START_APP)).toBe(false);

    // Bad final XOR checksum -> aborts BEFORE START_APP
    const badFinalXor = createMockBootloader({ corruptFinalChecksum: true });
    await expect(flashOverBootloaderChar(badFinalXor.char, fw)).rejects.toThrow(/final XOR checksum mismatch/i);
    expect(badFinalXor.log.some((e) => e.cmd === BootloaderCmd.START_APP)).toBe(false);

    // Bad final byte count -> aborts BEFORE START_APP
    const badCount = createMockBootloader({ corruptFinalCount: fw.length - 14 });
    await expect(flashOverBootloaderChar(badCount.char, fw)).rejects.toThrow(/byte count mismatch/i);
    expect(badCount.log.some((e) => e.cmd === BootloaderCmd.START_APP)).toBe(false);

    // Truncated final reply -> aborts BEFORE START_APP
    const truncFinal = createMockBootloader({ truncateFinalReply: true });
    await expect(flashOverBootloaderChar(truncFinal.char, fw)).rejects.toThrow(/Truncated final/i);
    expect(truncFinal.log.some((e) => e.cmd === BootloaderCmd.START_APP)).toBe(false);
  });

  it("I6 regression: aborts immediately on AbortSignal mid-flash instead of waiting for 5s timeout", async () => {
    const fw = makeValidMoveHubFirmware(8);
    const mock = createMockBootloader({ hangOnErase: true });
    const abortCtrl = new AbortController();

    const start = Date.now();
    setTimeout(() => abortCtrl.abort(new Error("Mid-flash GATT disconnect")), 25);

    await expect(
      flashOverBootloaderChar(mock.char, fw, undefined, {
        eraseTimeoutMs: 5000,
        signal: abortCtrl.signal,
      })
    ).rejects.toThrow(/Mid-flash GATT disconnect/i);

    expect(Date.now() - start).toBeLessThan(500);
  });

  it("Second-review regression: removes gattserverdisconnected listener if device.gatt.connect() throws", async () => {
    const addSpy = vi.fn();
    const removeSpy = vi.fn();
    vi.stubGlobal("navigator", {
      bluetooth: {
        requestDevice: vi.fn().mockResolvedValue({
          addEventListener: addSpy,
          removeEventListener: removeSpy,
          gatt: {
            connected: false,
            connect: vi.fn().mockRejectedValue(new Error("GATT connect failed")),
            disconnect: vi.fn(),
          },
        }),
      },
    });

    try {
      const fw = makeValidMoveHubFirmware(8);
      await expect(flashMoveHubViaWebBluetooth(fw)).rejects.toThrow(/GATT connect failed/i);
      expect(addSpy).toHaveBeenCalledWith("gattserverdisconnected", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("gattserverdisconnected", addSpy.mock.calls[0][1]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
