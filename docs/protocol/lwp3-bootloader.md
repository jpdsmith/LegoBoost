---
type: Protocol Spec
title: LWP3 Bootloader Flashing Protocol
description: LEGO Move Hub BLE bootloader wire protocol (service 0x1625, characteristic 0x1626), 14-byte flash writes, throttling, and dual-artifact packaging.
resource: ../../tools/pack_firmware.py
tags: [protocol, lwp3, bootloader, dfu, web-bluetooth]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-lwp3-flash
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/tools/flash/lwp3/flash.py
    title: Pybricks LWP3 BLE Bootloader flasher implementation
    author: team:pybricks
  - id: pybricks-lwp3-bootloader
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/tools/flash/lwp3/bootloader.py
    title: Pybricks LWP3 Bootloader command opcodes
    author: team:pybricks
---

# GATT Endpoints

- **Service UUID:** `00001625-1212-efde-1623-785feabcd123`[^pybricks-lwp3-flash]
- **Characteristic UUID:** `00001626-1212-efde-1623-785feabcd123`[^pybricks-lwp3-flash]
- **Move Hub Device ID:** `0x40` (`64`), `max_data_size = 14` bytes per `PROGRAM_FLASH` packet.[^pybricks-lwp3-flash]

# Flash Sequence (Move Hub)

1. **`GET_INFO` (`0x55`, Write With Response):** Returns `<iIIB` (`version, start_addr=0x08005000, end_addr, type_id`). Abort unless `type_id == 0x40` and `start_addr + firmware.length <= end_addr + 1`.[^pybricks-lwp3-flash]
2. **`ERASE_FLASH` (`0x11`, Write Without Response, 5 s timeout):** Erases `FLASH_FIRMWARE` and checks `result == 0x00` (`OK`). ONLY on timeout (Windows/buggy BLE stacks where the reply arrives late), set `ignore_erase_reply = true` and discard a stray `0x11` notification before reading `INIT_LOADER`.[^pybricks-lwp3-flash]
3. **`INIT_LOADER` (`0x44`, Write With Response):** Payload `<I` = total byte length of checksummed `firmware.bin`; verify `result == 0x00` (`OK`).[^pybricks-lwp3-flash]
4. **`PROGRAM_FLASH` (`0x22`, Write Without Response):** Stream chunks of `<= 14` bytes packed as `[0x22, len(chunk) + 4, addr_u32_le, ...chunk]`, maintaining an 8-bit running XOR checksum initialized to `0xFF`.[^pybricks-lwp3-flash]
   - Every 10th non-final packet, send **`GET_CHECKSUM` (`0x66`, Write With Response)** to throttle BlueNRG-MS and verify the hub's running XOR checksum matches.[^pybricks-lwp3-flash]
   - The final chunk receives a notification `<BI` (`checksum, count`); abort before `START_APP` unless `count == firmware.length` and `checksum` matches the running XOR checksum.[^pybricks-lwp3-flash]
5. **`START_APP` (`0x33`, Write Without Response):** Reboots Move Hub into Vernie OS.[^pybricks-lwp3-bootloader]

# Dual-Artifact Packaging Rule

- **`firmware.zip`** (for `code.pybricks.com` / `pybricksdev`): Contains **unchecksummed** `firmware-base.bin` + **`metadata-version: "2.0.0"`** `firmware.metadata.json` + `ReadMe_OSS.txt`. Hub names are capped at `<= 12` UTF-8 bytes to fit upstream BlueNRG-MS `response_data[25]` (offset 13).
- **`firmware.bin`** (for `lwp3Flasher.ts`): `firmware-base.bin` + appended 4-byte additive complement (`<= 106,496 B` `FLASH_FIRMWARE`) attested by [LWP3 Bootloader Checksum](../computations/lwp3-checksum.md).

[^pybricks-lwp3-flash]: Pybricks `tools/flash/lwp3/flash.py` Move Hub flashing state machine
[^pybricks-lwp3-bootloader]: Pybricks `tools/flash/lwp3/bootloader.py` opcode table
