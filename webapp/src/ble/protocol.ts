// SPDX-License-Identifier: MIT
// Vernie OS Layer-1 Pybricks GATT & Layer-2 Binary AppData Protocol Codec.
// Mirrors tools/protocol_schema.json and firmware/src/vernie_protocol.c byte-for-byte.

export const PYBRICKS_SERVICE_UUID = "c5f50001-8280-46da-89f4-6d8051e4aeef";
export const PYBRICKS_COMMAND_EVENT_CHAR_UUID = "c5f50002-8280-46da-89f4-6d8051e4aeef";
export const PYBRICKS_HUB_CAPABILITIES_CHAR_UUID = "c5f50003-8280-46da-89f4-6d8051e4aeef";

export const LWP3_BOOTLOADER_SERVICE_UUID = "00001625-1212-efde-1623-785feabcd123";
export const LWP3_BOOTLOADER_CHAR_UUID = "00001626-1212-efde-1623-785feabcd123";

export const L1_CMD_REBOOT_TO_UPDATE_MODE = 0x05;
export const L1_CMD_WRITE_APP_DATA = 0x07;
export const L1_EVENT_WRITE_APP_DATA = 0x02;

export const RX_APP_DATA_MAX_BYTES = 17;
export const TX_APP_DATA_MAX_BYTES = 19;
export const TELEMETRY_BYTES = 18;
export const MACRO_CHUNK_MAX_DATA_BYTES = 14;

export const DART_MAGIC = 0xa5;
export const HEAD_HOME_SENTINEL = 127;

export const Opcode = {
  DRIVE: 0x01,
  HEAD: 0x02,
  DART: 0x03,
  SYNTH: 0x04,
  LED: 0x05,
  SET_MODE: 0x06,
  MACRO_OP: 0x07,
  TELEMETRY: 0x80,
} as const;

export const DartSubcmd = {
  DISARM: 0,
  ARM: 1,
  FIRE: 2,
} as const;

export const LedTarget = {
  HUB_RGB: 0,
  CHEST_4STATE: 1,
} as const;

export const ChestLedState = {
  OFF: 0,
  BLUE: 3,
  GREEN: 5,
  RED: 9,
} as const;

const VALID_CHEST_LED_STATES = new Set<number>(Object.values(ChestLedState));
const VALID_DART_SUBCMDS = new Set<number>(Object.values(DartSubcmd));

export const VernieMode = {
  PET: 0,
  EXPLORER: 1,
  SENTRY: 2,
  COLOR_CARDS: 3,
  REMOTE: 4,
} as const;

export const MODE_NAMES: Record<number, string> = {
  0: "Living Pet",
  1: "Room Explorer",
  2: "Desk Sentry",
  3: "Color Cards",
  4: "Remote Cockpit",
};

export const TelemetryFlag = {
  PICKED_UP: 1 << 0,
  BUMP: 1 << 1,
  TAP: 1 << 2,
  DART_ARMED: 1 << 3,
  HEAD_HOMED: 1 << 4,
  SENSOR_OK: 1 << 5,
  SAFE_MODE: 1 << 6,
  SYNTH_ACTIVE: 1 << 7,
} as const;

export interface TelemetryFrame {
  batteryMv: number;
  distancePct: number;
  colorId: number;
  pitchDeg: number;
  rollDeg: number;
  flags: number;
  modeId: number;
  encA: number;
  encB: number;
  headDeg: number;
  speedA: number;
  speedB: number;
  seq: number;
}

function clamp(v: number, lo: number, hi: number, nanFallback = lo): number {
  if (Number.isNaN(v)) {
    return nanFallback;
  }
  if (v === Infinity) {
    return hi;
  }
  if (v === -Infinity) {
    return lo;
  }
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export function encodeDrive(left: number, right: number, timeoutMs = 400): Uint8Array {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  buf[0] = Opcode.DRIVE;
  view.setInt8(1, clamp(left, -100, 100, 0));
  view.setInt8(2, clamp(right, -100, 100, 0));
  view.setUint16(3, clamp(timeoutMs, 100, 1000, 400), true);
  return buf;
}

export function encodeHead(angleDeg: number, speed = 50): Uint8Array {
  const buf = new Uint8Array(3);
  const view = new DataView(buf.buffer);
  buf[0] = Opcode.HEAD;
  if (angleDeg === HEAD_HOME_SENTINEL) {
    view.setInt8(1, HEAD_HOME_SENTINEL);
  } else {
    view.setInt8(1, clamp(angleDeg, -40, 35, 0));
  }
  buf[2] = clamp(speed, 0, 100, 50);
  return buf;
}

export function encodeDart(subcmd: number, magic = DART_MAGIC): Uint8Array {
  if (!VALID_DART_SUBCMDS.has(subcmd)) {
    throw new RangeError(`Invalid dart subcmd ${subcmd}; expected 0 (DISARM), 1 (ARM), or 2 (FIRE)`);
  }
  return new Uint8Array([Opcode.DART, subcmd & 0xff, magic & 0xff]);
}

export function encodeSynth(voice: number, presetOrNote: number, durMs: number): Uint8Array {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  buf[0] = Opcode.SYNTH;
  buf[1] = clamp(voice, 0, 2, 0);
  buf[2] = clamp(presetOrNote, 0, 255, 0);
  view.setUint16(3, clamp(durMs, 0, 3000, 0), true);
  return buf;
}

export function encodeHubLed(r: number, g: number, b: number): Uint8Array {
  return new Uint8Array([
    Opcode.LED,
    LedTarget.HUB_RGB,
    clamp(r, 0, 255, 0),
    clamp(g, 0, 255, 0),
    clamp(b, 0, 255, 0),
  ]);
}

export function encodeChestLed(state: number): Uint8Array {
  if (!VALID_CHEST_LED_STATES.has(state)) {
    throw new RangeError(`Invalid 88007 chest LED state ${state}; expected one of 0, 3, 5, 9`);
  }
  return new Uint8Array([Opcode.LED, LedTarget.CHEST_4STATE, state & 0xff, 0, 0]);
}

export function encodeSetMode(modeId: number): Uint8Array {
  return new Uint8Array([Opcode.SET_MODE, clamp(modeId, 0, 4, 0)]);
}

export function encodeMacroChunk(subcmd: number, offset: number, data: Uint8Array): Uint8Array {
  if (data.length > MACRO_CHUNK_MAX_DATA_BYTES) {
    throw new RangeError(`Macro chunk exceeds ${MACRO_CHUNK_MAX_DATA_BYTES} bytes`);
  }
  const buf = new Uint8Array(3 + data.length);
  buf[0] = Opcode.MACRO_OP;
  buf[1] = subcmd & 0xff;
  buf[2] = offset & 0xff;
  buf.set(data, 3);
  return buf;
}

export function wrapPybricksAppData(payload: Uint8Array, offset = 0): Uint8Array {
  if (payload.length === 0 || payload.length > RX_APP_DATA_MAX_BYTES) {
    throw new RangeError(
      `AppData RX payload length ${payload.length} outside [1, ${RX_APP_DATA_MAX_BYTES}]`
    );
  }
  const envelope = new Uint8Array(3 + payload.length);
  const view = new DataView(envelope.buffer);
  envelope[0] = L1_CMD_WRITE_APP_DATA;
  view.setUint16(1, offset, true);
  envelope.set(payload, 3);
  return envelope;
}

export function buildRebootToUpdateModeCommand(): Uint8Array {
  return new Uint8Array([L1_CMD_REBOOT_TO_UPDATE_MODE]);
}

export function decodeTelemetry(payload: Uint8Array): TelemetryFrame | null {
  if (payload.length !== TELEMETRY_BYTES || payload[0] !== Opcode.TELEMETRY) {
    return null;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    batteryMv: view.getUint16(1, true),
    distancePct: view.getUint8(3),
    colorId: view.getUint8(4),
    pitchDeg: view.getInt8(5),
    rollDeg: view.getInt8(6),
    flags: view.getUint8(7),
    modeId: view.getUint8(8),
    encA: view.getInt16(9, true),
    encB: view.getInt16(11, true),
    headDeg: view.getInt16(13, true),
    speedA: view.getInt8(15),
    speedB: view.getInt8(16),
    seq: view.getUint8(17),
  };
}

export function unwrapPybricksEventNotification(raw: Uint8Array): TelemetryFrame | null {
  if (raw.length !== 1 + TELEMETRY_BYTES || raw[0] !== L1_EVENT_WRITE_APP_DATA) {
    return null;
  }
  return decodeTelemetry(raw.subarray(1));
}
