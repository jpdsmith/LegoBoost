---
type: Architecture Spec
title: Vernie Web Cockpit & Flasher PWA
description: Chromebook-first React/TypeScript Web Bluetooth PWA providing direct LWP3 bootloader flashing, live telemetry, tactile tank drive, singing-motor synth, and visual flash macro sequencing via GitHub Pages.
resource: ../../webapp/src/App.tsx
tags: [webapp, web-bluetooth, chromebook, pwa, react]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T18:30:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: web-bt-spec
    resource: https://webbluetoothcg.github.io/web-bluetooth/
    title: Web Bluetooth Community Group Specification
    author: team:w3c-web-bluetooth
---

# Overview

The Vernie Web Cockpit is an installable static Vite + React + TypeScript PWA (`webapp/public/manifest.webmanifest`) deployed to GitHub Pages so a Chromebook (or any Chrome/Edge desktop or Android device) can flash, drive, play, and program Vernie with zero local installs or Crostini Linux Bluetooth passthrough.[^web-bt-spec]

# Modules

- **`webapp/src/ble/lwp3Flasher.ts`**: Implements the [LWP3 Bootloader Protocol](../protocol/lwp3-bootloader.md) over Web Bluetooth (`00001625-...` / `00001626-...`) with 14-byte chunks, 10-packet `GET_CHECKSUM` throttling, Windows `ERASE_FLASH` tolerance, and a 2-step user-gesture modal for reboot-then-flash.
- **`webapp/src/ble/vernieClient.ts`**: Connects to the Pybricks GATT service (`c5f50001-...`), encodes/decodes the [BLE AppData Protocol](../protocol/ble-appdata.md), enforces single-in-flight multi-channel latest-value coalescing (`drive` + `head` sliders) under BlueNRG-MS Write-With-Response latency, gives `DRIVE(0,0)` urgent STOP priority ahead of queued commands, and serializes multi-chunk flash macro uploads.
- **`webapp/src/components/TelemetryHud.tsx`**: Persistent live telemetry strip showing battery voltage bar, active mode, torso IMU pitch/roll + `PICKED UP`/`BUMP`/`TAP/BTN` badges, 88007 chest distance/color, wheel & head encoders, dart/synth pills, Watchdog Safe Mode lockout banner, and one-click urgent `STOP`.
- **`webapp/src/components/DrivePad.tsx`**: Tactile tank drive panel combining a touch/mouse arcade joystick (`mixArcadeToTank`), WASD/Arrow keys, Spacebar urgent STOP, HTML5 Gamepad API polling, speed-cap slider (`25%..100%`), D-pad pulses, and a 16 Hz coalesced dead-man stream that stops motors immediately on release, window blur, or tab switch.
- **`webapp/src/components/HeadAndDart.tsx`**: Non-trigger stall homing (`-180°/s`, 28% duty), 5 eyebrow presets (`-35°..+35°`), coalesced head slider (all angle controls strictly locked until `HEAD_HOMED`), and a 2-step Arm (`0xA5`) / Fire / Disarm dart panel gated on `dartArmed && headHomed && !pickedUp`.
- **`webapp/src/components/MotorSynthPad.tsx`**: 2-voice bipolar singing-motor controller with Auto/V1/V2 routing, 150/280/500 ms note lengths, 7 R2-D2 SFX soundboard buttons, 13-key chromatic piano (`C5–C6`, MIDI `72–84`), Stop Synth, Move Hub RGB swatches + custom color picker, and 88007 4-state chest LED controls.
- **`webapp/src/components/ModeAndMacros.tsx`**: 5-mode Autonomous Brain switcher (`0..4`) plus a Visual Flash Macro Composer (`0x07 -> FLASH_USER_1`) supporting preset routines (`Victory Dance`, `Desk Patrol`, `R2-D2 Greeting`), custom `DRIVE`/`HEAD`/`SYNTH`/`LED`/`WAIT` step authoring with wire-protocol clamping, reordering, live `steps/46 · bytes/232 B` budget badge, and offline Yellow-Card persistence.
- **`webapp/src/components/FirmwareUpdater.tsx`**: Chromebook bring-up UI for 1-click flashing of CI-published `firmware.bin`, local `.bin` zero-sum validation, and `0x05` reboot-to-bootloader recovery (see [Flashing & Recovery Playbook](../playbooks/flashing-and-recovery.md)).

# Browser Compatibility Notes

- **Supported:** ChromeOS (Chromebook), Chrome & Edge on Windows, macOS, Linux, and Android over HTTPS or `localhost`.
- **Unsupported:** iOS Safari does not expose `navigator.bluetooth`; the UI detects missing Web Bluetooth and displays clear guidance.

[^web-bt-spec]: W3C Web Bluetooth specification requiring HTTPS and user gesture for `requestDevice()`
