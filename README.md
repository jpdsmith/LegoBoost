# Vernie OS — Custom Native-C Firmware & Chromebook Web Cockpit for LEGO® BOOST

Pure-MIT bare-metal C firmware for the **LEGO® BOOST Move Hub (88006 / Vernie the Robot, Set 17101)** built on top of Pybricks' MIT-licensed `lib/pbio` (without MicroPython or proprietary telemetry), paired with a **Chromebook-first Web Bluetooth Flasher & Live Telemetry PWA** and documented as an **Open Knowledge Format (OKF v0.2)** knowledge bundle.

## Quick Links

- **Vernie Pilot PWA (Modern Tactile Controller & Live Digital Twin):** [https://jpdsmith.github.io/LegoBoost/pilot/](https://jpdsmith.github.io/LegoBoost/pilot/) (`webapp-pilot/`)
- **Classic Chromebook Engineering Cockpit (GitHub Pages):** [https://jpdsmith.github.io/LegoBoost/](https://jpdsmith.github.io/LegoBoost/) (`webapp/`)
- **Vernie OS User Guide:** [docs/playbooks/user-guide.md](docs/playbooks/user-guide.md)
- **OKF v0.2 Knowledge Bundle:** Start at [docs/index.md](docs/index.md) (update log in [docs/log.md](docs/log.md))
- **Chromebook Flashing & Brick Recovery:** [docs/playbooks/flashing-and-recovery.md](docs/playbooks/flashing-and-recovery.md)
- **Autonomous Modes & Flash Macro Guide:** [docs/playbooks/autonomous-modes.md](docs/playbooks/autonomous-modes.md)
- **Bench Calibration & Hardware Acceptance:** [docs/playbooks/calibration-and-tests.md](docs/playbooks/calibration-and-tests.md)
- **Optional Port C & D Raw UART Expansion (ESP32-S3 / DFPlayer):** [docs/hardware/uart-expansion.md](docs/hardware/uart-expansion.md)

## Phase 1–5 Highlights (Verified)

- **Pure-MIT Cortex-M0 Firmware (`vernie-os-0.3.2` on `STM32F070RB`):** Compiles in **45.0 KB Flash** (`44,964 B` out of 104 KB — 58% free!) and **8.9 KB SRAM** (`8,956 B` out of 16 KB, including 3 KB stack), with `PBSYS_CONFIG_TELEMETRY=0`, `PBDRV_CONFIG_BLOCK_DEVICE=0`, zero `.ARM.exidx`, and `FLASH_USER_0` untouched.
- **Native Hardware Drivers & 2-Voice Bipolar Singing-Motor Synth:** Native SPI1 LIS3DH 3-axis accelerometer (6-face calm-boot auto-orientation for vertical Vernie & flat rovers, pickup/bump/3-axis stationary double-tap), orientation-free Mode 4 Remote driving, Port C/D auto-detection, non-trigger single-direction head homing, armed-only dart launcher, 88007 `SPEC1`/`COL_O` color+distance+chest LED, `FLASH_USER_1` CRC32 storage, and zero-DC-creep `TIM1`/`TIM3` motor audio synth (`0.00273%` worst pitch error across A3–A7).
- **Standalone Autonomous Brain & Flash Macro Engine:** Boots offline into 5 modes (**0 Living Pet**, **1 Room Explorer**, **2 Desk Sentry**, **3 Color-Card Commander**, **4 Remote Cockpit**) cycled via green button, stationary torso double-tap, or BLE, plus a chunked `0x07 MACRO_OP` 5-byte sequencer (up to 46 steps / `232 B`, no dart opcode) persisted to `FLASH_USER_1` and triggerable offline with a Yellow LEGO brick.
- **Dual Installable Chromebook PWAs (`Vernie Pilot` + Classic Engineering Cockpit):** Both deployed via GitHub Pages — featuring the tactile **Vernie Pilot** PWA (`/pilot/`) with a live interactive SVG Digital Twin (**Tank/Rover** & **Vernie** chassis), first-class **Xbox controller** driving, **Meta Quest 1/2/3 WebXR Immersive VR Cockpit** with curved 3D windshield, live mini-map dashboard & **Oculus Touch hand controllers** (Arcade/Trigger + Twin-Stick Tank + haptics), two-device **Android Phone (on tank) ↔ Chromebook/Quest WebRTC FPV** streaming with **Zero-IP Same-Wi-Fi Auto-Discovery**, Port-443 dual-relay signaling & 500 ms link-drop auto-stop, **Smart Co-Pilot** (5-sector free-floor clearance, Auto-Brake / Smart Dodge, Straight Heading Hold, Tap-to-Follow & optional on-device MediaPipe 80-object AI vision), smooth continuous **Auto Explorer** with live **2D Occupancy Room Map**, unstick recovery & on-the-fly photo **Discovery Log**, authentic piano keyboard & R2-D2 soundboard, LEGO-style Visual Routine Builder, Voice Commander, and guided wireless updater (plus the classic 5-tab engineering cockpit at `/`).

## Build & Verify Locally

```bash
# 1. Build ARM Cortex-M0 firmware, run deterministic attester gates & ASan/UBSan C tests
make -C firmware -j4 all verify-gates test

# 2. Validate OKF v0.2 bundle (normative §11 + strict CI producer lint) & Python tests
python3 tools/validate_okf.py docs/
python3 tools/validate_okf.py --strict docs/
pytest -v tools/tests/

# 3. Run Vitest suites & build both PWAs (Classic Cockpit + Vernie Pilot)
npm --prefix webapp test && npm --prefix webapp run build
npm --prefix webapp-pilot test && npm --prefix webapp-pilot run build
```

> LEGO® and BOOST are trademarks of the LEGO Group, which does not sponsor, authorize, or endorse this project.