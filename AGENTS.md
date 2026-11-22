# AGENTS.md — Working Guide for Vernie OS (`LegoBoost`)

This repository contains the pure-MIT bare-metal C firmware (`firmware/`), Python packaging/validation tools (`tools/`), dual Web Bluetooth PWAs (`webapp/` and `webapp-pilot/`), and an **Open Knowledge Format (OKF v0.2) knowledge bundle** (`docs/`).

---

## 1. Mandatory Starting Workflow: Read the OKF Knowledge Bundle First

Before diving into source files, proposing designs, or editing code, **always start with `docs/`**:

1. **Read [`docs/index.md`](docs/index.md)** to map the knowledge domains (`architecture/`, `hardware/`, `protocol/`, `playbooks/`, `computations/`, `references/`).
2. **Read [`docs/log.md`](docs/log.md)** to understand recent milestones, hardware findings, and what has been verified.
3. **Walk the relevant domain `index.md`** (e.g., `docs/architecture/index.md`, `docs/hardware/index.md`, `docs/protocol/index.md`, `docs/playbooks/index.md`, `docs/computations/index.md`, `docs/references/index.md`) and read the linked concept documents for the subsystem you are touching.
4. **Follow frontmatter pointers** (`resource`, `sources[].resource`, `computation`, `executor`, `attester`, `status`, `verified`, `stale_after`) to locate authoritative code and deterministic verifiers instead of guessing from directory listings alone.
5. **Check for doc/code drift:** Compare `docs/log.md` with recent `git log` commits before editing, and update the relevant OKF concept doc, domain `index.md`, and `docs/log.md` whenever changing architecture, hardware behavior, protocols, or major PWA features.

---

## 2. Interacting With & Maintaining the OKF v0.2 Documentation (`docs/`)

`docs/` is a machine-validated **OKF v0.2** bundle checked in CI by `tools/validate_okf.py` (both normative §11 conformance and `--strict` producer lint). Whenever you add or edit documentation under `docs/`, follow these rules:

- **Root index (`docs/index.md`):** YAML frontmatter MUST declare **only** `okf_version: "0.2"` (quoted string).
- **Nested indexes (`docs/<domain>/index.md`):** MUST NOT contain YAML frontmatter. Keep links in sync when adding/renaming concept docs.
- **Update log (`docs/log.md`):** MUST NOT contain YAML frontmatter. Use unique valid ISO `## YYYY-MM-DD` date headings ordered **newest-first**, and record substantive doc/architecture/verification updates.
- **Concept documents (all other `docs/**/*.md`):**
  - Required YAML frontmatter: `type`, `title`, `description`, `generated: { by, at }`.
  - Recommended/validated fields: `resource`, `tags`, `status` (`draft` | `stable` | `deprecated`), `verified` (`{ by, at }` or list), `stale_after`, `sources`.
  - **Forbidden legacy v0.1 syntax:** Never use `timestamp` in frontmatter or a `# Citations` body heading.
  - **Datetimes:** Must be ISO-8601 strings with explicit UTC offset (`Z` or `±HH:MM`).
  - **Actors:** `generated.by` and `verified[].by` must match `<producer>/<version>`, `human:<id>`, or `process:<id>`. `sources[].author` also permits `team:<id>`.
  - **Citations & Footnotes:** Every inline citation `[^id]` must match both a `sources[].id` entry and a body definition `[^id]: ...`. Never leave orphan footnote definitions.
  - **Relative Links & Resources:** Use relative paths (never root-anchored `/...`); every linked file/directory and relative `resource` / `sources[].resource` path must exist on disk.
  - **Attested Computations (`type: Attested Computation`):** Must declare `runtime`, `parameters` (`name`, `type`, `required`), `executor` (`resource` + `receipt` list), `attester` (`resource`), and either `computation` path or an inline `# Computation` section.
  - **No runtime receipts in `docs/`:** Never commit `*receipt*.json` files inside `docs/`.

Always validate after any documentation edit:

```bash
python3 tools/validate_okf.py docs/
python3 tools/validate_okf.py --strict docs/
```

---

## 3. Repository Map & Source-of-Truth Boundaries

| Path | Role | Key Docs / Contracts |
| :--- | :--- | :--- |
| `docs/` | OKF v0.2 Knowledge Bundle (specs, hardware pinouts, protocols, playbooks, attested computations, Python attesters) | `docs/index.md`, `docs/log.md` |
| `firmware/` | Pure-MIT STM32F070RB Cortex-M0 firmware (`vernie-os-*`) over `third_party/pybricks-micropython/lib/pbio` | `docs/architecture/vernie-os.md`, `docs/hardware/move-hub.md`, `docs/computations/flash-ram-budget.md` |
| `tools/` | `protocol_schema.json` (C/TS wire-protocol source of truth), `pack_firmware.py`, `validate_okf.py`, `tools/tests/` | `docs/protocol/ble-appdata.md`, `docs/protocol/lwp3-bootloader.md` |
| `webapp/` | Classic 5-tab Chromebook Engineering Cockpit & LWP3 Flasher PWA; also hosts shared `@core/*` BLE & vision/voice modules (`webapp/src/ble/`, `webapp/src/vision/`) | `docs/architecture/web-cockpit.md`, `docs/playbooks/user-guide.md` |
| `webapp-pilot/` | Vernie Pilot PWA (deployed at `/pilot/`): Digital Twin, Xbox gamepad, Quest WebXR VR Cockpit, Android Phone Host ↔ Driver 3-stage WebRTC/Compat/Relay FPV bridge, Zero-IP Wi-Fi Discovery, Smart Co-Pilot (`rover/intelligentDrive.ts`), Auto Explorer (`rover/intelligentExplorer.ts`), 2D Room Map (`rover/roomMap.ts`), Rover Vision (`vision/roverVision.ts`, `vision/aiObjectDetector.ts`) | `docs/architecture/web-cockpit.md`, `docs/playbooks/user-guide.md` (shares `@core/ble/*` & `@core/vision/*` from `webapp/src/`) |

---

## 4. Non-Negotiable Hardware, Protocol & Safety Invariants

Do not violate these invariants documented in `docs/`:

1. **Pure-MIT & Flash/SRAM Budget (`docs/architecture/vernie-os.md`, `docs/computations/flash-ram-budget.md`):**
   - Keep `PBSYS_CONFIG_TELEMETRY=0`, `PBDRV_CONFIG_BLOCK_DEVICE=0`, and `PBSYS_CONFIG_STORAGE=0`.
   - Never write to `FLASH_USER_0` (`0x0801F000`, included in bootloader checksum); persist runtime calibration/macros only in `FLASH_USER_1` (`0x0801F800`) with CRC32 while motors/synth are idle.
   - Keep `string_minimal.c` non-recursive (`-ffreestanding -fno-builtin -fno-tree-loop-distribute-patterns`).
2. **Head Homing & Dart Safety (`docs/hardware/vernie-mechanics.md`, `docs/playbooks/autonomous-modes.md`):**
   - Relative head moves MUST stay locked until `HEAD_HOMED`.
   - Homing MUST seek strictly in the negative (non-trigger) direction at low duty (`<= 30%`).
   - Dart launcher boots disarmed, requires explicit `ARM` + `FIRE` with magic `0xA5` + `HEAD_HOMED` + upright, auto-disarms after firing/pickup/disconnect, and MUST NEVER have a macro opcode or voice trigger.
3. **Singing-Motor PWM & Timer Restore (`docs/hardware/singing-motors.md`, `docs/computations/pwm-synth-dividers.md`):**
   - Maintain 0.0 V DC bipolar symmetry (`ccr2 = (ARR + 1) - d`, `duty <= 15%`, dead-band `>= 70%`, `<= 3000 ms` thermal cap).
   - Enable TIM3 Voice 2 ONLY on a confirmed 88008 head motor port when the sibling port is safe (never on raw UART). Restore `pbio`'s 12 kHz timer defaults on yield/stop.
4. **BLE AppData Wire Parity & BlueNRG-MS Limits (`docs/protocol/ble-appdata.md`, `tools/protocol_schema.json`):**
   - `ATT_MTU = 23` enforces `<= 17 B` RX and `<= 19 B` TX (`0x80` telemetry is `18 B`).
   - Any wire-format change MUST keep `tools/protocol_schema.json`, `firmware/src/vernie_protocol.*`, `webapp/src/ble/protocol.ts`, and `docs/protocol/ble-appdata.md` in exact parity.
   - Preserve single-in-flight Write-With-Response coalescing and urgent `DRIVE(0,0)` STOP preemption in `webapp/src/ble/vernieClient.ts`.
5. **Move Hub Orientation & Pickup (`docs/hardware/vernie-mechanics.md`, `docs/log.md`):**
   - Official Vernie upright defaults to `-Y` (`+Y` points C/D → A/B); boot calm auto-orientation locks resting face (`±X/±Y/±Z`).
   - Mode 4 (`VERNIE_MODE_REMOTE`) permits manual driving in any orientation; pickup cutout gates unattended autonomous Modes 0–3, macros, and dart firing.
6. **LWP3 Bootloader Packaging (`docs/protocol/lwp3-bootloader.md`, `docs/computations/lwp3-checksum.md`):**
   - Hub name `<= 12` UTF-8 bytes; `firmware.zip` holds unchecksummed `firmware-base.bin` + `metadata-version: "2.0.0"`; `firmware.bin` appends the 4-byte additive complement over `108,544` bytes.

---

## 5. Verification & Build Commands

Run the relevant verification gates before finishing changes (matching `.github/workflows/ci-and-pages.yml`). If `third_party/` submodules are uninitialized in a fresh clone, fetch direct submodules non-recursively first (`git submodule update --init`) so firmware builds and strict OKF `resource` checks pass; use `/usr/bin/python3` if the default `python3` shim lacks `PyYAML`:

```bash
# Firmware build, deterministic OKF attester gates, and ASan/UBSan host C tests
make -C firmware PYTHON=/usr/bin/python3 -j4 all verify-gates test

# OKF v0.2 bundle conformance (§11) + strict producer lint + Python parity/attester tests
/usr/bin/python3 tools/validate_okf.py docs/
/usr/bin/python3 tools/validate_okf.py --strict docs/
/usr/bin/python3 -m pytest -v tools/tests/

# Classic Engineering Cockpit PWA
npm --prefix webapp test && npm --prefix webapp run build

# Vernie Pilot PWA (FPV / Auto Explorer / Quest VR)
npm --prefix webapp-pilot test && npm --prefix webapp-pilot run build
```
