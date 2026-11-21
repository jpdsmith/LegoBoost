---
type: Protocol Spec
title: BLE AppData Binary Protocol
description: Exact Layer-1 Pybricks GATT framing and Layer-2 Vernie command/telemetry binary wire format verified for BlueNRG-MS ATT_MTU=23.
resource: ../../tools/protocol_schema.json
tags: [protocol, ble, gatt, binary, pybricks, mtu]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-command-c
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/sys/command.c
    title: Pybricks pbsys_handle_command() BLE command dispatcher
    author: team:pybricks
  - id: pybricks-host-c
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/sys/host.c
    title: Pybricks pbsys_host_send_app_data() MTU & notification framing
    author: team:pybricks
---

# Layer-1 Transport (`c5f50001` / `c5f50002`)

BlueNRG-MS enforces `ATT_MTU = 23` (20-byte ATT payload) and **Write With Response** (`CHAR_PROP_WRITE | CHAR_PROP_NOTIFY`) on `c5f50002-8280-46da-89f4-6d8051e4aeef`:

- **Direct L1 Reboot-to-Bootloader:** `[0x05]` (`PBIO_PYBRICKS_COMMAND_REBOOT_TO_UPDATE_MODE`).[^pybricks-command-c]
- **L1 RX AppData Envelope:** `[0x07, offset_lo, offset_hi, <1..17 bytes>]` → **17 bytes max** Vernie payload.[^pybricks-command-c]
- **L1 TX AppData Notification:** `[0x02, <1..19 bytes>]` → **19 bytes max** Vernie payload.[^pybricks-host-c]
- **Cadence:** Clients coalesce control writes to **15–20 Hz** (single write in flight, always delivering final stop) and Vernie streams telemetry at **8–10 Hz**.

# Schema

## RX Packets (App → Vernie, `<= 17 B`)

| Opcode | Name | Little-Endian Payload | Total Bytes | Safety / Bounds |
| :---: | :--- | :--- | :---: | :--- |
| `0x01` | `DRIVE` | `int8 left, int8 right, uint16 timeout_ms` | 5 | `left/right` clamped `[-100, 100]`, `timeout_ms` `[100, 1000]` |
| `0x02` | `HEAD` | `int8 angle_deg, uint8 speed` | 3 | `0x7F` = non-trigger home; angles clamped `[-40, +35]` |
| `0x03` | `DART` | `uint8 subcmd (0/1/2), uint8 magic (0xA5)` | 3 | Disarmed on boot; `FIRE` rejected unless armed + `0xA5` |
| `0x04` | `SYNTH` | `uint8 voice (0..2), uint8 note_or_preset, uint16 dur_ms` | 5 | `dur_ms` hard-capped at `3000 ms` |
| `0x05` | `LED` | `uint8 target (0=hub, 1=chest), uint8 a, uint8 b, uint8 c` | 5 | Chest target enforces `{0, 3, 5, 9}` |
| `0x06` | `SET_MODE` | `uint8 mode_id (0..4)` | 2 | Rejected in Watchdog Safe Mode |
| `0x07` | `MACRO_OP` | `uint8 subcmd, uint8 offset, uint8 data[0..14]` | 3–17 | Fits inside 17-byte RX envelope |

## TX Telemetry Packet (`0x80`, Vernie → App, `18 B <= 19 B`)

| Offset | Field | Type | Meaning |
| :---: | :--- | :--- | :--- |
| `0` | `opcode` | `uint8` | `0x80` (`128`) |
| `1..2` | `battery_mv` | `uint16` | Battery voltage in millivolts |
| `3` | `distance_pct` | `uint8` | `0..100`, or `0xFF` when sensor absent |
| `4` | `color_id` | `uint8` | Detected LEGO color enum |
| `5..6` | `pitch_deg, roll_deg` | `int8, int8` | Upright torso pitch/roll in degrees |
| `7` | `flags` | `uint8` | Bitmask: `0:PICKED_UP, 1:BUMP, 2:TAP, 3:DART_ARMED, 4:HEAD_HOMED, 5:SENSOR_OK, 6:SAFE_MODE, 7:SYNTH_ACTIVE` |
| `8` | `mode_id` | `uint8` | Active Vernie mode (`0..4`) |
| `9..14` | `enc_a, enc_b, head_deg` | `int16 × 3` | Encoder positions (degrees) |
| `15..16` | `speed_a, speed_b` | `int8 × 2` | Active drive commands (`-100..+100`) |
| `17` | `seq` | `uint8` | Rolling sequence number (`0..255`) |

# Examples

Shared golden test vectors live in `tools/protocol_schema.json` and are asserted identically by `firmware/tests/test_vernie_protocol.c` and `webapp/src/ble/vernieClient.test.ts`.

[^pybricks-command-c]: Pybricks `pbsys_handle_command()` (`0x05` reboot & `0x07` write app data)
[^pybricks-host-c]: Pybricks `pbsys_host_send_app_data()` 1-byte event prefix and MTU checks
