---
type: Hardware Spec
title: Optional Port C & D Raw UART Hardware Expansion
description: Verified STM32F070RB USART4/USART3 pinout, electrical safety limits, and firmware integration notes for attaching an external ESP32-S3 camera or DFPlayer Mini MP3 module to Powered Up Port C or Port D.
resource: ../../third_party/pybricks-micropython/lib/pbio/platform/move_hub/platform.c
tags: [hardware, uart, expansion, esp32-s3, dfplayer, powered-up]
status: draft
generated: { by: antigravity/1.0, at: 2026-11-21T18:35:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T18:35:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-movehub-platform
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/platform/move_hub/platform.c
    title: Pybricks Move Hub peripheral map (platform.c)
    author: team:pybricks
  - id: pbio-port-api
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/include/pbio/port.h
    title: Pybricks lib/pbio port mode header (port.h)
    author: team:pybricks
---

# Overview

While the [Vernie Web Cockpit PWA](../architecture/web-cockpit.md) delivers zero-hardware-mod **Vision & Voice** via a Chromebook webcam or strapped Android phone, the LEGO® BOOST Move Hub (88006) also exposes two genuine hardware UARTs on its external Powered Up connectors (Port C and Port D).[^pybricks-movehub-platform]

Replacing Vernie's chest 88007 sensor on one external port (keeping the 88008 head/dart motor on the remaining port) lets builders attach a standalone microcontroller (such as an **ESP32-S3** vision/AI backpack) or an audio player (**DFPlayer Mini MP3**) directly to Vernie with zero Bluetooth host required.

# Verified STM32F070RB Port C & D Pinout

Derived directly from Pybricks `pbdrv_ioport_platform_data` in `platform.c`:[^pybricks-movehub-platform]

| External Port | `pbdrv` UART ID | STM32 Peripheral | TX Pin (AF) | RX Pin (AF) | Buffer Enable | ID Pins (`P5` / `P6`) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Port C** | `UART_ID_0` | `USART4` | `PC10` (AF0) | `PC11` (AF0) | `PB4` | `PB7` / `PC15` |
| **Port D** | `UART_ID_1` | `USART3` | `PC4` (AF1) | `PC5` (AF1) | `PB0` | `PB10` / `PA12` |

Both ports share the switchable 3.3 V sensor supply controlled by `PB2` (`pbdrv_ioport_platform_data_vcc_pin`), and both declare `PBIO_PORT_MODE_LEGO_DCM | PBIO_PORT_MODE_UART` in `supported_modes`.[^pybricks-movehub-platform]

# Powered Up 6-Pin Connector Wiring & Electrical Safety

| Wire Pin | Signal | Raw UART Use | Electrical Warning |
| :---: | :--- | :--- | :--- |
| **1 (`M1`)** | H-Bridge Output 1 | Leave unconnected | Never connect to logic pins (`~9 V` battery rail when motor active) |
| **2 (`M2`)** | H-Bridge Output 2 | Leave unconnected | Never connect to logic pins |
| **3 (`GND`)** | Common Ground | **Connect to module GND** | Mandatory common reference |
| **4 (`VCC`)** | Hub `3.3 V` (`PB2`) | **Do NOT power Wi-Fi/amp loads!** | Hub LDO is rated for low-current LEGO sensors only (~150 mA budget). Power ESP32-S3 or DFPlayer + speaker from an external 5 V USB power bank or LiPo regulator! |
| **5 (`ID1`)** | Hub TX (`PC10` / `PC4`) | Connect to module **RX** | `3.3 V` CMOS logic |
| **6 (`ID2`)** | Hub RX (`PC11` / `PC5`) | Connect to module **TX** | **Strict `3.3 V` max!** Never feed `5 V` TX directly; use a `3.3 V` module or resistive divider (`1 kΩ` / `2 kΩ`). |

> **Never drive TIM3 Voice 2 audio on a port configured for raw UART**, and verify `M1`/`M2` remain in `COAST` (`0` duty) whenever `PBIO_PORT_MODE_UART` is selected (Vernie OS already enforces this by verifying a confirmed `88008` motor before enabling Voice 2 in [Singing Motors](singing-motors.md)).

# Firmware Integration Path (`lib/pbio`)

To add a custom raw-UART driver in a future firmware build without breaking Vernie's automatic Port C/D detection:

1. **Port Mode Switch:** Request `PBIO_PORT_MODE_UART` via `pbio_port_set_mode(port, PBIO_PORT_MODE_UART)` instead of `PBIO_PORT_MODE_LEGO_DCM` on the non-motor port (or explicitly dedicate Port C/D when no 88007 LUMP handshake responds within 500 ms).[^pbio-port-api]
2. **Baud Rate & Framing:**
   - **ESP32-S3 Vision / AI Backpack (`115200 8N1`):** Reuse the existing 18-byte [BLE AppData Protocol](../protocol/ble-appdata.md) opcodes (`0x01 DRIVE`, `0x02 HEAD`, `0x04 SYNTH`, `0x05 LED`, `0x06 SET_MODE`) framed with COBS or a `[0xAA, 0x55, len, payload..., crc8]` header, feeding directly into `vernie_protocol_rx()`! Keep the `0x03 DART` opcode **disabled over UART** unless explicitly armed by the human operator.
   - **DFPlayer Mini MP3 (`9600 8N1`):** Emit standard 10-byte DFPlayer frames (`0x7E 0xFF 0x06 <cmd> 0x00 <param_hi> <param_lo> <ck_hi> <ck_lo> 0xEF`) triggered from `vernie_modes.c` reactions (greeting, alarm, victory) while leaving `TIM1`/`TIM3` free for tracks and head motion.
3. **Budget Headroom:** Current `vernie-os-0.3.1` firmware uses `44,580 B` of `106,496 B` Flash (**58% free**) and `8,948 B` of `16,384 B` SRAM, leaving ample room for a lightweight `pbdrv_uart` ring buffer (~`1 KB` Flash, `128 B` RAM) without touching `FLASH_USER_0`.

[^pybricks-movehub-platform]: Pybricks Move Hub platform pin/UART definitions (`lib/pbio/platform/move_hub/platform.c`)
[^pbio-port-api]: Pybricks `pbio_port_mode_t` raw UART mode definition (`lib/pbio/include/pbio/port.h`)
