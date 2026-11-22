---
type: Playbook
title: Vernie OS User Guide
description: Plain-English owner's guide for installing Vernie OS on a LEGO BOOST Move Hub, using Vernie Pilot and Classic Cockpit, pairing an Android phone on your tank with a Chromebook, Mac, or Meta Quest VR headset over Wi-Fi, driving with Xbox or Quest Touch controllers, using Smart Co-Pilot and Auto Explorer, playing motor music, building saved routines, troubleshooting, and returning to the official LEGO app.
tags: [playbook, user-guide, getting-started, chromebook, android, quest-vr, fpv, xbox, vernie]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-22T13:05:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-22T12:18:00Z }
stale_after: 2027-05-22T00:00:00Z
sources:
  - id: vernie-cockpit-app
    resource: ../../webapp/src/App.tsx
    title: Vernie OS Classic Web Bluetooth Cockpit App
    author: human:jpdsmith
  - id: vernie-pilot-app
    resource: ../../webapp-pilot/src/App.tsx
    title: Vernie Pilot Tactile & FPV/VR PWA
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

**Vernie OS** gives your **LEGO® BOOST Move Hub** a brand-new brain and two browser-based remote controls — no app store download needed:

- **Vernie Pilot (Recommended):** **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)** — modern tactile console with live **Tank/Rover** & **Vernie** interactive diagram, **Android Phone ↔ Chromebook / Mac / Meta Quest VR** Wi-Fi camera driving, **Xbox controller** & **Quest Touch hand controller** support, **Smart Co-Pilot** obstacle avoidance, and smooth **Auto Explorer** room mapping.[^vernie-pilot-app]
- **Classic Engineering Cockpit:** **[https://jpdsmith.github.io/LegoBoost/](https://jpdsmith.github.io/LegoBoost/)** — compact technical dashboard with raw diagnostics and single-device webcam Vision & Voice tools.[^vernie-cockpit-app]

Once Vernie OS is installed on your Move Hub, your robot can also roam and react completely on its own with no phone or computer connected.

> **Safe to Try:** The Move Hub's built-in factory update system is permanent and cannot be erased. You can switch back to the official LEGO® BOOST app at any time in less than a minute.

---

# 1. What You Need

- **A LEGO® BOOST Move Hub** — works in the official **Vernie** robot *or* any custom **tank/car/rover** build.
  - Have the extra head motor or the color & distance sensor? Plug them into **Port C** and **Port D** in **either order** — Vernie automatically detects which port has which part.
- **6 fresh AAA batteries** — fresh batteries matter most while installing updates (weak batteries can cause Bluetooth to drop partway through).
- **For Bluetooth control & flashing:** **Google Chrome** or **Microsoft Edge** on a **Chromebook**, **Android phone/tablet**, **Windows PC**, **Mac**, or **Linux** computer. *(iPhone and iPad Safari do not support browser Bluetooth yet.)*
- **Optional for Remote FPV / VR Driving:**
  - A **spare Android phone** mounted facing forward on your tank (connects to the Move Hub over Bluetooth and streams its rear camera over your home Wi-Fi).
  - A **Chromebook / Mac / PC** *(optionally with an **Xbox controller**)* **or** a **Meta Quest 1 / 2 / 3** headset (using **Meta Quest Browser**) on the **same Wi-Fi** to view the live camera and drive remotely — no Bluetooth needed on the Driver device!

*(Tip: In Chrome, click the **Install App** icon in the address bar to pin **Vernie Pilot** to your Chromebook shelf or phone home screen.)*

---

# 2. Installing & Updating Vernie OS

## First-Time Install (From Stock LEGO Software)

1. Open **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)** and click the **Setup** tab *(or **Flasher & Recovery** in Classic Cockpit)*.
2. Make sure your Move Hub is **turned off**.
3. **Press and hold the green button** on the hub for about **5–10 seconds** until the light flashes **Red → Green → Blue**, then let go. *(This is Update Mode.)*
4. Click **Flash Firmware** in the browser, choose **`LEGO Bootloader`** in the Bluetooth popup, and wait about 20 seconds while the bar fills to 100%.
5. When it finishes, the hub restarts on its own, plays a **4-note rising chime**, and glows softly **Blue**. You're ready to play!

## Updating to a Newer Version Later

1. Click **Connect Robot** at the top of the page.
2. Open **Setup** *(or **Flasher & Recovery**)* and click **Step 1: Send Software Reboot**.
3. Wait 2 seconds for the light to flash **Red → Green → Blue**, then click **Step 2: Flash Firmware** and pick **`LEGO Bootloader`**.

*(Need detailed recovery help? See the [Flashing & Recovery Playbook](flashing-and-recovery.md).)*

---

# 3. Lights, Sounds & the Green Button

## Why Does It Beep? (It Doesn't Have a Speaker!)

The LEGO Move Hub has **no physical speaker**. Vernie OS makes sounds by gently vibrating the coils inside the motors — using balanced pulses so they sing without turning the wheels:[^vernie-firmware-main]

- **4-note rising chime:** Everything started up normally!
- **Quick single chirp:** You switched to the next mode.
- **Two-tone squawk:** Vernie thinks he's been picked up or tipped over in an autonomous mode (set him back down to stop it).
- **Silent + rapid Red/Blue flashing:** Safety Mode activated after a glitch or weak-battery reset (see [Common Questions](#8-common-questions--quick-fixes)).

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

Whether you built **Vernie standing upright** or a **flat 4-wheel tank/car**, just set your robot down in its normal driving position **before** tapping the green button. After sitting still for a fraction of a second, it automatically learns which side is "up" for that session — so tilt and pickup detection work accurately either way.

Manual driving always works in **any** position, even if your robot is on a ramp or in your hands.

---

# 4. Vernie Pilot Basics (All 5 Stations)

Open **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)**. The top bar keeps **Connect Robot**, live Bluetooth or Wi-Fi status, and the red **STOP** button always within reach.

## Station 1 — Drive

- **Tank / Vernie Switch:** Pick **Tank / Rover** (hides Vernie-only head/dart controls and shows the rover digital twin) or **Vernie** (full head, eyebrow, and dart launcher controls).
- **Driving:** Drag the round tactile joystick, use **W / A / S / D** or **Arrow keys**, plug in an **Xbox / USB / Bluetooth gamepad**, and press **Spacebar** anytime for an instant emergency stop. Choose a speed preset (`40%`, `65%`, `85%`, `100%`) for smooth indoor control.
- **Moving the Head & Eyebrows (Vernie build):** Whenever you turn the hub off, the head motor forgets where center is. To prevent accidentally pulling the shoulder dart trigger, remove any loaded dart and tap **Home Head** once until the badge turns green (**`HEAD HOMED`**). That unlocks the **5 eyebrow poses** and the **Head angle slider**.
- **Dart Launcher 3-Condition Safety Lock:** Requires **`HEAD HOMED`** + robot sitting **`UPRIGHT`** + lifting the safety cover (**`ARMED`**) before **Fire Dart** unlocks. Automatically disarms right after firing, if picked up, or if Bluetooth disconnects.

## Station 2 — FPV Rover (Remote Camera, Co-Pilot, Auto Explorer & Quest VR)

See **[Section 5](#5-remote-fpv-driving-smart-co-pilot--meta-quest-vr)** below for full setup, Xbox & Quest Touch mappings, and Wi-Fi video details! Also includes the **Voice Commander** sub-tab (speak or type phrases like `"hello vernie"`, `"forward"`, `"turn left"`, `"dance"`, `"explorer mode"`, or **`"stop"`** — voice can never fire the dart).

## Station 3 — Music & Lights

- **Motor Synth:** Pick **Auto**, **V1 Tracks**, or **V2 Head**, choose note length (`150 / 280 / 500 ms`), trigger any of the **7 R2-D2 sound effects**, or play melodies on the **13-key chromatic piano** (`C5–C6`). *(Continuous sound automatically takes a quick breather after 3 seconds to keep the motor coils cool.)*
- **Hub RGB & Chest Sensor LED:** Pick any Move Hub LED color, or light up the chest sensor **Blue / Green / Red**. *(Remember to click **Chest: Off (Sense)** when you want distance and color brick sensing back!)*

## Station 4 — Routines (Saved Flash Macros)

Build custom playlists of **DRIVE**, **HEAD**, **SYNTH**, **LED**, and **WAIT** steps (up to 46 steps / `232 B`; dart firing is excluded for safety). Start from presets (**Victory Dance**, **Desk Patrol**, **R2-D2 Greeting**) or an empty sequence, click **Upload & Play** to test live, or **Save to Flash (Yellow Card)** so you can replay it offline anytime by holding a **Yellow LEGO brick** in front of the sensor in **Color Cards** mode.

## Station 5 — Setup (Wireless Updates & Recovery)

One-click wireless firmware updates, custom `.bin` verification, and step-by-step instructions to return to the official LEGO BOOST app.

---

# 5. On-Board Auto-Pilot (Pixel Fold 90°), Remote FPV & Meta Quest VR

You can run camera-guided Auto Exploration on a **single Android foldable/phone** (such as a **2023 Pixel Fold** half-folded at 90° on top of your tank with the rear camera pointing forward — **no second device or Wi-Fi required**), *or* pair an Android phone with a **Chromebook**, **Mac**, **PC**, or **Meta Quest VR headset** over Wi-Fi!

## Single-Device On-Board Auto-Pilot (Pixel Fold 90° Tabletop Mode)

1. Fold your **Pixel Fold** to **90°** so the lower half rests flat on the tank and the upper half stands upright with the **rear camera pointing forward**.
2. Open **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)** in Chrome, tap **Connect Robot** (Bluetooth), open **FPV Rover**, and pick **On-Board Auto-Pilot (Fold 90°)** (selected automatically on Android).
3. Tap **Start On-Board Rear Camera** and optionally **90° Full Fold** to split the live camera visor + 2D Room Map cleanly onto the upright top half, keep the hinge crease button-free, and place the big **Start Auto Explore** / **STOP** paddles and **1-Tap Problem Tagger** on the flat lower half.
4. **Calibrate Left-Offset Camera:** Open **Mount (-4cm)** and slide **Camera Left/Right Offset** until the dashed cyan chassis rails match your tank's real left & right treads (protecting the right corner when the camera sits left of center).
5. **Record & Share Real-Life Test Runs:** Recording starts automatically with Auto Explore. Tap **Hit Obstacle**, **Clipped Right**, **False Wall**, **Stuck / Spin**, **Bad Turn**, or **Good Dodge** whenever you see something notable, then tap **Share Run (.zip)** or **Contact Sheet (.png)** to export the complete telemetry + annotated frames right from the Android Share Sheet.

## Two-Device Wi-Fi Pairing (Zero IP Address Needed!)

Both devices just need to be on the **same Wi-Fi network** (no IP addresses to look up):

1. **On the Android Phone (mounted on the tank):**
   - Open **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)**, open **FPV Rover**, and select **Android Phone on Tank**.
   - Tap **Connect Robot** in the top bar to pair Bluetooth with **`VernieOS`** *(you can also test video streaming first without Bluetooth connected!)*.
   - Tap **Start Camera & Broadcast on Wi-Fi** and allow rear-camera access. Your phone keeps its screen awake and starts advertising on your home Wi-Fi.
2. **On your Chromebook, Mac, PC, or Meta Quest Browser:**
   - Open **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)** and open **FPV Rover** (**Driver / Quest VR**).
   - Within ~1 second, a green **Found your Tank on your Wi-Fi!** card pops up automatically — click **Connect Now**!
   - *(Backup options: type the 4-letter **Room Code** shown on the phone, paste the phone's **Copy Join Link**, or expand **Offline Copy/Paste Pair** for 100% internet-free local pairing.)*

### How Live Video Connects (Automatic 3-Stage Resilience)
- **Wi-Fi FPV Live (Direct P2P):** Connects directly between your phone and driver over local Wi-Fi (~24 fps, ultra-low latency).
- **COMPAT VIDEO (Automatic Codec Fallback):** If an older Android phone's hardware video encoder outputs a blank WebRTC video track while the data link is open, Vernie Pilot automatically streams crisp JPEG frames over the direct P2P data channel after 3 seconds.
- **Wi-Fi Relay Live / `RELAY VIDEO` (Automatic Firewall Fallback):** If your Wi-Fi router blocks peer-to-peer loopback or macOS blocks Chrome's local-network UDP, Vernie Pilot automatically switches after 8 seconds (or immediately if you click **Use Relay Video Now**) to live relayed camera video + full drive controls. You can click **Retry Direct P2P** anytime.
- **Safety Failsafe:** In both Direct P2P and Relay modes, if the Wi-Fi signal drops for more than **500 ms**, the Android phone immediately halts the tank motors.

## Smart Co-Pilot & Smooth Auto Explorer

Switch **Pilot Mode** right below the live video (or press **Xbox Y** / **Quest Left Y**):

- **Manual FPV:** Direct raw control from your Xbox controller, keyboard, touch stick, or Quest hand controllers.
- **Smart Co-Pilot:** Smooth driving assistance running live on the phone's camera + chest sensor:
  - **Collision Guard (`Off` / `Auto-Brake` / `Smart Dodge`):** **Auto-Brake** halts before hitting walls; **Smart Dodge** smoothly steers around obstacles toward the clearest open lane without stopping unnecessarily *(reverse is always allowed so you can back out anytime)*.
  - **Straight Heading Hold:** Uses the phone gyroscope and wheel encoders to prevent tank tread drift.
  - **Tape Lane Assist:** Gently centers the tank along floor tape lines.
  - **Tap-to-Follow & AI Vision:** Tap any bright object directly on the live camera video to lock on and follow hands-free, or toggle **AI Vision (80 Objects)** to detect people, pets, chairs, cups, and more right on the phone.
- **Auto Explorer:** Drives smoothly and continuously around your room using curved-arc steering (no stop-start jerking), builds a live **2D Occupancy Room Map**, automatically backs out of tight corners if stuck, and snaps photos into the **Rover Discovery Log** on the fly without stopping. Pick from 4 missions: **Explore Room**, **Find Person**, **Find Objects**, or **Return Home**. Moving your stick or pressing **STOP** immediately returns control to you.

## Xbox Controller Mapping (Chromebook / Mac / PC)

Plug in or Bluetooth-pair an Xbox controller (or any standard gamepad) on the Driver device:

| Control | Action |
| :--- | :--- |
| **Left Stick** | Smooth arcade drive (push forward/back + steer left/right) |
| **RT / LT Triggers + Left Stick X** | Car-style gas (`RT`) & reverse (`LT`) pedals + steering |
| **Right Stick (Left / Right)** | Pan optional Port C head/turret motor |
| **A** | Honk Vernie's horn |
| **B** | **Emergency STOP** (halts motors & exits Auto Explorer immediately) |
| **X** | Toggle Android phone flashlight **Headlights** |
| **Y** | Cycle Pilot Mode (**Manual FPV → Smart Co-Pilot → Auto Explorer**) |
| **LB / RB** | Step Speed Limit down / up (`40% → 65% → 85% → 100%`) |
| **Menu / Start** | Lock onto / unlock detected target for hands-free follow |

## Meta Quest 1 / 2 / 3 Immersive VR Cockpit

Open **[https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/)** inside **Meta Quest Browser** (tested for Quest 1 v1 headsets as well as Quest 2/3):

1. Pair with your Android phone over Wi-Fi using the green **Connect Now** card (just like on a Chromebook).
2. Tap the orange **Enter VR Cockpit (Quest)** button.
3. Inside VR, you sit in a comfortable grounded cockpit with an **88° curved panoramic live camera windshield** (works with both Direct P2P and Relay video), floating **3D AR floor clearance lanes & steering arcs**, and an angled **lower dashboard** displaying the live 2D Room Map, motor tread gauges, battery, and front distance.

### Oculus Touch Hand Controller Mapping

| Controller & Input | Action |
| :--- | :--- |
| **Left Thumbstick** *(Arcade Mode)* | Arcade drive (forward/back + steer) |
| **Right / Left Index Trigger + Left Stick X** *(Arcade Mode)* | Car-style gas (`R-Trigger`) & reverse (`L-Trigger`) + steering |
| **Left & Right Thumbsticks Y** *(Twin-Stick Tank Mode)* | Independent Left tread & Right tread control |
| **Left Thumbstick Click** | Toggle **Arcade/Trigger** ↔ **Twin-Stick Tank** drive style |
| **Right Thumbstick Click** | **Recenter** the VR cockpit in front of your current view |
| **Right Thumbstick X** *(Arcade Mode)* | Pan optional Port C head/turret motor |
| **Right B** | **Emergency STOP** (+ strong haptic pulse) |
| **Right A** | Horn |
| **Left X** | Toggle phone **Headlights** |
| **Left Y** | Cycle Pilot Mode (**Manual → Smart Co-Pilot → Auto Explorer**) |
| **Left / Right Grip Squeeze** | Speed Limit down / up (`40% / 65% / 85% / 100%`) |

*(Collision Guard braking and dodging also send subtle haptic pulses to both Touch controllers!)*

---

# 6. Playing Without a Phone or Computer

Just tap the green button to turn Vernie on, then use a quick button press (or double-tap the robot while still) to cycle through the 4 standalone personalities:

- **Living Pet (Blue):** Looks around and chirps every few seconds, backs away playfully if you put a hand near his chest, and squawks if you pick him up.
- **Room Explorer (Green):** Drives forward on his own; if his chest sensor sees an obstacle or he bumps into something, he backs up, looks left and right, and turns toward the clearer side.
- **Desk Sentry (Red):** Pulses his red chest light while scanning left and right. If someone gets close, he sounds a warning siren and does a playful wiggle + laser sound *(stays safely disarmed unless you manually armed him from the app)*.
- **Color Cards (Yellow):** Hold a colored LEGO brick right in front of the chest sensor for about half a second:
  - **Green brick:** Drive forward and cheer!
  - **Red brick:** Spin around and squawk!
  - **Blue brick:** Dance and play a victory tune!
  - **Yellow brick:** Replay whatever custom routine you saved in **Routines** / **Modes & Macros**!

*(For exact timing and technical thresholds, see [Autonomous Modes & Flash Macro Guide](autonomous-modes.md).)*

---

# 7. Switching Back to the Official LEGO® BOOST App

You can return your Move Hub to 100% factory LEGO software anytime:

1. Turn the hub off, then **press and hold the green button** (5–10 seconds) until it flashes **Red → Green → Blue**.
2. Open **[https://code.pybricks.com/](https://code.pybricks.com/)** in Chrome or Edge.[^pybricks-code]
3. Click the **Settings (gear)** icon → **Restore Official LEGO Firmware** → pick **`LEGO Bootloader`**.
4. Wait ~30 seconds. Your hub is now ready for the official LEGO BOOST app again!

---

# 8. Common Questions & Quick Fixes

- **Why does FPV say `Wi-Fi Relay Live` (`RELAY VIDEO`) instead of `Wi-Fi FPV Live`?**
  Your router or computer blocked direct local-network UDP (very common on **macOS Sequoia Chrome / Incognito** or guest Wi-Fi), so Vernie Pilot automatically switched to Relay Video so you still get a live stream immediately. To unlock full 24 fps direct local video on macOS, allow **System Settings → Privacy & Security → Local Network → Google Chrome** (and try a regular window instead of Incognito), then click **Retry Direct P2P**.
- **Can I test Wi-Fi camera streaming before connecting Vernie over Bluetooth?**
  Yes! Just tap **Start Camera & Broadcast on Wi-Fi** on the Android phone and click **Connect Now** on your Chromebook/Mac/Quest. Video, floor clearance overlays, and Auto-Discovery all work immediately; you can connect Bluetooth to **`VernieOS`** anytime before or after.
- **Why didn't I get a new app update right away?**
  Because Vernie Pilot installs offline as a PWA, **hard-refresh the page once** on both devices after a new release so the browser activates the newest cached version.
- **Why isn't the `Enter VR Cockpit (Quest)` button visible on my laptop?**
  That button appears automatically when opened in a WebXR-capable headset browser such as **Meta Quest Browser** over HTTPS.
- **Why are the Head buttons, Head slider, or `Fire Dart` greyed out?**
  Vernie needs to know where center is before moving his head. Remove any dart and click **Home Head** until the badge says **`HEAD HOMED`**. To enable **Fire Dart**, Vernie must also be sitting upright and have the safety cover lifted (**`ARMED`**).
- **Why does Chest Distance say `N/A`?**
  Either the chest sensor isn't plugged in, or you turned on a solid Chest LED color (**Blue / Green / Red**). Go to **Music & Lights** *(or **Motor Synth & LEDs**)* and click **Chest: Off (Sense)** to turn sensing back on.
- **Why did it squawk and flash red right when I turned it on?**
  It thinks it's tilted or being held in your hands while in an autonomous mode. Turn it off, set it down flat or upright in its normal resting pose, and tap the green button again — it automatically learns its resting position in a fraction of a second. *(Manual driving always works in any position!)*
- **Why won't `VernieOS` show up in the Bluetooth list?**
  Check that the hub is turned on (light softly pulsing Blue/Green/Red/Yellow) and not already connected to another browser tab, phone, or the official LEGO app.
- **Why did flashing fail or disconnect partway through?**
  Low batteries are the #1 cause — swap in **6 fresh AAA batteries**, keep the hub close to your computer, and don't touch the green button while the bar is moving.
- **Why is the light flashing Red and Blue back and forth?**
  That's **Safety Mode** — the hub restarted after an unexpected hiccup or low-battery dip and locked the motors to stay safe. Check your batteries and restart the hub (or use **Setup → Send Software Reboot**).
- **Can I connect extra hardware like an ESP32 camera or MP3 speaker?**
  Yes! Advanced builders can see [Optional Port C & D Raw UART Hardware Expansion](../hardware/uart-expansion.md) for wiring and power safety details.

[^vernie-cockpit-app]: `webapp/src/App.tsx` — Vernie OS Classic 5-tab Web Bluetooth Cockpit application
[^vernie-pilot-app]: `webapp-pilot/src/App.tsx` — Vernie Pilot tactile PWA with Wi-Fi FPV, Xbox, Smart Co-Pilot, Auto Explorer, and Meta Quest WebXR VR Cockpit
[^vernie-firmware-main]: `firmware/src/main.c` — Vernie OS firmware runtime loop
[^pybricks-code]: Pybricks Code browser utility supporting official LEGO BOOST firmware restoration
