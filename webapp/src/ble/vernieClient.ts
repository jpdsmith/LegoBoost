// SPDX-License-Identifier: MIT
// Web Bluetooth client for Vernie OS over Pybricks GATT (c5f50001 / c5f50002).
// Enforces single-in-flight latest-value coalescing for BlueNRG-MS Write-With-Response.

import {
  buildRebootToUpdateModeCommand,
  encodeChestLed,
  encodeDart,
  encodeDrive,
  encodeHead,
  encodeHubLed,
  encodeSetMode,
  encodeSynth,
  PYBRICKS_COMMAND_EVENT_CHAR_UUID,
  PYBRICKS_SERVICE_UUID,
  TelemetryFrame,
  unwrapPybricksEventNotification,
  wrapPybricksAppData,
} from "./protocol";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface BleCharacteristicLike {
  writeValueWithResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<unknown>;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  removeEventListener(type: string, listener: (ev: Event) => void): void;
}

export interface VernieClientCallbacks {
  onStateChange?: (state: ConnectionState, deviceName?: string) => void;
  onTelemetry?: (frame: TelemetryFrame) => void;
  onError?: (err: Error) => void;
}

/**
 * Single-in-flight Write-With-Response scheduler with latest-value coalescing.
 * - Coalescible commands (like DRIVE joystick frames) replace any pending slot
 *   so BlueNRG-MS never backs up on stale frames, while always delivering the final frame.
 * - Non-coalescible commands (LED, MODE, DART, REBOOT) are queued in FIFO order.
 * - Coalesced write errors are forwarded to onError without stranding subsequent FIFO writes.
 */
export class CoalescingGattWriter {
  private inFlight = false;
  private latestCoalesced: Uint8Array | null = null;
  private fifoQueue: Array<{
    data: Uint8Array;
    resolve: () => void;
    reject: (err: unknown) => void;
    onStart?: () => void;
  }> = [];
  private disposed = false;

  constructor(
    private readonly writeFn: (data: Uint8Array) => Promise<void>,
    private readonly onError?: (err: Error) => void
  ) {}

  enqueueCoalesced(data: Uint8Array): void {
    if (this.disposed) return;
    this.latestCoalesced = data;
    void this.pump();
  }

  enqueueReliable(data: Uint8Array, onStart?: () => void): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("BLE client is disconnected"));
    }
    return new Promise<void>((resolve, reject) => {
      this.fifoQueue.push({ data, resolve, reject, onStart });
      void this.pump();
    });
  }

  reset(reason = "Disconnected"): void {
    this.disposed = true;
    this.latestCoalesced = null;
    const pending = this.fifoQueue.splice(0);
    for (const item of pending) {
      item.reject(new Error(reason));
    }
  }

  private async pump(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;
    try {
      while (!this.disposed) {
        if (this.fifoQueue.length > 0) {
          const item = this.fifoQueue.shift()!;
          try {
            item.onStart?.();
            await this.writeFn(item.data);
            item.resolve();
          } catch (err) {
            item.reject(err);
          }
        } else if (this.latestCoalesced !== null) {
          const payload = this.latestCoalesced;
          this.latestCoalesced = null;
          try {
            await this.writeFn(payload);
          } catch (err) {
            if (!this.disposed) {
              this.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          }
        } else {
          break;
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function isExpectedRebootDisconnectError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.name === "NetworkError" || err.name === "InvalidStateError") {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("disconnected") ||
    msg.includes("gatt server is disconnected") ||
    msg.includes("network") ||
    msg.includes("closed")
  );
}

export class VernieClient {
  private device: BluetoothDevice | null = null;
  private char: BleCharacteristicLike | null = null;
  private writer: CoalescingGattWriter | null = null;
  private state: ConnectionState = "disconnected";
  private connectSeq = 0;

  constructor(private readonly callbacks: VernieClientCallbacks = {}) {}

  getState(): ConnectionState {
    return this.state;
  }

  private setState(next: ConnectionState, name?: string): void {
    this.state = next;
    this.callbacks.onStateChange?.(next, name);
  }

  private readonly handleNotification = (ev: Event): void => {
    const target = ev.target as unknown as { value?: DataView };
    if (!target?.value) return;
    const raw = new Uint8Array(
      target.value.buffer,
      target.value.byteOffset,
      target.value.byteLength
    );
    const frame = unwrapPybricksEventNotification(raw);
    if (frame) {
      this.callbacks.onTelemetry?.(frame);
    }
  };

  private readonly handleDisconnected = (): void => {
    this.cleanup();
  };

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error(
        "Web Bluetooth is not available in this browser. Use Chrome or Edge on ChromeOS, macOS, Windows, Linux, or Android over HTTPS."
      );
    }
    if (this.state !== "disconnected") {
      throw new Error("Already connecting or connected to VernieOS");
    }

    const seq = ++this.connectSeq;
    this.setState("connecting");
    let chosenDevice: BluetoothDevice | null = null;

    try {
      chosenDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [PYBRICKS_SERVICE_UUID] }],
      });
      if (seq !== this.connectSeq) {
        return;
      }
      this.device = chosenDevice;
      chosenDevice.addEventListener("gattserverdisconnected", this.handleDisconnected);

      const server = await chosenDevice.gatt!.connect();
      if (seq !== this.connectSeq) {
        if (chosenDevice.gatt?.connected) chosenDevice.gatt.disconnect();
        return;
      }

      const service = await server.getPrimaryService(PYBRICKS_SERVICE_UUID);
      if (seq !== this.connectSeq) {
        if (chosenDevice.gatt?.connected) chosenDevice.gatt.disconnect();
        return;
      }

      const char = await service.getCharacteristic(PYBRICKS_COMMAND_EVENT_CHAR_UUID);
      if (seq !== this.connectSeq) {
        if (chosenDevice.gatt?.connected) chosenDevice.gatt.disconnect();
        return;
      }

      await this.attachCharacteristic(char, chosenDevice.name || "VernieOS", seq);
    } catch (err) {
      if (chosenDevice?.gatt?.connected) {
        chosenDevice.gatt.disconnect();
      }
      if (seq === this.connectSeq) {
        this.cleanup();
      }
      throw err;
    }
  }

  /** Exposed for unit tests to bind a mocked GATT characteristic without navigator.bluetooth. */
  async attachCharacteristic(
    char: BleCharacteristicLike,
    name = "VernieOS",
    expectedSeq?: number
  ): Promise<void> {
    if (expectedSeq === undefined && this.state !== "disconnected") {
      this.cleanup();
    }
    const seq = expectedSeq ?? ++this.connectSeq;
    const writer = new CoalescingGattWriter(
      async (bytes) => {
        await char.writeValueWithResponse(bytes as BufferSource);
      },
      (err) => this.callbacks.onError?.(err)
    );

    char.addEventListener("characteristicvaluechanged", this.handleNotification);
    try {
      await char.startNotifications();
    } catch (err) {
      char.removeEventListener("characteristicvaluechanged", this.handleNotification);
      writer.reset("Failed to enable notifications");
      throw err;
    }

    if (seq !== this.connectSeq) {
      char.removeEventListener("characteristicvaluechanged", this.handleNotification);
      writer.reset("Connection cancelled");
      if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
      return;
    }

    this.char = char;
    this.writer = writer;
    this.setState("connected", name);
  }

  disconnect(): void {
    this.connectSeq += 1;
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.char) {
      this.char.removeEventListener("characteristicvaluechanged", this.handleNotification);
      this.char = null;
    }
    if (this.device) {
      this.device.removeEventListener("gattserverdisconnected", this.handleDisconnected);
      this.device = null;
    }
    if (this.writer) {
      this.writer.reset("BLE disconnected");
      this.writer = null;
    }
    if (this.state !== "disconnected") {
      this.setState("disconnected");
    }
  }

  sendDrive(left: number, right: number, timeoutMs = 400): void {
    if (!this.writer) return;
    this.writer.enqueueCoalesced(wrapPybricksAppData(encodeDrive(left, right, timeoutMs)));
  }

  sendHead(angleDeg: number, speed = 50): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Not connected"));
    return this.writer.enqueueReliable(wrapPybricksAppData(encodeHead(angleDeg, speed)));
  }

  sendDart(subcmd: number): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Not connected"));
    return this.writer.enqueueReliable(wrapPybricksAppData(encodeDart(subcmd)));
  }

  sendHubLed(r: number, g: number, b: number): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Not connected"));
    return this.writer.enqueueReliable(wrapPybricksAppData(encodeHubLed(r, g, b)));
  }

  sendChestLed(state: number): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Not connected"));
    return this.writer.enqueueReliable(wrapPybricksAppData(encodeChestLed(state)));
  }

  sendSynth(voice: number, presetOrNote: number, durMs = 300): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Not connected"));
    return this.writer.enqueueReliable(wrapPybricksAppData(encodeSynth(voice, presetOrNote, durMs)));
  }

  sendSetMode(modeId: number): Promise<void> {
    if (!this.writer) return Promise.reject(new Error("Not connected"));
    return this.writer.enqueueReliable(wrapPybricksAppData(encodeSetMode(modeId)));
  }

  async rebootToBootloader(): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    // Pybricks L1 command [0x05] triggers NVIC_SystemReset() inside pbsys_handle_command()
    // BEFORE BlueNRG-MS sends the ATT Write Response, so Chrome typically rejects
    // writeValueWithResponse([0x05]) with NetworkError / GATT disconnected. Treat that
    // disconnect as expected reboot success ONLY if the [0x05] write actually started.
    let writeStarted = false;
    try {
      await this.writer.enqueueReliable(buildRebootToUpdateModeCommand(), () => {
        writeStarted = true;
      });
    } catch (err) {
      if (!writeStarted || !isExpectedRebootDisconnectError(err)) {
        throw err;
      }
    } finally {
      this.cleanup();
    }
  }
}
