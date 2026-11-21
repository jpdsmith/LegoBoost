// SPDX-License-Identifier: MIT
// Direct browser LWP3 BLE Bootloader Flasher for LEGO BOOST Move Hub (0x40).
// Faithfully implements upstream Pybricks Move Hub bootloader rules:
//   - Service 00001625-... / Characteristic 00001626-...
//   - GET_INFO (0x55) verifies Move Hub type_id == 0x40 and flash endAddr capacity
//   - ERASE_FLASH (0x11) Write-Without-Response + 5s timeout-only workaround & result check
//   - INIT_LOADER (0x44) announces total firmware size & verifies BootloaderResult.OK
//   - PROGRAM_FLASH (0x22) streams <= 14-byte chunks with len = chunk.length + 4
//   - GET_CHECKSUM (0x66) throttles every 10th packet & verifies running XOR checksum (seed 0xFF)
//   - Final PROGRAM_FLASH reply verifies BOTH byte count == firmware.length AND XOR checksum
//   - START_APP (0x33) reboots into freshly flashed firmware

import { LWP3_BOOTLOADER_CHAR_UUID, LWP3_BOOTLOADER_SERVICE_UUID } from "./protocol";

export const BootloaderCmd = {
  ERASE_FLASH: 0x11,
  PROGRAM_FLASH: 0x22,
  START_APP: 0x33,
  INIT_LOADER: 0x44,
  GET_INFO: 0x55,
  GET_CHECKSUM: 0x66,
} as const;

export const BootloaderMessageKind = {
  ERROR: 0x05,
} as const;

export const BootloaderResult = {
  OK: 0x00,
  ERROR: 0xff,
} as const;

export const MOVE_HUB_DEVICE_ID = 0x40;
export const MOVE_HUB_MAX_CHUNK_BYTES = 14;
export const MOVE_HUB_MAX_FIRMWARE_BYTES = 104 * 1024; // 106,496 B (FLASH_FIRMWARE; keeps FLASH_USER_0 erased)
export const MOVE_HUB_CHECKSUM_SIZE = 108544;          // 104 KiB FLASH_FIRMWARE + 2 KiB FLASH_USER_0
export const MOVE_HUB_THROTTLE_INTERVAL = 10;

export class BootloaderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootloaderTimeoutError";
  }
}

export interface BootloaderGattCharLike {
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<unknown>;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

export interface FlashProgress {
  stage: "connecting" | "info" | "erasing" | "programming" | "rebooting" | "done";
  bytesWritten: number;
  totalBytes: number;
  percent: number;
  message: string;
}

export interface FlashResult {
  startAddr: number;
  endAddr: number;
  bytesWritten: number;
  finalChecksum: number;
  finalCount: number;
}

export function computeBootloaderXorChecksum(bytes: Uint8Array, seed = 0xff): number {
  let xor = seed & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    xor ^= bytes[i];
  }
  return xor;
}

export function verifyMoveHubZeroSum(
  firmware: Uint8Array,
  checksumSize = MOVE_HUB_CHECKSUM_SIZE,
  maxFirmwareBytes = MOVE_HUB_MAX_FIRMWARE_BYTES
): boolean {
  if (
    checksumSize <= 0 ||
    checksumSize % 4 !== 0 ||
    firmware.length < 4 ||
    firmware.length % 4 !== 0 ||
    firmware.length > maxFirmwareBytes ||
    firmware.length > checksumSize
  ) {
    return false;
  }
  const view = new DataView(firmware.buffer, firmware.byteOffset, firmware.byteLength);
  let total = 0;
  for (let i = 0; i < firmware.length; i += 4) {
    total = (total + view.getUint32(i, true)) >>> 0;
  }
  const remainingWords = (checksumSize - firmware.length) / 4;
  // Adding 0xFFFFFFFF mod 2^32 is equivalent to subtracting 1 mod 2^32.
  total = (total - remainingWords) >>> 0;
  return total === 0;
}

export async function flashOverBootloaderChar(
  char: BootloaderGattCharLike,
  firmware: Uint8Array,
  onProgress?: (p: FlashProgress) => void,
  options?: { eraseTimeoutMs?: number; replyTimeoutMs?: number; signal?: AbortSignal }
): Promise<FlashResult> {
  if (!verifyMoveHubZeroSum(firmware)) {
    throw new Error(
      "Firmware binary failed Move Hub zero-sum checksum or 104 KiB FLASH_FIRMWARE limit! Refusing to flash."
    );
  }

  const eraseTimeoutMs = options?.eraseTimeoutMs ?? 5000;
  const replyTimeoutMs = options?.replyTimeoutMs ?? 2000;
  const signal = options?.signal;

  let ignoreEraseReply = false;
  const queue: Uint8Array[] = [];
  type Waiter = {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  let pendingWaiter: Waiter | null = null;

  const clearPendingWaiter = (): void => {
    if (pendingWaiter) {
      clearTimeout(pendingWaiter.timer);
      pendingWaiter = null;
    }
  };

  const getAbortError = (): Error => {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    return new Error(typeof reason === "string" ? reason : "Flash aborted due to BLE disconnect");
  };

  const onAbort = (): void => {
    if (pendingWaiter) {
      const w = pendingWaiter;
      pendingWaiter = null;
      clearTimeout(w.timer);
      w.reject(getAbortError());
    }
  };

  const onNotify = (ev: Event): void => {
    const target = ev.target as unknown as { value?: DataView };
    if (!target?.value) return;
    const copy = new Uint8Array(target.value.byteLength);
    copy.set(
      new Uint8Array(target.value.buffer, target.value.byteOffset, target.value.byteLength)
    );
    if (pendingWaiter) {
      const w = pendingWaiter;
      pendingWaiter = null;
      clearTimeout(w.timer);
      w.resolve(copy);
    } else {
      queue.push(copy);
    }
  };

  const waitForReply = (timeoutMs: number): Promise<Uint8Array> => {
    if (signal?.aborted) {
      return Promise.reject(getAbortError());
    }
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingWaiter = null;
        reject(new BootloaderTimeoutError(`Bootloader reply timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pendingWaiter = { resolve, reject, timer };
    });
  };

  const request = async (
    cmd: number,
    payload: Uint8Array | null,
    opts: { withResponse: boolean; expectReply: boolean; timeoutMs?: number }
  ): Promise<Uint8Array | null> => {
    if (signal?.aborted) {
      throw getAbortError();
    }
    const packet = new Uint8Array(1 + (payload ? payload.length : 0));
    packet[0] = cmd;
    if (payload) packet.set(payload, 1);

    if (opts.withResponse) {
      await char.writeValueWithResponse(packet as BufferSource);
    } else {
      await char.writeValueWithoutResponse(packet as BufferSource);
    }

    if (!opts.expectReply) {
      return null;
    }

    let reply = await waitForReply(opts.timeoutMs ?? replyTimeoutMs);
    if (reply.length === 0) {
      throw new Error("Received empty bootloader notification");
    }
    // Windows / buggy BLE stack workaround: discard stray late ERASE_FLASH reply.
    if (ignoreEraseReply && reply[0] === BootloaderCmd.ERASE_FLASH) {
      ignoreEraseReply = false;
      reply = await waitForReply(opts.timeoutMs ?? replyTimeoutMs);
      if (reply.length === 0) {
        throw new Error("Received empty bootloader notification");
      }
    }
    if (reply[0] === BootloaderMessageKind.ERROR) {
      const code = reply.length >= 2 ? `0x${reply[1].toString(16)}` : "unknown";
      throw new Error(`Bootloader reported ERROR frame (code ${code}) in response to 0x${cmd.toString(16)}`);
    }
    if (reply[0] !== cmd) {
      throw new Error(
        `Bootloader protocol mismatch: expected reply 0x${cmd.toString(16)}, got 0x${reply[0].toString(16)}`
      );
    }
    return reply;
  };

  if (signal) {
    if (signal.aborted) {
      throw getAbortError();
    }
    signal.addEventListener("abort", onAbort);
  }
  char.addEventListener("characteristicvaluechanged", onNotify);

  try {
    await char.startNotifications();

    // 1. GET_INFO (0x55)
    onProgress?.({
      stage: "info",
      bytesWritten: 0,
      totalBytes: firmware.length,
      percent: 0,
      message: "Reading LEGO Bootloader info…",
    });
    const infoReply = await request(BootloaderCmd.GET_INFO, null, {
      withResponse: true,
      expectReply: true,
    });
    if (!infoReply || infoReply.length < 14) {
      throw new Error("Invalid GET_INFO reply from bootloader");
    }
    const infoView = new DataView(infoReply.buffer, infoReply.byteOffset, infoReply.byteLength);
    const startAddr = infoView.getUint32(5, true);
    const endAddr = infoView.getUint32(9, true);
    const typeId = infoView.getUint8(13);
    if (typeId !== MOVE_HUB_DEVICE_ID) {
      throw new Error(
        `Wrong hub type 0x${typeId.toString(16)} (expected Move Hub 0x${MOVE_HUB_DEVICE_ID.toString(16)})`
      );
    }
    if (endAddr <= startAddr || startAddr + firmware.length > endAddr + 1) {
      throw new Error(
        `Firmware (${firmware.length} B) exceeds bootloader flash range [0x${startAddr.toString(16)}, 0x${endAddr.toString(16)}]`
      );
    }

    // 2. ERASE_FLASH (0x11)
    onProgress?.({
      stage: "erasing",
      bytesWritten: 0,
      totalBytes: firmware.length,
      percent: 2,
      message: "Erasing Move Hub flash…",
    });
    try {
      const eraseReply = await request(BootloaderCmd.ERASE_FLASH, null, {
        withResponse: false,
        expectReply: true,
        timeoutMs: eraseTimeoutMs,
      });
      if (!eraseReply || eraseReply.length < 2 || eraseReply[1] !== BootloaderResult.OK) {
        const status = eraseReply && eraseReply.length >= 2 ? `0x${eraseReply[1].toString(16)}` : "missing";
        throw new Error(`Bootloader ERASE_FLASH failed (status ${status})`);
      }
    } catch (err) {
      if (err instanceof BootloaderTimeoutError) {
        // Tolerated ONLY on timeout per Pybricks Windows BLE driver workaround.
        ignoreEraseReply = true;
      } else {
        throw err;
      }
    }

    // 3. INIT_LOADER (0x44)
    const sizePayload = new Uint8Array(4);
    new DataView(sizePayload.buffer).setUint32(0, firmware.length, true);
    const initReply = await request(BootloaderCmd.INIT_LOADER, sizePayload, {
      withResponse: true,
      expectReply: true,
    });
    if (!initReply || initReply.length < 2 || initReply[1] !== BootloaderResult.OK) {
      const status = initReply && initReply.length >= 2 ? `0x${initReply[1].toString(16)}` : "missing";
      throw new Error(`Bootloader INIT_LOADER failed (status ${status})`);
    }

    // 4. PROGRAM_FLASH (0x22) in <= 14-byte chunks + GET_CHECKSUM (0x66) throttle & XOR verification
    let address = startAddr;
    let offset = 0;
    let chunkIndex = 0;
    let runningChecksum = 0xff;
    let finalChecksum = 0;
    let finalCount = 0;

    while (offset < firmware.length) {
      const chunk = firmware.subarray(offset, Math.min(offset + MOVE_HUB_MAX_CHUNK_BYTES, firmware.length));
      const isFinal = offset + chunk.length === firmware.length;

      runningChecksum = computeBootloaderXorChecksum(chunk, runningChecksum);

      // Payload format: [len(chunk)+4, addr_u32_le, ...chunk]
      const payload = new Uint8Array(5 + chunk.length);
      payload[0] = chunk.length + 4;
      new DataView(payload.buffer).setUint32(1, address, true);
      payload.set(chunk, 5);

      const progReply = await request(BootloaderCmd.PROGRAM_FLASH, payload, {
        withResponse: false,
        expectReply: isFinal,
      });

      offset += chunk.length;
      address += chunk.length;
      chunkIndex += 1;

      if (isFinal) {
        if (!progReply || progReply.length < 6) {
          throw new Error("Truncated final PROGRAM_FLASH reply from bootloader");
        }
        const rv = new DataView(progReply.buffer, progReply.byteOffset, progReply.byteLength);
        finalChecksum = rv.getUint8(1);
        finalCount = rv.getUint32(2, true);
        if (finalCount !== firmware.length) {
          throw new Error(
            `Bootloader byte count mismatch: hub wrote ${finalCount} B, expected ${firmware.length} B`
          );
        }
        if (finalChecksum !== runningChecksum) {
          throw new Error(
            `Bootloader final XOR checksum mismatch: got 0x${finalChecksum.toString(16)}, expected 0x${runningChecksum.toString(16)}`
          );
        }
      } else if (chunkIndex % MOVE_HUB_THROTTLE_INTERVAL === 0) {
        const csumReply = await request(BootloaderCmd.GET_CHECKSUM, null, {
          withResponse: true,
          expectReply: true,
          timeoutMs: replyTimeoutMs,
        });
        if (!csumReply || csumReply.length < 2) {
          throw new Error("Truncated GET_CHECKSUM reply from bootloader");
        }
        if (csumReply[1] !== runningChecksum) {
          throw new Error(
            `Bootloader incremental XOR checksum mismatch at ${offset} B: got 0x${csumReply[1].toString(16)}, expected 0x${runningChecksum.toString(16)}`
          );
        }
      }

      const pct = Math.min(99, Math.round(5 + (offset / firmware.length) * 93));
      onProgress?.({
        stage: "programming",
        bytesWritten: offset,
        totalBytes: firmware.length,
        percent: pct,
        message: `Flashing ${offset.toLocaleString()} / ${firmware.length.toLocaleString()} B…`,
      });
    }

    // 5. START_APP (0x33) — reboots hub immediately.
    onProgress?.({
      stage: "rebooting",
      bytesWritten: firmware.length,
      totalBytes: firmware.length,
      percent: 99,
      message: "Starting Vernie OS…",
    });
    await request(BootloaderCmd.START_APP, null, {
      withResponse: false,
      expectReply: false,
    });

    onProgress?.({
      stage: "done",
      bytesWritten: firmware.length,
      totalBytes: firmware.length,
      percent: 100,
      message: "Flash complete! Vernie OS is booting.",
    });

    return {
      startAddr,
      endAddr,
      bytesWritten: firmware.length,
      finalChecksum,
      finalCount,
    };
  } finally {
    clearPendingWaiter();
    char.removeEventListener("characteristicvaluechanged", onNotify);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function flashMoveHubViaWebBluetooth(
  firmware: Uint8Array,
  onProgress?: (p: FlashProgress) => void
): Promise<FlashResult> {
  if (!navigator.bluetooth) {
    throw new Error(
      "Web Bluetooth is not available. Open this page in Chrome on a Chromebook, desktop, or Android device over HTTPS."
    );
  }
  // Validate firmware BEFORE opening the Bluetooth picker so corrupt binaries fail instantly.
  if (!verifyMoveHubZeroSum(firmware)) {
    throw new Error(
      "Firmware binary failed Move Hub zero-sum checksum or 104 KiB FLASH_FIRMWARE limit! Refusing to flash."
    );
  }

  onProgress?.({
    stage: "connecting",
    bytesWritten: 0,
    totalBytes: firmware.length,
    percent: 0,
    message: "Select 'LEGO Bootloader' in the Chrome Bluetooth dialog…",
  });

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [LWP3_BOOTLOADER_SERVICE_UUID] }],
  });

  const abortCtrl = new AbortController();
  const onDisconnect = (): void => {
    abortCtrl.abort(new Error("LEGO Bootloader disconnected unexpectedly during flash"));
  };
  device.addEventListener("gattserverdisconnected", onDisconnect);

  try {
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(LWP3_BOOTLOADER_SERVICE_UUID);
    const char = await service.getCharacteristic(LWP3_BOOTLOADER_CHAR_UUID);
    return await flashOverBootloaderChar(char, firmware, onProgress, {
      signal: abortCtrl.signal,
    });
  } finally {
    device.removeEventListener("gattserverdisconnected", onDisconnect);
    if (device.gatt?.connected) {
      device.gatt.disconnect();
    }
  }
}
