---
type: Architecture Spec
title: Vernie Web Cockpit & Vernie Pilot PWAs
description: Dual Chromebook-first React/TypeScript Web Bluetooth PWAs deployed via GitHub Pages — the Classic Engineering Cockpit (webapp/) and the tactile Vernie Pilot PWA (webapp-pilot/) featuring Tank/Rover FPV video streaming, Zero-IP Same-Wi-Fi Auto-Discovery, 3-stage WebRTC/Compat/Relay video resilience, Xbox & Meta Quest WebXR VR Cockpit controls, Smart Co-Pilot ADAS, and continuous Auto Explorer.
resource: ../../webapp/src/App.tsx
tags: [webapp, webapp-pilot, web-bluetooth, webrtc, webxr, quest, chromebook, pwa, react]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-22T13:05:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-22T12:18:00Z }
stale_after: 2027-05-22T00:00:00Z
sources:
  - id: web-bt-spec
    resource: https://webbluetoothcg.github.io/web-bluetooth/
    title: Web Bluetooth Community Group Specification
    author: team:w3c-web-bluetooth
  - id: vernie-pilot-app
    resource: ../../webapp-pilot/src/App.tsx
    title: Vernie Pilot Tactile PWA Shell
    author: human:jpdsmith
  - id: rover-webrtc-bridge
    resource: ../../webapp-pilot/src/rtc/roverBridge.ts
    title: Vernie Pilot Bundled-ICE WebRTC & Relay Rover Bridge
    author: human:jpdsmith
  - id: quest-vr-cockpit
    resource: ../../webapp-pilot/src/xr/questVrCockpit.ts
    title: Meta Quest 1/2/3 WebGL + WebXR Immersive VR Cockpit
    author: human:jpdsmith
---

# Overview

Vernie OS deploys **two installable static Vite + React + TypeScript PWAs** together on GitHub Pages so a Chromebook, desktop browser, Android phone, or Meta Quest headset can flash, drive, play, and explore with zero local installs or Crostini Linux Bluetooth passthrough:[^web-bt-spec]

1. **Classic Engineering Cockpit (`webapp/` → `/`):** Compact 5-tab diagnostic cockpit with full telemetry strip, LWP3 flasher, tank pad, singing-motor synth, macro composer, and local webcam Vision & Voice backpack.
2. **Vernie Pilot PWA (`webapp-pilot/` → `/pilot/`):** Modern tactile hardware-console PWA sharing `@core/ble/*` and `@core/vision/*` from `webapp/src/`, adding an interactive SVG Digital Twin (**Tank/Rover** & **Vernie** chassis), two-device **Android Phone ↔ Chromebook/Mac/Quest Wi-Fi FPV** streaming, **Xbox controller** driving, **Meta Quest 1/2/3 WebXR VR Cockpit**, **Smart Co-Pilot ADAS**, and continuous **Auto Explorer** with live 2D room mapping.[^vernie-pilot-app]

In CI (`.github/workflows/ci-and-pages.yml`), both PWAs receive the freshly packed `firmware.bin` / `firmware.zip` / `manifest.json`, run Vitest + TypeScript checks, and stage `webapp-pilot/dist` into `webapp/dist/pilot` for unified Pages deployment.

# Classic Engineering Cockpit Modules (`webapp/`)

- **`webapp/src/ble/lwp3Flasher.ts`**: Implements the [LWP3 Bootloader Protocol](../protocol/lwp3-bootloader.md) over Web Bluetooth (`00001625-...` / `00001626-...`) with 14-byte chunks, 10-packet `GET_CHECKSUM` throttling, Windows `ERASE_FLASH` tolerance, and a 2-step user-gesture modal for reboot-then-flash.
- **`webapp/src/ble/vernieClient.ts`**: Connects to the Pybricks GATT service (`c5f50001-...`), encodes/decodes the [BLE AppData Protocol](../protocol/ble-appdata.md), enforces single-in-flight multi-channel latest-value coalescing (`drive` + `head` sliders) under BlueNRG-MS Write-With-Response latency, gives `DRIVE(0,0)` urgent STOP priority ahead of queued commands, and serializes multi-chunk flash macro uploads.
- **`webapp/src/components/TelemetryHud.tsx`**: Persistent live telemetry strip showing battery voltage bar, active mode, torso IMU pitch/roll + `PICKED UP`/`BUMP`/`TAP/BTN` badges, 88007 chest distance/color, wheel & head encoders, dart/synth pills, Watchdog Safe Mode lockout banner, and one-click urgent `STOP`.
- **`webapp/src/components/DrivePad.tsx`**: Tactile tank drive panel combining a touch/mouse arcade joystick (`mixArcadeToTank`), WASD/Arrow keys, Spacebar urgent STOP, HTML5 Gamepad API polling, speed-cap slider (`25%..100%`), D-pad pulses, and a 16 Hz coalesced dead-man stream that stops motors immediately on release, window blur, or tab switch.
- **`webapp/src/components/HeadAndDart.tsx`**: Non-trigger stall homing (`-180°/s`, 28% duty), 5 eyebrow presets (`-35°..+35°`), coalesced head slider (all angle controls strictly locked until `HEAD_HOMED`), and a 2-step Arm (`0xA5`) / Fire / Disarm dart panel gated on `dartArmed && headHomed && !pickedUp`.
- **`webapp/src/components/MotorSynthPad.tsx`**: 2-voice bipolar singing-motor controller with Auto/V1/V2 routing, 150/280/500 ms note lengths, 7 R2-D2 SFX soundboard buttons, 13-key chromatic piano (`C5–C6`, MIDI `72–84`), Stop Synth, Move Hub RGB swatches + custom color picker, and 88007 4-state chest LED controls.
- **`webapp/src/components/ModeAndMacros.tsx`**: 5-mode Autonomous Brain switcher (`0..4`) plus a Visual Flash Macro Composer (`0x07 -> FLASH_USER_1`) supporting preset routines (`Victory Dance`, `Desk Patrol`, `R2-D2 Greeting`), custom `DRIVE`/`HEAD`/`SYNTH`/`LED`/`WAIT` step authoring with wire-protocol clamping, reordering, live `steps/46 · bytes/232 B` budget badge, and offline Yellow-Card persistence.
- **`webapp/src/components/VisionVoiceBackpack.tsx` + `webapp/src/vision/{visionEngine,voiceCommands}.ts`**: Local offline webcam/phone motion, hand-wave, and LEGO color-brick tracking (`Head Follow` gated on `HEAD_HOMED`, `Body Follow` gated on 88007 distance & pickup, `Wave React` chirps), plus Web Speech API voice control & TTS replies with dart firing permanently locked out over voice. For standalone non-BLE expansion, see [Optional Port C & D Raw UART Hardware Expansion](../hardware/uart-expansion.md).
- **`webapp/src/components/FirmwareUpdater.tsx`**: Chromebook bring-up UI for 1-click flashing of CI-published `firmware.bin`, local `.bin` zero-sum validation, and `0x05` reboot-to-bootloader recovery (see [Flashing & Recovery Playbook](../playbooks/flashing-and-recovery.md)).

# Vernie Pilot PWA Modules (`webapp-pilot/`)

## Console Shell & Stations
- **`webapp-pilot/src/App.tsx` + `TopConsoleBar.tsx` + `VernieTwin.tsx`**: 5-station tactile shell (**Drive**, **FPV Rover**, **Music & Lights**, **Routines**, **Setup**) with persistent global Emergency STOP, live Bluetooth/Wi-Fi telemetry status, and an animated SVG Digital Twin supporting both **Tank/Rover** and **Vernie** chassis modes (zero demo modes). `RoverCockpitStation` remains mounted across tab switches (`hidden={!isActiveTab}`) so active Wi-Fi FPV and On-Board Auto-Pilot camera sessions never drop.
- **`webapp-pilot/public/sw.js`**: Offline app-shell Service Worker (`vernie-pilot-v6`) keeping `/firmware/*` network-first so OTA updates always fetch fresh binaries.

## Two-Device Wi-Fi FPV Signaling, Auto-Discovery & 3-Stage Video Resilience
- **`webapp-pilot/src/rtc/mqttSignaling.ts`**: Zero-dependency MQTT 3.1.1 over WSS client with stream frame reassembly (`decodeMqttStream`), automatic reconnect, and `safeCloseWebSocket` (defers `.close()` while `CONNECTING` to eliminate browser console errors). Connects to `broker.emqx.io:8084` → `test.mosquitto.org:8081` → `broker.hivemq.com:8884` with zero daily quota limits; falls back to chunked Port-443 `ntfy.sh` solely for room signaling if all MQTT WSS ports are blocked by a firewall.
- **`webapp-pilot/src/rtc/wifiDiscovery.ts`**: Zero-IP Same-Wi-Fi Auto-Discovery (`WifiTankAdvertiser` / `WifiTankScanner`). Both devices resolve their shared router public IPv4 (`api.ipify.org` / `ipv4.icanhazip.com`) and hash it locally via SHA-256 into a private household topic `lan-<16hex>` (raw IP never transmitted) so the hosting Android phone appears automatically on the Driver within ~1 second.
- **`webapp-pilot/src/rtc/roverBridge.ts`**: Serialized signaling state machine with session IDs (`sid`), bundled ICE gathering (`waitForIceComplete`) before publishing `offer`/`answer`, candidate preservation, automatic `answer` retransmit (+2.8 s), instant Driver takeover after tab refresh, live `BridgeDiagnostics`, strict **500 ms Wi-Fi link-drop dead-man motor failsafe**, offline manual SDP copy/paste pairing, and **3-stage video resilience**:[^rover-webrtc-bridge]
  1. **Stage 1 — Direct WebRTC P2P (`Wi-Fi FPV Live`):** Full ~24 fps low-latency video + ordered DataChannel directly over LAN Wi-Fi, with progressive rear-camera `getUserMedia` constraint fallbacks for older Android phones.
  2. **Stage 2 — DataChannel JPEG Fallback (`COMPAT VIDEO`):** If the WebRTC DataChannel connects yet `<video>` stays blank (`videoWidth <= 16`) for > 3 s (older Android MediaCodec VP8/H.264 quirks), automatically streams compact JPEG frames (~12 fps, backpressure-throttled) over the P2P DataChannel.
  3. **Stage 3 — Automatic WSS Relay Fallback (`Wi-Fi Relay Live` / `RELAY VIDEO`):** If direct P2P UDP is blocked (macOS Sequoia Local Network privacy block, Chrome Incognito `.local` mDNS, or router AP isolation) and ICE fails or stalls for 8 s, automatically switches to live ~7 fps JPEG frames + full drive commands + telemetry over the already-open MQTT WSS channel (preserving the 500 ms failsafe), with manual **Use Relay Video Now** and **Retry Direct P2P** controls.

## Single-Device Pixel Fold (90° Tabletop) On-Board Auto-Pilot & Black-Box Flight Recorder
- **`webapp-pilot/src/components/FoldAutoPilotView.tsx`**: Dedicated **On-Board Auto-Pilot (Fold 90°)** primary role view inside **FPV Rover** running 100% locally on a single Android foldable (zero Wi-Fi/WebRTC/MQTT overhead). Splits cleanly across the 90° horizontal fold crease (`@media (vertical-viewport-segments: 2)` with adjustable `--fold-top-pct` fallback and a zero-button hinge divider bar): vertical top half hosts the live camera visor + asymmetric chassis rails + Live 2D Room Map; flat bottom half hosts giant thumb-friendly Start/Pause & STOP paddles, mission/speed/torch controls, collapsible Mount & Left-Offset Calibration (`camOffsetCm`, `robotWidthCm`, `fovDeg`, `horizonY`, `bumperMaskY`, rear lens picker), and live Black-Box Recorder + 1-tap Problem Tagger.
- **`webapp-pilot/src/rover/foldHeading.ts`**: Gimbal-lock-free ground-plane yaw tracker (`FoldHeadingTracker`) projecting 3D gyroscope angular velocity onto the smoothed gravity normal (`-(ω · û)`) from `DeviceMotionEvent` — immune to 90° vertical-mount gimbal lock and Move Hub motor magnets — with full W3C Z-X'-Y'' rotation-matrix fallback (`computeMatrixHeadingDeg`).
- **`webapp-pilot/src/rover/flightRecorder.ts`**: Zero-dependency 10 Hz Black-Box Flight Recorder (`FlightRecorder`) capturing structured `telemetry.jsonl`, automatic state/bump/discovery snapshots, 1-tap user Problem Tags (`hit-obstacle`, `clipped-right`, `false-wall`, `stuck-spin`, `bad-turn`, `good-dodge`), clean raw + HUD-annotated keyframes, a single-image `contact-sheet.png` diagnostic storyboard, a Markdown KPI report (`summary.md`), and a PKWARE STORE `.zip` archive (`createStoreZip`) exportable via Android Chrome `navigator.share({ files })` or file download.

## Smart Co-Pilot ADAS, Continuous Auto Explorer & 2D Room Map
- **`webapp-pilot/src/vision/roverVision.ts` + `aiObjectDetector.ts`**: 10 Hz `160×120` on-device vision featuring mount-calibrated asymmetric swept-bumper clearance (`computeSweptBumperBounds` / `analyzeFloorCorridors`, default `horizonY = 0.36`) for left-offset rear cameras, texture-verified AE-adaptive persistent EMA floor model frozen near walls (`distPct <= 35%` or `sweptClear < 0.40`), dark-only YCbCr shadow tolerance (`dy < 0`, `chromaDiff <= 5.2`) so bright white skirting boards and doorframes never pass as shadows, median 4×4 luma micro-texture smoothness barrier separating smooth painted baseboards from plush carpet, 2-row baseboard + vertical chair-leg edge detection, 9-patch texture-confidence optical flow with aperture-tie regularization (`computeOpticalFlow`), tape lane-centering, tap-to-follow HSV color lock, and lazy-loaded MediaPipe EfficientDet-Lite0 with automatic `GPU` → `CPU` delegate fallback.
- **`webapp-pilot/src/rover/intelligentDrive.ts`**: Smart Co-Pilot ADAS offering **Auto-Brake**, **Smart Dodge** (smooth steering floor without jerky stops; reverse always permitted), **Straight Heading Hold** (gyro/encoder drift compensation), **Tape Lane Assist**, and hands-off target following.
- **`webapp-pilot/src/rover/intelligentExplorer.ts` + `roomMap.ts`**: Continuous curved-arc autonomous navigation (`CRUISING`, `AVOIDING`, `UNSTICKING`, `RETURNING_HOME`, `MISSION_COMPLETE`) with asymmetric swept-bumper + 88007 front-sensor + semantic AI obstacle fusion, 900 ms carpet-jolt `pickedUp` debounce (keeping `safeMode` 0 ms instant), open-carpet `BUMP` filtering, instant dual-tread reverse snap + carpet-capable counter-rotating pivots in tight `CRUISING`/`AVOIDING`/`UNSTICKING`, multi-modal motor-stall / wheel-spin / net-progress gyro+flow rocking snag detection, 3-tier escalating unstick recovery, 750 ms turn-direction hysteresis, low-battery monitoring, auto-headlights in dim light, on-the-fly **Discovery Log** snapshots, and a live 2D occupancy grid (`RoomMapper` / `RoomMapCanvas.tsx`) with automatic `speedA`/`speedB` odometry fallback past the Move Hub `±32767°` `int16` encoder saturation ceiling.

## Xbox & Meta Quest 1/2/3 Immersive WebXR VR Cockpit
- **`webapp-pilot/src/input/xboxController.ts`**: HTML5 Standard Gamepad engine supporting Arcade Left-Stick and Car Trigger (`RT`/`LT`) driving with cubic response shaping, Right-Stick optional Port C turret pan, and edge-triggered `A`/`B`/`X`/`Y`/`LB`/`RB`/`Menu` actions.
- **`webapp-pilot/src/xr/questControllers.ts` + `questVrCockpit.ts`**: Zero-dependency WebGL 1/2 + WebXR `immersive-vr` cockpit tailored for Meta Quest 1 (Snapdragon 835, `local-floor` → `local` fallback) through Quest 3:[^quest-vr-cockpit]
  - Renders an 88° curved panoramic live video windshield (accepting both native WebRTC `<video>` and Relay/Compat `<canvas>` frames), floating translucent 3D AR corridor & object overlay, angled lower cockpit dashboard with live Mini 2D Room Map + tread gauges, and a grounding floor grid.
  - Polls W3C `xr-standard` Oculus Touch hand controllers (`axes[2..3]`, triggers, grips, `A`/`B`/`X`/`Y`, thumbstick clicks) in **Arcade/Trigger** or **Twin-Stick Tank** mode with tactile collision-guard haptics and instant `R-Stick Click` cockpit recentering.

# Browser Compatibility Notes

- **Direct Bluetooth (`Connect Robot`):** ChromeOS (Chromebook), Chrome & Edge on Windows, macOS, Linux, and Android over HTTPS or `localhost`.
- **Wi-Fi FPV Driver & VR Cockpit (no Bluetooth required on driver):** Works in Chrome, Edge, macOS/Windows/Chromebook browsers, and **Meta Quest Browser** (v1/2/3) over HTTPS while the Android phone maintains Bluetooth to the Move Hub.
- **Unsupported for Bluetooth:** iOS Safari does not expose `navigator.bluetooth`; the UI detects missing Web Bluetooth and still allows Wi-Fi FPV viewing/driving.

[^web-bt-spec]: W3C Web Bluetooth specification requiring HTTPS and user gesture for `requestDevice()`
[^vernie-pilot-app]: `webapp-pilot/src/App.tsx` — Vernie Pilot 5-station tactile PWA shell
[^rover-webrtc-bridge]: `webapp-pilot/src/rtc/roverBridge.ts` — Bundled-ICE WebRTC bridge with 3-stage video fallback & 500 ms failsafe
[^quest-vr-cockpit]: `webapp-pilot/src/xr/questVrCockpit.ts` — Zero-dependency WebGL/WebXR panoramic VR cockpit for Meta Quest 1/2/3
