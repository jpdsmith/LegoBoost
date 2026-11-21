---
type: Playbook
title: Vernie OS User Guide
description: Plain-English owner's guide for installing Vernie OS on a LEGO BOOST Move Hub, driving, calibrating the head and dart launcher, playing motor music, building saved routines, using camera and voice controls, troubleshooting, and returning to the official LEGO app.
tags: [playbook, user-guide, getting-started, chromebook, android, vernie]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T21:30:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T21:30:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: vernie-cockpit-app
    resource: ../../webapp/src/App.tsx
    title: Vernie OS Web Bluetooth Cockpit App
    author: human:jpdsmith
  - id: vernie-firmware-main
    resource: ../../firmware/src/main.c
    title: Vernie OS Firmware Main Loop
    author: human:jpdsmith
  - id: pybricks-code
    resource: https://code.pybricks.com/
    title: Pybricks Code Official LEGO Firmware Restoration Tool
    author: team:pybricks
---

# Welcome to Vernie OS

**Vernie OS** gives your **LEGO® BOOST Move Hub** a brand-new brain and a browser-based remote control.[^vernie-cockpit-app] Once installed, your robot can roam and react completely on its own (no tablet or phone needed), or connect wirelessly to a Chromebook, Android phone, or computer browser for live driving, music, custom routines, and camera/voice tricks.

> **Safe to Try:** The Move Hub's built-in factory update system is permanent and cannot be erased. You can switch back to the official LEGO® BOOST app at any time in less than a minute.

---

# 1. What You Need

- **A LEGO® BOOST Move Hub** — works in the official **Vernie** robot *or* any custom car/rover build.
  - Have the extra head motor or the color & distance sensor? Plug them into **Port C** and **Port D** in **either order** — Vernie automatically detects which port has which part.
- **6 fresh AAA batteries** — fresh batteries matter most while installing updates (weak batteries can cause Bluetooth to drop partway through).
- **Google Chrome or Microsoft Edge** on a **Chromebook**, **Android phone/tablet**, **Windows PC**, **Mac**, or **Linux** computer. *(Note: iPhone and iPad Safari do not support browser Bluetooth yet.)*
- **The Web Remote:** Open **[https://jpdsmith.github.io/LegoBoost/](https://jpdsmith.github.io/LegoBoost/)** — nothing to download or install. *(Tip: In Chrome, you can tap the **Install App** button in the address bar to add **Vernie OS** right to your home screen or shelf.)*

---

# 2. Installing & Updating Vernie OS

## First-Time Install (From Stock LEGO Software)

1. Open **[https://jpdsmith.github.io/LegoBoost/](https://jpdsmith.github.io/LegoBoost/)** and open the **Flasher & Recovery** tab.
2. Make sure your Move Hub is **turned off**.
3. **Press and hold the green button** on the hub for about **5–10 seconds** until the light flashes **Red → Green → Blue**, then let go. *(This is Update Mode.)*
4. Click **Flash Firmware** in the browser, choose **`LEGO Bootloader`** in the Bluetooth popup, and wait about 20 seconds while the bar fills to 100%.
5. When it finishes, the hub restarts on its own, plays a **4-note rising chime**, and glows softly **Blue**. You're ready to play!

## Updating to a Newer Version Later

1. Click **Connect to VernieOS** at the top of the page.
2. Open the **Flasher & Recovery** tab and click **Step 1: Send Software Reboot**.
3. Wait 2 seconds for the light to flash **Red → Green → Blue**, then click **Step 2: Flash Firmware** and pick **`LEGO Bootloader`**.

*(Need detailed recovery help? See the [Flashing & Recovery Playbook](flashing-and-recovery.md).)*

---

# 3. Lights, Sounds & the Green Button

## Why Does It Beep? (It Doesn't Have a Speaker!)

The LEGO Move Hub has **no physical speaker**. Vernie OS makes sounds by gently vibrating the coils inside the motors — using balanced pulses so they sing without turning the wheels:[^vernie-firmware-main]

- **4-note rising chime:** Everything started up normally!
- **Quick single chirp:** You switched to the next mode.
- **Two-tone squawk:** Vernie thinks he's been picked up or tipped over in an autonomous mode (set him back down to stop it).
- **Silent + rapid Red/Blue flashing:** Safety Mode activated after a glitch or weak-battery reset (see [Common Questions](#7-common-questions--quick-fixes)).

## Green Button & Tap Controls

| What You Do | What Happens |
| :--- | :--- |
| **Tap the green button once** | Turns the robot on (starts in **Living Pet** mode). |
| **Quick press** *(or **double-tap** the robot while it is sitting still)* | Switches between the 4 standalone modes (Blue → Green → Red → Yellow). |
| **Hold for 2–3 seconds** | Turns the robot off safely and saves any custom routine. |
| **Hold for 5–10 seconds (starting from off)** | Enters **Update Mode** (Red/Green/Blue flashing) to install updates or restore LEGO software. |

## What the Hub Light Colors Mean

| Light Color | What It Means |
| :--- | :--- |
| **Softly pulsing Blue** | **Living Pet** mode (looks around, chirps, reacts to hands) |
| **Softly pulsing Green** | **Room Explorer** mode (drives around obstacles on its own) |
| **Softly pulsing Red** | **Desk Sentry** mode (guards your desk) |
| **Softly pulsing Yellow** | **Color Cards** mode (reacts to colored LEGO bricks) |
| **Softly pulsing Purple** | **Remote Cockpit** mode (connected to your browser) |
| **Fast flashing Red** | Picked up or tipped over (motors pause automatically in standalone modes) |
| **Alternating Red & Blue** | **Safety Mode** — motors locked until you restart |
| **Flashing Red / Green / Blue** | **Update Mode** — waiting for a browser install or factory restore |

## Works Standing Up *or* Lying Flat

Whether you built **Vernie standing upright** or a **flat 4-wheel car**, just set your robot down in its normal driving position **before** tapping the green button. After sitting still for a fraction of a second, it automatically learns which side is "up" for that session — so tilt and pickup detection work accurately either way.

Manual driving in the **Drive & Head** tab always works in **any** position, even if your robot is on a ramp or in your hands.

---

# 4. Using the Web Remote (All 5 Tabs)

Tap **Connect to VernieOS** at the top of the screen and choose **`VernieOS`** in the Bluetooth popup.

The **Live Telemetry** bar stays at the top of every tab so you can always see battery level, current mode, tilt status, sensor readings, and the red **STOP** button (which halts all movement and routines right away).

---

## Tab 1 — Drive & Head

### Driving (Tank Drive Pad)
- **Touch or mouse:** Drag the round joystick in any direction. Letting go stops immediately.
- **Buttons:** Tap **Forward**, **Reverse**, **Spin Left**, **Spin Right**, or **STOP**.
- **Keyboard:** Use **W / A / S / D** or the **Arrow keys**, and press **Spacebar** anytime for an instant emergency stop.
- **Game controller:** Plug in or pair a standard USB/Bluetooth gamepad and move the left stick.
- **Speed Limit slider (`25%–100%`):** Lower this for smoother, gentler driving indoors.

### Moving the Head & Eyebrows *(and What "Home Head" Means)*

Whenever you turn the hub off, Vernie's external head motor **forgets which direction his head is facing**. On Vernie, turning the head too far to one side pulls the trigger on his shoulder dart shooter — so if Vernie guessed his starting position wrong, a normal head turn could accidentally launch a dart!

To keep that from ever happening, head positioning uses a simple one-time calibration step each time you power on:

1. **Take out any loaded dart first.**
2. Tap **Home Head (Non-Trigger)**. Vernie slowly turns his head *away* from the dart trigger until he gently feels the stopper, then moves back to straight ahead (`0°`).
3. Watch the badge at the top right of the card change from **`UNHOMED`** to **`HEAD HOMED`** — this simply means **"head position calibrated and centered!"**
4. Now all **5 eyebrow pose buttons** (`Far Left` through `Far Right`) and the **Head angle slider** unlock so you can turn his head and wiggle his eyebrows safely.

### Shooting the Dart (2-Step Safety Lock)

Vernie's dart launcher **always starts locked (Disarmed)** when turned on so it can never fire unexpectedly.

1. Make sure the head is calibrated (**`HEAD HOMED`**) and Vernie is sitting upright (**`UPRIGHT`**).
2. Tap **Arm Lock (0xA5)** to unlock the safety (the pill turns red: **`ARMED`**).
3. Aim safely and tap **Fire Dart**.
4. Right after firing — or if you pick Vernie up or disconnect Bluetooth — the safety lock automatically switches back to **`DISARMED`**. You can also tap **Disarm Lock** anytime.

---

## Tab 2 — Motor Synth & LEDs

### Playing Music & Sound Effects
- **Pick which motor sings:** Leave it on **Auto (Free Voice)**, or choose **V1 Tracks** (wheels) or **V2 Head** (external head motor).
- **Pick note length:** Choose short (`150 ms`), medium (`280 ms`), or long (`500 ms`) notes.
- **Soundboard:** Tap any of the **7 R2-D2 style sound effects** (*Boot Chime*, *Happy Chirp*, *Curious Beep*, *Alarm Squawk*, *Warning Siren*, *Laser Zap*, *Victory*).
- **Piano:** Play melodies on the **13-key keyboard** (`C5` to `C6`).
- **Stop Synth:** Silences audio immediately. *(To keep the motors cool, continuous sound automatically pauses after 3 seconds for a quick breather.)*

### Changing Lights
- **Move Hub RGB LED:** Tap a color preset or click **Custom** to pick any color you like.
- **Chest Sensor Light:** Light up the color/distance sensor **Blue**, **Green**, or **Red**.
  - **Important tip:** The sensor can't glow a solid color and measure distance/bricks at the same time. Tap **Chest: Off (Sense)** whenever you want distance and color readings back!

---

## Tab 3 — Modes & Macros

### Switching Personalities
Click any of the 5 mode cards to change what Vernie is doing right away.

### Building Saved Routines (Macros)
A **macro** is a custom playlist of actions you create and store right inside the robot's memory:

1. Start with a ready-made routine (**Victory Dance**, **Desk Patrol**, or **R2-D2 Greeting**), or click **Empty Sequence** to start from scratch.
2. Add steps using the dropdown:
   - **DRIVE:** Set Left and Right wheel speeds (`-100` to `+100`) and how long to drive.
   - **HEAD:** Set a head angle and turn speed *(remember to calibrate the head with **Home Head** first so it moves!)*.
   - **SYNTH:** Play a sound effect (`1–7`) or musical note.
   - **LED:** Change the hub light color.
   - **WAIT:** Pause for a moment.
3. Reorder steps with **`↑` / `↓`**, remove any step with **`×`** (up to 46 steps total — and for safety, routines can never fire the dart launcher).
4. Click **Upload & Play** to test it live, or click **Save to Flash (Yellow Card)** to save it permanently inside the hub. Once saved, you can turn off your browser and trigger your routine anytime offline by holding a **Yellow LEGO brick** in front of the sensor in **Color Cards** mode!

---

## Tab 4 — Vision & Voice

Turn your Chromebook webcam — or an Android phone strapped to your robot's back — into eyes and ears for Vernie! Everything runs **locally right inside your browser** (no cloud account needed).

### Camera Tracking (Vision Backpack)
1. Click **Start Camera** and choose **Front (Chromebook)** or **Rear (Phone Backpack)**.
2. Choose what the camera looks for (**Detector**):
   - **Motion & Wave:** Tracks movement and hand waves.
   - **Red / Green / Blue / Yellow Brick:** Tracks bright colored LEGO bricks or balls.
3. Choose how your robot reacts (**Behavior**):
   - **Head Follow:** Smoothly turns Vernie's head to follow the target left and right. *(Before turning this on, go to Tab 1 and click **Home Head** once so Vernie knows where center is — otherwise Head Follow pauses safely until he's calibrated.)*
   - **Body Follow:** Turns and gently drives toward the target, automatically stopping if his chest sensor spots a wall/hand nearby or if you pick him up.
   - **Wave React:** Wave your hand in front of the camera to make Vernie chirp happily, flash green, and say hello!
4. Check **Stream BLE commands to Vernie** when you're ready for the robot to move. Switching away from this tab or clicking **Stop Camera** automatically turns off the camera and stops the wheels.
5. *Want to try tracking without a camera?* Use **Target Left**, **Target Right**, and **Simulate Wave** to test how Vernie responds.

### Voice Commands
- Tap **Start Microphone** to talk to Vernie, **or** type a phrase into the command box, **or** tap one of the **Quick Voice Prompts**.
- Check **Speak replies** if you want your browser to answer back out loud while Vernie chirps and moves.
- **Things you can say:**
  - *Movement:* `"forward"`, `"reverse"`, `"turn left"`, `"turn right"`, **`"stop"`** *(always stops immediately!)*
  - *Head:* `"home head"` *(calibrates center)*, `"look left"`, `"look right"`, `"look center"`
  - *Fun:* `"hello vernie"`, `"dance"`, `"laser"`, `"siren"`, `"play macro"`
  - *Switch modes:* `"pet mode"`, `"explorer mode"`, `"sentry mode"`, `"color mode"`, `"remote mode"`
- **Safety rule:** Voice commands can **never** shoot the dart — saying `"fire"` or `"shoot"` is always blocked so background noise can't trigger a launch.

---

## Tab 5 — Flasher & Recovery

Use this tab to install wireless updates whenever a new version of Vernie OS is published, test custom firmware files, or follow the 1-minute steps to restore official LEGO software.

---

# 5. Playing Without a Phone or Computer

Just tap the green button to turn Vernie on, then use a quick button press (or double-tap the robot while still) to cycle through the 4 standalone personalities:

- **Living Pet (Blue):** Looks around and chirps every few seconds, backs away playfully if you put a hand near his chest, and squawks if you pick him up.
- **Room Explorer (Green):** Drives forward on his own; if his chest sensor sees an obstacle or he bumps into something, he backs up, looks left and right, and turns toward the clearer side.
- **Desk Sentry (Red):** Pulses his red chest light while scanning left and right. If someone gets close, he sounds a warning siren and does a playful wiggle + laser sound *(stays safely disarmed unless you manually armed him from the app)*.
- **Color Cards (Yellow):** Hold a colored LEGO brick right in front of the chest sensor for about half a second:
  - **Green brick:** Drive forward and cheer!
  - **Red brick:** Spin around and squawk!
  - **Blue brick:** Dance and play a victory tune!
  - **Yellow brick:** Replay whatever custom routine you saved in **Modes & Macros**!

*(For exact timing and technical thresholds, see [Autonomous Modes & Flash Macro Guide](autonomous-modes.md).)*

---

# 6. Switching Back to the Official LEGO® BOOST App

You can return your Move Hub to 100% factory LEGO software anytime:

1. Turn the hub off, then **press and hold the green button** (5–10 seconds) until it flashes **Red → Green → Blue**.
2. Open **[https://code.pybricks.com/](https://code.pybricks.com/)** in Chrome or Edge.[^pybricks-code]
3. Click the **Settings (gear)** icon → **Restore Official LEGO Firmware** → pick **`LEGO Bootloader`**.
4. Wait ~30 seconds. Your hub is now ready for the official LEGO BOOST app again!

---

# 7. Common Questions & Quick Fixes

- **Why are the Head buttons, Head slider, or `Fire Dart` greyed out?**
  Vernie needs to know where center is before moving his head. Remove any dart and click **Home Head (Non-Trigger)** in Tab 1 until the badge says **`HEAD HOMED`**. To enable **Fire Dart**, you must also click **Arm Lock (0xA5)** and make sure Vernie is sitting upright.
- **Why does Chest Distance say `N/A`?**
  Either the chest sensor isn't plugged in, or you turned on a solid Chest LED color (**Blue / Green / Red**). Go to **Motor Synth & LEDs** and click **Chest: Off (Sense)** to turn sensing back on.
- **Why did it squawk and flash red right when I turned it on?**
  It thinks it's tilted or being held in your hands while in an autonomous mode. Turn it off, set it down flat or upright in its normal resting pose, and tap the green button again — it will automatically learn its resting position in a fraction of a second. *(Remember: manual driving on the Tank Drive Pad works in any position!)*
- **Why won't `VernieOS` show up in the Bluetooth list?**
  Check that the hub is turned on (light softly pulsing Blue/Green/Red/Yellow) and not already connected to another browser tab, phone, or the LEGO app.
- **Why did flashing fail or disconnect partway through?**
  Low batteries are the #1 cause — swap in **6 fresh AAA batteries**, keep the hub close to your computer, and don't touch the green button while the bar is moving.
- **Why is the light flashing Red and Blue back and forth?**
  That's **Safety Mode** — the hub restarted after an unexpected hiccup or low-battery dip and locked the motors to stay safe. Check your batteries and restart the hub (or use **Flasher & Recovery → Send Software Reboot**).
- **Can I connect extra hardware like an ESP32 camera or MP3 speaker?**
  Yes! Advanced builders can see [Optional Port C & D Raw UART Hardware Expansion](../hardware/uart-expansion.md) for wiring and power safety details.

[^vernie-cockpit-app]: `webapp/src/App.tsx` — Vernie OS 5-tab Web Bluetooth Cockpit application
[^vernie-firmware-main]: `firmware/src/main.c` — Vernie OS firmware runtime loop
[^pybricks-code]: Pybricks Code browser utility supporting official LEGO BOOST firmware restoration
