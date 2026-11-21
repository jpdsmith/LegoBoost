---
type: Executor
title: Run ELF Size & Pure-MIT Gate
description: Sanctioned CLI invocation for verifying STM32F070RB Flash/SRAM budgets, linker symbol addresses, and pure-MIT compliance.
resource: ../attesters/attest_flash_ram.py
tags: [executor, firmware, elf, budget, license]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
---

# Examples

```bash
python3 docs/references/attesters/attest_flash_ram.py \
  --elf firmware/build/firmware.elf \
  --map firmware/build/firmware.elf.map \
  --max-flash 46080 \
  --max-ram 8192
```
