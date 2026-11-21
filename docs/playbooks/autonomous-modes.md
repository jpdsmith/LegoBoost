---
type: Playbook
title: Autonomous Modes & Flash Macro Guide
description: Standalone operation of Vernie OS Modes 0–4 without a phone or browser, plus Yellow-card FLASH_USER_1 macro playback and dart safety rules.
tags: [playbook, autonomous, modes, macros, color-cards, sentry]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T16:42:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T16:42:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: vernie-modes-c
    resource: ../../firmware/src/vernie_modes.c
    title: Vernie OS Autonomous Brain State Machines (Modes 0..4)
    author: human:jpdsmith
  - id: vernie-macro-c
    resource: ../../firmware/src/vernie_macro.c
    title: Vernie OS Chunked Flash Macro Engine (0x07 MACRO_OP)
    author: human:jpdsmith
---

# Standalone Power-On & Mode Cycling

Vernie OS boots immediately into standalone autonomous operation (no Chromebook or app needed):[^vernie-modes-c]

- **Power on:** Tap the green Move Hub button once; Vernie plays the startup boot chime and enters **Mode 0 (Living Pet)**.
- **Cycle standalone modes (`0 -> 1 -> 2 -> 3 -> 0`):** Short-press the green hub button, OR **double-tap Vernie's torso** while stationary (gated by `>= 250 ms` stationary window so driving vibrations never false-trigger), OR select any mode (`0..4`) in the [Web Cockpit](../architecture/web-cockpit.md).
- **Power off:** Hold the green hub button for **2 seconds** (coasts all motors, stops synth, and flushes any pending `FLASH_USER_1` save).

# Mode Reference

| Mode | Hub LED Color | Standalone Behavior | Safety Invariants |
| :---: | :--- | :--- | :--- |
| **0 — Living Pet** | Breathing Blue (`215°`) | Periodic curious head looks & R2-D2 chirps every 4.5 s; playful 400 ms reverse + chirp when a hand approaches `<= 50%` distance. | Universal pickup reflex coasts tracks, flashes red LED, shakes head, and squawks; head moves only when homed. |
| **1 — Room Explorer** | Breathing Green (`120°`) | Cruises forward (`45%`); triggers obstacle avoidance on **either** 88007 proximity `<= 40%` **or** fused LIS3DH bump / motor stall → backs up `450 ms`, scans head `-35°` and `+35°`, and pivots toward the clearer side (alternates on tie). | Universal pickup reflex; never drives while picked up; any BLE `DRIVE`/`STOP` immediately switches to Mode 4. |
| **2 — Desk Sentry** | Breathing Red (`0°`) | Interleaves a `200 ms` red 88007 chest LED glow with `800 ms` `SPEC1` sensing windows while scanning head `±30°`. Locks onto targets `<= 45%` for `1.5 s` with warning siren, then engages. | **Disarmed by default!** Disarmed engage performs a safe track wiggle + laser SFX. Dart fires **only** if explicitly armed via BLE (`0x03`, `0xA5`), head is homed, and Vernie is not picked up, then auto-disarms. |
| **3 — Color Cards** | Breathing Yellow (`50°`) | Watches for LEGO color bricks/cards held **close (`<= 25%`) for `>= 250 ms`** to eliminate ambient false triggers: **Green** = drive forward & cheer, **Red** = spin & squawk, **Blue** = dance & victory chiptune, **Yellow** = run saved `FLASH_USER_1` macro. | `1.5 s` post-action cooldown; bump stops Green forward run early. |
| **4 — Remote Cockpit** | Breathing Purple (`285°`) | Autonomous brain yields cleanly (`active = false`) to Web Bluetooth joystick, head, synth, LED, and macro commands. | Reverts automatically to Mode 0 (Pet) if BLE disconnects; dead-man drive timer coasts tracks after `100–1000 ms`. |

# Offline Flash Macros (`FLASH_USER_1`)

Macros are compact **5-byte bytecode steps** (up to **46 steps / 232 bytes**) stored in the unchecked `FLASH_USER_1` page (`0x0801F800`) with an IEEE CRC32 integrity check.[^vernie-macro-c]

1. Connect via Chrome on your Chromebook, select a preset (e.g. **Victory Dance**, **Desk Patrol**, or **R2-D2 Greeting**), and click **Save to Flash (Yellow Card)**.
2. Vernie flushes `FLASH_USER_1` safely once all motors and synth voices are idle (`FLASH_USER_0` is never touched).
3. Disconnect BLE (or power-cycle Vernie!), switch to **Mode 3 (Color Cards)**, and hold a **Yellow** LEGO brick close to Vernie's chest sensor for `>= 250 ms` to replay the saved macro completely offline.
4. **Safety:** The macro bytecode ISA intentionally has **no dart-fire opcode**. Any macro aborts and coasts immediately if Vernie is picked up, enters Watchdog Safe Mode, switches modes, or receives a manual BLE drive command.[^vernie-macro-c]

[^vernie-modes-c]: `firmware/src/vernie_modes.c` — cooperative 50 Hz autonomous state machines
[^vernie-macro-c]: `firmware/src/vernie_macro.c` — chunked `0x07 MACRO_OP` sequencer and `FLASH_USER_1` staging
