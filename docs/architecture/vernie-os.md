---
type: Architecture Spec
title: Vernie OS Firmware Architecture
description: Pure-MIT native-C Move Hub firmware built on Pybricks lib/pbio without MicroPython, with HMI_NONE auto-boot and Watchdog Safe Mode.
resource: ../../firmware/src/main.c
tags: [firmware, architecture, stm32f0, pbio, pure-mit]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-main
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/sys/main.c
    title: Pybricks pbsys_main lifecycle (pinned commit 822dbb48)
    author: team:pybricks
  - id: pybricks-hmi-none
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/sys/hmi_none.c
    title: Pybricks hmi_none auto-boot implementation
    author: team:pybricks
  - id: pybricks-telemetry-license
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/sys/telemetry.c
    title: Pybricks telemetry.c non-free license notice
    author: team:pybricks
---

# Overview

Vernie OS replaces the MicroPython VM on the [LEGO BOOST Move Hub](../hardware/move-hub.md) with a cooperative native-C application running inside `pbsys_main_run_program()`.[^pybricks-main]

# Key Configuration Invariants

| Config Macro | Value | Rationale |
| :--- | :---: | :--- |
| `PBSYS_CONFIG_TELEMETRY` | `0` | Excludes non-free `telemetry.c` to guarantee a pure-MIT build.[^pybricks-telemetry-license] |
| `PBDRV_CONFIG_BLOCK_DEVICE` | `0` | Reclaims 7,176 B static `ramdisk` SRAM and keeps `FLASH_USER_0` untouched. |
| `PBSYS_CONFIG_STORAGE` | `0` | Prevents runtime writes to bootloader-checked `FLASH_USER_0`; Phase 2 persists settings to unchecked `FLASH_USER_1` with CRC32. |
| `PBSYS_CONFIG_HMI_NONE` | `1` | Waits for boot-button release and auto-starts Vernie OS immediately without a second press.[^pybricks-hmi-none] |
| `PBSYS_CONFIG_STATUS_LIGHT_BATTERY` | `0` | Move Hub has a single RGB LED (`PBDRV_CONFIG_LED_NUM_DEV=1`), matching upstream `move_hub/pbsysconfig.h`. |
| `PBSYS_CONFIG_STATUS_LIGHT_STATE_ANIMATIONS` | `1` | Restores rapid blue blink feedback during 2-second hold shutdown without interfering with Vernie OS LED control (`PBSYS_CONFIG_HMI_PUP=0`). |

# Startup, Button & Watchdog Safety

1. On entry, `pbsys_main_run_program()` calls `pbsys_program_stop_set_buttons(0)` so debounced short green-button presses (`40–799 ms`) cycle standalone modes rather than killing Vernie OS, while long holds (`>= 800 ms`) never bump mode and a 2-second hold cleanly shuts the hub down.
2. Because `hmi_none` does not enable BLE advertising automatically, Vernie OS drives advertising via a HAL-independent runtime state machine (`vernie_runtime.c`) that monitors `pbdrv_bluetooth_advertising_state` directly, restarting advertising immediately on host disconnect and after a 500 ms backoff on transient HCI busy or GAP-only disconnects over the [BLE AppData Protocol](../protocol/ble-appdata.md).
3. Freestanding libc primitives (`string_minimal.c`) are compiled with `-ffreestanding -fno-builtin -fno-tree-loop-distribute-patterns` so GCC `-Os` never synthesizes recursive `memset`/`strlen` calls; the ELF attester enforces this on every build.
4. If `pbdrv_reset_get_reason() == PBDRV_RESET_REASON_WATCHDOG`, Vernie OS enters **Watchdog Safe Mode**: motion commands are blocked, LED flashes alternating red/blue, and Pybricks L1 `0x05` reboot-to-bootloader remains active for recovery.
5. Build size, symbol addresses, non-recursive disassembly, and pure-MIT compliance are mechanically checked by the [Flash/SRAM & Pure-MIT Budget](../computations/flash-ram-budget.md) attested computation.

[^pybricks-main]: Pybricks `pbsys_main()` lifecycle (`lib/pbio/sys/main.c`)
[^pybricks-hmi-none]: Pybricks `hmi_none.c` immediate boot-start handler
[^pybricks-telemetry-license]: Pybricks `telemetry.c` header requiring `PBSYS_CONFIG_TELEMETRY=0` for MIT builds
