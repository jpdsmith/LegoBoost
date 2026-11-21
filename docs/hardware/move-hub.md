---
type: Hardware Spec
title: LEGO BOOST Move Hub (88006)
description: Verified STM32F070RB memory layout, timer allocation, SPI1 LIS3DH accelerometer, and SPI2 BlueNRG-MS radio profile.
resource: ../../firmware/linker/vernie_movehub.ld
tags: [hardware, stm32f070rb, move-hub, timers, bluenrg, lis3dh]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-movehub-ld
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/platform/move_hub/platform.ld
    title: Pybricks Move Hub linker script (platform.ld)
    author: team:pybricks
  - id: pybricks-movehub-platform
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/platform/move_hub/platform.c
    title: Pybricks Move Hub peripheral map (platform.c)
    author: team:pybricks
---

# Memory Map (`STM32F070RB`, 48 MHz Cortex-M0)

| Region | Address | Size | Bootloader Checksum | Vernie OS Role |
| :--- | :--- | :---: | :---: | :--- |
| `FLASH_BOOTLOADER` | `0x08000000` | 20 KB | Protected | Non-erasable LEGO LWP3 bootloader + factory MAC (`0x08004FFA`)[^pybricks-movehub-ld] |
| `FLASH_FIRMWARE` | `0x08005000` | 104 KB | Included | Bare-metal [Vernie OS](../architecture/vernie-os.md) binary |
| `FLASH_USER_0` | `0x0801F000` | 2 KB | Included | Kept erased (`0xFFFFFFFF`) — never written at runtime[^pybricks-movehub-ld] |
| `FLASH_USER_1` | `0x0801F800` | 2 KB | Excluded | Vernie persistent calibration & macros with CRC32 (Phase 2) |
| `RAM` | `0x20000000` | 16 KB | N/A | Relocated ISR table (`0x20000000`), bootloader magic (`0x20000100`), `.data`/`.bss`, 3 KB stack |

# Peripheral & Timer Map

| Subsystem | Peripheral / Pins | Notes |
| :--- | :--- | :--- |
| Ports A & B (Internal Tracks) | `TIM1` CH1–4 (`PA8–PA11`), Quad Encoders (`PB1/PB9`, `PA0/PA1`) | LB1836 H-bridge; default 12 kHz (`PSC=3, ARR=1000`); Phase 2 Synth Voice 1[^pybricks-movehub-platform] |
| Ports C & D (External LUMP) | `TIM3` CH1–4 (`PC6–PC9`), `USART4` (`PC10/PC11`), `USART3` (`PC4/PC5`) | Auto-detected Head Motor & 88007 Sensor; Phase 2 Synth Voice 2 (confirmed motor port only)[^pybricks-movehub-platform] |
| RGB Status LED | `TIM15` (`PB14/PB15`), `TIM16` (`PB8`) | Driven via `pbsys_status_light_main`[^pybricks-movehub-platform] |
| 3-Axis Accelerometer | `SPI1` (`PA4` CS, `PA5–PA7`) — ST LIS3DH (`WHO_AM_I = 0x33`) | Requires 8-bit `SPI1->DR` access and 200–400 Hz ODR for hardware double-tap |
| Bluetooth LE Radio | `SPI2` — ST BlueNRG-MS (`ATT_MTU = 23`) | Write With Response + Notify; see [BLE AppData Protocol](../protocol/ble-appdata.md) |
| Power & Button | `PB11` power latch, `PC13` green button, ADC Ch 10/11 | 6× AAA (9 V nominal); low batteries (< 7.2 V) risk BLE drops during flashing |

[^pybricks-movehub-ld]: Pybricks Move Hub linker script (`lib/pbio/platform/move_hub/platform.ld`)
[^pybricks-movehub-platform]: Pybricks Move Hub platform pin/timer configuration (`lib/pbio/platform/move_hub/platform.c`)
