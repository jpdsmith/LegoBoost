---
type: Playbook
title: Chromebook Flashing & Brick Recovery
description: Step-by-step wireless Web Bluetooth flashing from ChromeOS, 2-step OTA re-flashing, and unbrickable official LEGO firmware recovery.
tags: [playbook, chromebook, flashing, recovery, bootloader]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-install-guide
    resource: https://pybricks.com/learn/getting-started/install-pybricks/
    title: Pybricks Move Hub bootloader entry and official firmware restore guide
    author: team:pybricks
---

# Pre-Flight Checklist

1. Install **fresh 6× AAA batteries** (target idle voltage `>= 7,500 mV`).
2. Keep the dart **unloaded** during Phase 1–2 calibration.
3. Open the Vernie Cockpit GitHub Pages URL in **Chrome on your Chromebook** (HTTPS required for Web Bluetooth; do not use Crostini Linux for BLE).

# Mandatory First-Time Recovery Drill

Before flashing custom firmware the first time, verify the non-erasable LEGO bootloader works on your Chromebook:

1. With Vernie powered off, **press and hold the green button for ~5 seconds** until the LED flashes **red / green / blue** (LEGO Bootloader mode).[^pybricks-install-guide]
2. Open [code.pybricks.com](https://code.pybricks.com/) → **Tools (gear)** → **Restore official LEGO firmware** → select **BOOST Move Hub** to confirm Chrome discovers `LEGO Bootloader`.[^pybricks-install-guide]

# Flashing Vernie OS from Chromebook

## Method A — Built-In Browser Flasher (Recommended)

1. Open the hosted [Vernie Web Cockpit](../architecture/web-cockpit.md) in Chrome.
2. Put Vernie into bootloader mode (hold green button 5 seconds until red/green/blue blink) — or if already running Vernie OS, click **Step 1: Reboot to Bootloader (`0x05`)** while connected.
3. Click **Step 2: Select `LEGO Bootloader` & Flash** (follows [LWP3 Bootloader Protocol](../protocol/lwp3-bootloader.md)).
4. Wait ~30–45 seconds until progress reaches 100%; Vernie auto-reboots into breathing LED mode and immediately advertises over BLE.

## Method B — `code.pybricks.com` Custom Firmware Zip

1. Download `firmware.zip` (v2.0.0 metadata, unchecksummed base) from GitHub Releases or the Cockpit page.
2. Open [code.pybricks.com](https://code.pybricks.com/) → **Tools** → **Install Pybricks Firmware** → **Advanced** → pick `firmware.zip` and follow the prompts.[^pybricks-install-guide]

# Restoring Official LEGO Firmware Anytime

Because the 20 KB bootloader at `0x08000000` is write-protected ([Move Hub Hardware](../hardware/move-hub.md)), you can always hold the green button for 5 seconds at power-on and run **Restore official LEGO firmware** at [code.pybricks.com](https://code.pybricks.com/).[^pybricks-install-guide]

[^pybricks-install-guide]: Pybricks official Move Hub installation & recovery instructions
