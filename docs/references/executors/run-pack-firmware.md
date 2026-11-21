---
type: Executor
title: Run Firmware Packager
description: Sanctioned CLI invocation for packing Vernie OS firmware.zip (v2.0.0) and checksummed firmware.bin and attesting the LWP3 checksum.
resource: ../../../tools/pack_firmware.py
tags: [executor, firmware, lwp3, checksum]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
---

# Examples

```bash
python3 tools/pack_firmware.py \
  --base-bin firmware/build/firmware-base.bin \
  --map-file firmware/build/firmware.elf.map \
  --elf-file firmware/build/firmware.elf \
  --version vernie-os-0.1.0 \
  --hub-name VernieOS \
  --out-zip firmware/build/firmware.zip \
  --out-bin firmware/build/firmware.bin \
  --verify

python3 docs/references/attesters/attest_lwp3_checksum.py \
  --bin firmware/build/firmware.bin \
  --checksum-size 108544
```
