---
type: Playbook
title: Bench Calibration & Hardware Acceptance Tests
description: Safe physical bench verification procedures for Move Hub head homing, zero-creep singing-motor synth, LIS3DH torso IMU, 88007 sensor, and FLASH_USER_1 macro persistence.
tags: [playbook, calibration, testing, safety, hardware]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T16:42:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T16:42:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: vernie-hw-c
    resource: ../../firmware/src/vernie_hw.c
    title: Vernie OS Hardware Abstraction & Non-Trigger Head Homing
    author: human:jpdsmith
  - id: vernie-synth-c
    resource: ../../firmware/src/vernie_synth.c
    title: Vernie OS 2-Voice Symmetrical Bipolar Singing-Motor Synth
    author: human:jpdsmith
---

# Safety Prerequisites

1. **Remove the dart projectile** before running initial bench calibration (T5.1–T5.7).
2. Place Vernie on a flat, clear desk with at least `50 cm` clearance and fresh 6× AAA batteries (`>= 7,500 mV` reported in the Cockpit HUD).
3. Flash the latest verified `vernie-os-0.3.1` firmware via [Chromebook Flashing & Brick Recovery](flashing-and-recovery.md).

# Step-by-Step Physical Bench Acceptance

## 1. Auto-Boot & Live Telemetry (T5.1)
1. Tap the green hub button once; confirm Vernie plays the startup chime and LED breathes blue (Mode 0).
2. Open the Chromebook Cockpit and click **Connect to VernieOS**.
3. Verify battery voltage (`6,000–9,200 mV`), `8–10 Hz` telemetry rate, `SENSOR_OK`, and `DISARMED` dart lock badge.

## 2. Unloaded Single-Direction Head Homing (T5.2)
1. Switch to **Mode 4 (Remote Cockpit)** and confirm `-35°`/`0°`/`+35°` and the head slider are disabled until homed, then click **Home Head (Non-Trigger)** (`0x02`, sentinel `0x7F`).
2. Confirm the 88008 head motor gently seeks strictly in the **negative (non-trigger) direction** at `-180 deg/s` and `<= 28%` duty, backs off to `0°`, and flips the HUD badge from `UNHOMED` to `HOMED` without clicking or firing the launcher cam.[^vernie-hw-c]
3. Sweep the head slider across `-40°..+35°` and verify smooth tracking and hard software clamping.

## 3. Zero-DC-Creep Singing-Motor Synth (T5.3)
1. Click **Boot Chime**, **Happy Chirp**, **Victory**, and individual MIDI notes (`C5`, `E5`, `G5`, `C6`) on both **V1 Tracks (TIM1)** and **V2 Head (TIM3)**.
2. Confirm clean audible pitch with **zero track rolling or head drift** during playback, and verify tracks immediately resume normal proportional driving when clicking **Forward** / **Reverse** (confirming exact 12 kHz timer restoration).[^vernie-synth-c]

## 4. Upright Torso IMU Pickup, Bump & Double-Tap (T5.4)
1. While Vernie stands upright on the desk, confirm pitch & roll read near `0°` and the HUD displays `UPRIGHT`.
2. Switch to **Mode 1 (Room Explorer)** and lift Vernie off the desk (tilting `> 35°` or sustained lift impulse): confirm tracks **coast immediately**, hub LED flashes red, head shakes, and alarm squawk sounds.
3. Place Vernie back down motionless (`>= 250 ms`) and double-tap the torso firmly: confirm mode cycles cleanly to the next mode with a confirmation tick.

## 5. 88007 Chest Sensor, Color Cards & Flash Macro Persistence (T5.5)
1. Switch to **Mode 3 (Color Cards)**. Hold a **Green** LEGO brick at `~15 cm` (`> 25%` distance) — confirm Vernie ignores it.
2. Bring the **Green** brick within `~3 cm` (`<= 25%`) for `>= 250 ms` — confirm Vernie cheers and drives forward.
3. In the Cockpit, select **Victory Dance** and click **Save to Flash (Yellow Card)**.
4. Disconnect BLE, power-cycle Vernie (2 s hold off, tap on), cycle to **Mode 3**, and hold a **Yellow** brick close (`<= 25%`, `>= 250 ms`) — confirm the saved macro replays cleanly from `FLASH_USER_1`.

## 6. Two-Step Dart Launcher Interlock (T5.6 — Optional, Eye Protection!)
1. Aim Vernie safely away from people and pets. Confirm **Fire Dart** stays disabled until **both** `HEAD_HOMED` and **Arm Lock (`0xA5`)** are active.
2. Click **Arm Lock (`0xA5`)** then **Fire Dart**: confirm a single firing sweep occurs, head returns to `0°`, and the HUD automatically reverts to **`DISARMED`**.[^vernie-hw-c]

[^vernie-hw-c]: `firmware/src/vernie_hw.c` — non-trigger homing (`-180 deg/s`, `28%` duty) and auto-disarming dart sweep
[^vernie-synth-c]: `firmware/src/vernie_synth.c` — symmetrical bipolar 3-level PWM with `<= 15%` duty and `>= 70%` dead-band
