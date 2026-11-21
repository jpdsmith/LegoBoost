# Vernie OS — Custom Native-C Firmware & Chromebook Web Cockpit for LEGO® BOOST

Pure-MIT bare-metal C firmware for the **LEGO® BOOST Move Hub (88006 / Vernie the Robot, Set 17101)** built on top of Pybricks' MIT-licensed `lib/pbio` (without MicroPython or proprietary telemetry), paired with a **Chromebook-first Web Bluetooth Flasher & Live Telemetry PWA** and documented as an **Open Knowledge Format (OKF v0.2)** knowledge bundle.

## Quick Links

- **OKF v0.2 Knowledge Bundle:** Start at [docs/index.md](docs/index.md) (update log in [docs/log.md](docs/log.md))
- **Chromebook Flashing & Brick Recovery:** [docs/playbooks/flashing-and-recovery.md](docs/playbooks/flashing-and-recovery.md)
- **Live Chromebook Cockpit (GitHub Pages):** `https://jpdsmith.github.io/LegoBoost/` *(enable GitHub Pages → Source: GitHub Actions in repo settings)*

## Phase 1 Highlights (Verified)

- **Pure-MIT Cortex-M0 Firmware (`STM32F070RB`):** Compiles in **28.9 KB Flash** (`28,904 B` out of 104 KB — 72% free!) and **8.1 KB SRAM** (`8,076 B` out of 16 KB, including 3 KB stack), with `PBSYS_CONFIG_TELEMETRY=0`, `PBDRV_CONFIG_BLOCK_DEVICE=0`, and `FLASH_USER_0` untouched.
- **Auto-Boot & Watchdog Safe Mode:** Boots straight into Vernie OS (`PBSYS_CONFIG_HMI_NONE=1`), advertises resiliently over BLE, streams 10 Hz 18-byte binary telemetry, and enters safe mode on watchdog reset.
- **Zero-Install Chromebook Flashing:** Direct browser LWP3 bootloader flasher (`00001625/00001626`) with 14-byte chunking, 10-packet `GET_CHECKSUM` throttling, running XOR checksum & byte-count verification, and unbrickable 1-click official LEGO firmware restore via [code.pybricks.com](https://code.pybricks.com/).

## Build & Verify Locally

```bash
# 1. Build ARM Cortex-M0 firmware, run deterministic attester gates & ASan/UBSan C tests
make -C firmware -j4 all verify-gates test

# 2. Validate OKF v0.2 bundle (normative §11 + strict CI producer lint) & Python tests
python3 tools/validate_okf.py docs/
python3 tools/validate_okf.py --strict docs/
pytest -v tools/tests/

# 3. Run Vitest golden-vector / mock BLE tests & build Chromebook PWA
npm --prefix webapp test
npm --prefix webapp run build
```

> LEGO® and BOOST are trademarks of the LEGO Group, which does not sponsor, authorize, or endorse this project.