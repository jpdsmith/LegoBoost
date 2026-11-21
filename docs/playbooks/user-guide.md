---
type: Playbook
title: Vernie OS User Guide
description: Complete end-to-end guide for installing Vernie OS on a LEGO BOOST Move Hub (88006), driving, playing motor music, building offline macros, using Vision & Voice, troubleshooting, and restoring factory firmware.
tags: [playbook, user-guide, getting-started, chromebook, android, vernie]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T21:20:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T21:20:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: vernie-cockpit-app
    resource: ../../webapp/src/App.tsx
    title: Vernie OS 5-Tab Web Bluetooth Cockpit PWA
    author: human:jpdsmith
  - id: vernie-firmware-main
    resource: ../../firmware/src/main.c
    title: Vernie OS Bare-Metal Firmware Main Loop
    author: human:jpdsmith
  - id: pybricks-code
    resource: https://code.pybricks.com/
    title: Pybricks Code Official LEGO Firmware Restoration Tool
    author: team:pybricks
---

# Welcome to Vernie OS

**Vernie OS** replaces the stock firmware on your **LEGO® BOOST Move Hub (88006)** with fast, standalone robotics firmware and a zero-install Web Bluetooth controller app. You can play completely offline with built-in autonomous personalities and LEGO color cards, or connect from a Chromebook, Android phone, or laptop browser to drive, compose music on the motors, program offline macros, and use webcam/voice tracking.[^vernie-cockpit-app]

> **Unbrickable Guarantee:** The LEGO factory bootloader at the start of flash memory is hardware-protected and never overwritten. You can restore official LEGO BOOST firmware at any time in under a minute.

---

# 1. What You Need

| Requirement | Details |
| :--- | :--- |
| **Hardware** | LEGO® BOOST Move Hub (`88006`) — works in the official **Vernie (Set 17101)** build *or* custom horizontal rovers/cars. Optional: `88008` Interactive Motor and `88007` Color & Distance Sensor plugged into **Port C** or **Port D** (either order — Vernie OS auto-detects both!). |
| **Batteries** | **6× fresh AAA batteries** (`> 7.2 V`). Low batteries can cause Bluetooth drops while flashing. |
| **Browser** | **Google Chrome** or **Microsoft Edge** on **ChromeOS (Chromebook)**, **Android**, **Windows**, **macOS**, or **Linux**. *(iOS Safari does not support Web Bluetooth.)* |
| **Web App URL** | Open **[https://jpdsmith.github.io/LegoBoost/](https://jpdsmith.github.io/LegoBoost/)** — no downloads, drivers, or Linux terminal needed. You can also click Chrome's **Install App** icon to pin **Vernie OS** like a native app. |

---

# 2. First-Time Install & Updates

## Installing Vernie OS (From Stock LEGO Firmware)

1. Open **[https://jpdsmith.github.io/LegoBoost/](https://jpdsmith.github.io/LegoBoost/)** and switch to the **Flasher & Recovery** tab. Confirm the card shows the latest verified release (e.g., `vernie-os-0.3.2`).
2. Make sure the Move Hub is **turned off**.
3. **Press and hold the green hub button** for ~5–10 seconds until the hub LED flashes **Red → Green → Blue** (Bootloader Update Mode), then release the button.
4. Click **Flash Firmware** in the browser, select **`LEGO Bootloader`** in the Bluetooth pairing popup, and wait ~20 seconds while the progress bar reaches 100%.
5. When flashing finishes, the hub reboots automatically, plays a **4-note rising startup chime**, and starts breathing **Blue** (Living Pet mode).

## Updating Vernie OS Later (Wireless OTA)

1. Click **Connect to VernieOS** in the top Telemetry bar.
2. Open the **Flasher & Recovery** tab and click **Step 1: Send Software Reboot**.
3. Wait 2 seconds for the hub LED to flash **Red → Green → Blue**, then click **Step 2: Flash Firmware** and pick **`LEGO Bootloader`**.

For deeper recovery steps, see the [Chromebook Flashing & Brick Recovery Playbook](flashing-and-recovery.md).

---

# 3. Lights, Sounds, Buttons & Orientation

## Why Does the Hub Beep? (It Has No Speaker!)

The Move Hub has **no physical speaker or buzzer**. Vernie OS creates sound by sending symmetrical high-frequency pulses into the motor coils so they vibrate cleanly without spinning the wheels:[^vernie-firmware-main]

- **Rising 4-note chime (`C5 → E5 → G5 → C6`):** Healthy power-on confirmation!
- **Single short high chirp:** Mode switched.
- **Two-tone alarm squawk:** Pickup reflex triggered in an autonomous mode (put the robot down flat/upright to stop it).
- **No startup chime + alternating Red/Blue LED:** Watchdog Safe Mode (see [Troubleshooting](#7-troubleshooting--faq)).

## Green Button & Double-Tap Controls

| Action | What It Does |
| :--- | :--- |
| **Tap once (from off)** | Powers on Vernie OS into **Mode 0 (Living Pet)**. |
| **Short press (`< 0.8 s`)** | Cycles standalone modes: `0 (Pet) → 1 (Explorer) → 2 (Sentry) → 3 (Color Cards) → 0`. |
| **Double-tap the hub while still** | Same as a short press — cycles Modes `0–3` hands-free (ignored while driving so bumps don't false-trigger). |
| **Hold ~2–3 seconds** | Clean shutdown (coasts motors, saves any pending flash macro, powers off). |
| **Hold ~5–10 seconds (from off)** | Enters **LEGO Bootloader** mode (Red/Green/Blue flash) for flashing or factory recovery. |

## Hub LED Color Guide

| LED Pattern | Meaning |
| :--- | :--- |
| **Breathing Blue** | Mode 0 — **Living Pet** |
| **Breathing Green** | Mode 1 — **Room Explorer** |
| **Breathing Red** | Mode 2 — **Desk Sentry** |
| **Breathing Yellow** | Mode 3 — **Color-Card Commander** |
| **Breathing Purple** | Mode 4 — **Remote Cockpit** (connected to browser) |
| **Flashing Red (fast)** | Pickup alert (tilted > 35° or lifted in Modes 0–3) |
| **Alternating Red / Blue** | **Watchdog Safe Mode** — motors locked out until reboot/re-flash |
| **Flashing Red / Green / Blue** | **LEGO Bootloader** — ready for wireless flashing |

## Works Upright *or* Flat (Auto-Orientation)

Rest your robot in its normal driving pose (**upright Vernie** *or* **flat 4-wheel horizontal rover**) when you tap the green button. After **~0.2 seconds** of sitting still, Vernie OS automatically detects which face is pointing up and sets `0° / 0° (UPRIGHT)` for that session — so autonomous modes and pickup detection work on both vertical and horizontal builds. Manual **Tank Drive** (Mode 4) works in **any** orientation, even while tilted or held in your hand.

---

# 4. Using the 5-Tab Web Cockpit

Click **Connect to VernieOS** at the top of the page and pick **`VernieOS`** in the Bluetooth popup. The **Live Telemetry Strip** stays visible across every tab, showing live battery voltage, active mode, IMU tilt & badges (`UPRIGHT`/`PICKED UP`, `BUMP`, `TAP/BTN`), 88007 chest distance & color, wheel/head encoders, Dart/Synth pills, and a red **STOP** button that halts everything immediately.

## Tab 1 — Drive & Head

- **Tank Drive Pad:**
  - Drag the **virtual joystick** with mouse or touch, tap the **D-pad** buttons, use **WASD / Arrow keys**, or plug in any **USB/Bluetooth Gamepad**.
  - Adjust **Speed Limit (`25%–100%`)** for smooth indoor driving.
  - Press **Spacebar** or click **STOP** at any time to immediately coast the wheels and abort any running macro or autonomous mode. Switching tabs or releasing the joystick stops the motors automatically.
- **Head, Eyebrows & Dart Launcher** *(requires external `88008` motor on Port C or D)*:
  1. **Remove any loaded dart first**, then click **Home Head (Non-Trigger)**. Vernie turns gently away from the dart trigger until he finds the mechanical stop, backs off to center (`0°`), and displays **`HEAD HOMED`**.
  2. Once homed, use the **5 Eyebrow Poses (`-35°` to `+35°`)** or the **Head Target Slider** to move Vernie's head and eyebrows safely without tripping the launcher. *(Angle controls stay locked until Homed to prevent accidental shots.)*
  3. **Firing the Dart (2-Step Safety Interlock):** Click **Arm Lock (0xA5)**, verify Vernie is upright and aimed safely, then click **Fire Dart**. The launcher **always boots disarmed** and **auto-disarms** immediately after firing, on disconnect, or if picked up.

## Tab 2 — Motor Synth & LEDs

- **2-Voice Singing-Motor Synth:**
  - Pick **Voice Routing**: `Auto (Free Voice)`, `V1 Tracks` (internal motors), or `V2 Head` (external head motor — only active when a confirmed `88008` motor is detected).
  - Pick note length (`150 ms`, `280 ms`, or `500 ms`), play the **13-key Chromatic Piano (`C5–C6`)**, or fire **7 R2-D2 Sound Effects** (`Boot Chime`, `Happy Chirp`, `Curious Beep`, `Alarm Squawk`, `Warning Siren`, `Laser Zap`, `Victory`).
  - Click **Stop Synth** to silence immediately. Continuous playback automatically pauses after 3 seconds to keep motor coils cool.
- **Hub RGB & Chest LED:**
  - Tap a Hub RGB preset swatch or pick any **Custom** hex color.
  - Use **88007 Chest Sensor LED** (`Blue`, `Green`, `Red`) to light up the chest sensor. Tap **Chest: Off (Sense)** when you want color and distance readings to resume (the 88007 hardware cannot glow a fixed color and sense at the exact same instant).

## Tab 3 — Modes & Macros

- **Autonomous Brain Modes:** Click any of the 5 mode cards (`Living Pet`, `Room Explorer`, `Desk Sentry`, `Color Cards`, `Remote Cockpit`) to switch live.
- **Visual Flash Macro Composer:**
  1. Start from a built-in routine (**Victory Dance**, **Desk Patrol**, **R2-D2 Greeting**) or click **Empty Sequence**.
  2. Add steps (`DRIVE`, `HEAD`, `SYNTH`, `LED`, or `WAIT`) with custom speeds/angles/durations, reorder with `↑` / `↓`, or remove with `×` (up to **46 steps / 232 bytes**; by design, macros cannot fire the dart launcher).
  3. Click **Upload & Play** to test live, or **Save to Flash (Yellow Card)** to store the routine permanently inside the hub so a Yellow LEGO brick can play it completely offline!
  4. Use **Play Saved**, **Stop Macro**, or **Clear Flash Macro** at any time.

## Tab 4 — Vision & Voice Backpack

Runs **100% locally in your browser** (zero cloud keys or external downloads) using either your **Chromebook webcam** (`Front`) or an **Android phone strapped to Vernie's back** (`Rear`):

- **Vision Backpack:**
  1. Click **Start Camera**, choose a **Detector** (`Motion & Wave` or `Red / Green / Blue / Yellow` LEGO brick), and choose a **Behavior**:
     - **Head Follow:** Smoothly pans Vernie's head to track the target *(requires `HEAD HOMED`)*.
     - **Body Follow:** Turns and gently drives toward the target while automatically stopping if the 88007 chest sensor spots an obstacle (`≤ 35%`) or Vernie is picked up.
     - **Wave React:** Watches for a hand wave and replies with a Happy Chirp, Emerald LED, and spoken greeting.
  2. Toggle **Stream BLE commands to Vernie** on when ready. Switching tabs or clicking **Stop Camera** releases the camera and stops motors immediately.
  3. No camera handy? Use the **Simulated Target Test** buttons (`Target Left`, `Target Right`, `Simulate Wave`) to test the pipeline.
- **Voice Assistant:**
  - Click **Start Microphone** (in Chrome/Edge) *or* type into the offline command box / tap a **Quick Voice Prompt**. Toggle **Speak replies (TTS)** for spoken feedback.
  - Supported phrases include: `"hello vernie"`, `"forward"`, `"reverse"`, `"turn left"`, `"turn right"`, `"home head"`, `"look left"`, `"look right"`, `"look center"`, `"dance"`, `"laser"`, `"siren"`, `"play macro"`, `"pet mode"`, `"explorer mode"`, `"sentry mode"`, `"color mode"`, `"remote mode"`, and **`"stop"`** (always works, even in Safe Mode).
  - **Safety rule:** Saying `"fire"`, `"shoot"`, or `"launch dart"` is **permanently blocked** over voice — dart firing always requires the manual 2-step interlock in Tab 1.

## Tab 5 — Flasher & Recovery

- Wireless **OTA updates** to new Vernie OS releases.
- **Custom `.bin` flashing** for developers testing local firmware builds (verified automatically against the 108,544-byte Move Hub checksum before flashing).
- **Official LEGO Restore** instructions (see below).

---

# 5. Playing Completely Offline (No Browser Needed)

Turn the hub on with the green button and cycle modes with a short press or double-tap (for full technical details, see [Autonomous Modes & Flash Macro Guide](autonomous-modes.md)):

- **Mode 0 — Living Pet (Blue):** Looks around, chirps every few seconds, backs away playfully if you put a hand near his chest, and squawks if picked up.
- **Mode 1 — Room Explorer (Green):** Cruises forward, stops on obstacles (88007 proximity, bump, or stalled wheel), backs up, scans left/right, and turns toward the open path.
- **Mode 2 — Desk Sentry (Red):** Pulses his red chest light while scanning. Locks onto an intruder with a warning siren; performs a safe wiggle + laser sound unless explicitly armed via BLE.
- **Mode 3 — Color Cards (Yellow):** Hold a LEGO brick **very close (`≤ 25%`) for ~0.3 seconds** in front of the 88007 sensor:
  - **Green brick:** Drive forward & cheer
  - **Red brick:** Spin & squawk
  - **Blue brick:** Victory dance & chiptune
  - **Yellow brick:** Run your saved **Flash Macro**!

---

# 6. Restoring Official LEGO® BOOST Firmware

Want to go back to the official LEGO BOOST app at any time?

1. Turn the hub off, then hold the green button (~5–10 s) until it flashes **Red → Green → Blue**.
2. Open **[https://code.pybricks.com/](https://code.pybricks.com/)** in Chrome/Edge.[^pybricks-code]
3. Click the **Settings (gear)** icon → **Restore Official LEGO Firmware** → pick **`LEGO Bootloader`**.
4. Wait ~30 seconds — your Move Hub is 100% back to factory LEGO firmware.

---

# 7. Troubleshooting & FAQ

| Symptom | Cause & Fix |
| :--- | :--- |
| **`VernieOS` doesn't appear when connecting** | Make sure the hub is powered on (LED breathing Blue/Green/Red/Yellow, not off or flashing rainbow). Close any other browser tab or LEGO app already connected to the hub. |
| **Flashing fails or disconnects during erase** | Replace with **6× fresh AAA batteries** (`> 7.2 V`). Stay within ~1 meter of the computer and avoid touching the hub button while the progress bar is moving. |
| **Head buttons / slider or `Fire Dart` are greyed out** | Click **Home Head (Non-Trigger)** first until the pill reads **`HEAD HOMED`**. For **Fire Dart**, you must also click **Arm Lock (0xA5)** and keep Vernie upright (`UPRIGHT`). |
| **88007 Chest Distance says `N/A`** | Either the 88007 sensor is unplugged, or you turned on a Chest LED color (`Blue`/`Green`/`Red`). Open **Motor Synth & LEDs** and click **Chest: Off (Sense)** to resume distance and color readings. |
| **LED flashes Red / Blue rapidly & controls are locked** | **Watchdog Safe Mode** triggered after a firmware hang or brownout. Open **Flasher & Recovery**, click **Send Software Reboot** (or power-cycle via the green button), and check battery voltage. |
| **Autonomous mode immediately squawks `PICKED UP`** | Set the robot down in its normal resting pose *before* pressing the green button so the 0.2 s auto-orientation locks the right face. (Manual **Tank Drive Pad** always works regardless of orientation!) |
| **Want to attach an ESP32-S3 camera or MP3 speaker?** | See [Optional Port C & D Raw UART Hardware Expansion](../hardware/uart-expansion.md) for verified wiring and 3.3 V safety limits. |

[^vernie-cockpit-app]: `webapp/src/App.tsx` — Vernie OS 5-tab Chromebook/Android Web Bluetooth Cockpit PWA
[^vernie-firmware-main]: `firmware/src/main.c` — Vernie OS cooperative 50 Hz bare-metal firmware loop
[^pybricks-code]: Pybricks Code browser utility supporting official LEGO BOOST Move Hub firmware restore
