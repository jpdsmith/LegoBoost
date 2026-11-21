---
type: Architecture Spec
title: Vernie Web Cockpit & Flasher PWA
description: Chromebook-first React/TypeScript Web Bluetooth app providing direct LWP3 bootloader flashing, live telemetry, and robot control via GitHub Pages.
resource: ../../webapp/src/App.tsx
tags: [webapp, web-bluetooth, chromebook, pwa, react]
status: draft
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: web-bt-spec
    resource: https://webbluetoothcg.github.io/web-bluetooth/
    title: Web Bluetooth Community Group Specification
    author: team:w3c-web-bluetooth
---

# Overview

The Vernie Web Cockpit is a static Vite + React + TypeScript PWA deployed to GitHub Pages so a Chromebook (or any Chrome/Edge desktop or Android device) can flash and control Vernie with zero local installs or Crostini Linux Bluetooth passthrough.[^web-bt-spec]

# Modules

- **`webapp/src/ble/lwp3Flasher.ts`**: Implements the [LWP3 Bootloader Protocol](../protocol/lwp3-bootloader.md) over Web Bluetooth (`00001625-...` / `00001626-...`) with 14-byte chunks, 10-packet `GET_CHECKSUM` throttling, Windows `ERASE_FLASH` tolerance, and a 2-step user-gesture modal for reboot-then-flash.
- **`webapp/src/ble/vernieClient.ts`**: Connects to the Pybricks GATT service (`c5f50001-...`), encodes/decodes the [BLE AppData Protocol](../protocol/ble-appdata.md), and enforces single-in-flight latest-value coalescing under BlueNRG-MS Write-With-Response latency.
- **`webapp/src/components/FirmwareUpdater.tsx` & `TelemetryHud.tsx`**: Phase 1 Chromebook bring-up UI for 1-click flashing, live battery/button/safe-mode/encoder telemetry, LED override tests, and `0x05` reboot-to-bootloader recovery (see [Flashing & Recovery Playbook](../playbooks/flashing-and-recovery.md)).

# Browser Compatibility Notes

- **Supported:** ChromeOS (Chromebook), Chrome & Edge on Windows, macOS, Linux, and Android over HTTPS or `localhost`.
- **Unsupported:** iOS Safari does not expose `navigator.bluetooth`; the UI detects missing Web Bluetooth and displays clear guidance.

[^web-bt-spec]: W3C Web Bluetooth specification requiring HTTPS and user gesture for `requestDevice()`
