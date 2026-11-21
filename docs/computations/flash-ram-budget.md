---
type: Attested Computation
title: STM32F070RB Flash, SRAM & Pure-MIT Budget
description: Verifies firmware.elf fits inside Move Hub Flash/RAM limits, relocates ISR/magic/stack symbols to exact hardware addresses, and contains zero non-free telemetry or MicroPython symbols.
status: stable
runtime: python
computation: ../references/attesters/attest_flash_ram.py
parameters:
  - { name: elf, type: path, required: true }
  - { name: map, type: path, required: true }
  - { name: max_flash, type: integer, required: true }
  - { name: max_ram, type: integer, required: true }
executor:
  resource: ../references/executors/run-elf-size.md
  receipt: [verdict, flash_bytes, ram_bytes, errors]
attester:
  resource: ../references/attesters/attest_flash_ram.py
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: vernie-linker-ld
    resource: ../../firmware/linker/vernie_movehub.ld
    title: Vernie OS Move Hub linker script memory ceilings
    author: human:jpdsmith
  - id: vernie-arch
    resource: ../architecture/vernie-os.md
    title: Vernie OS pure-MIT & SRAM budget invariants
---

# Overview

Mechanically verifies every compiled `firmware/build/firmware.elf` against the STM32F070RB hardware limits (`104 KB` Flash, `16 KB` SRAM)[^vernie-linker-ld] and the Vernie OS Phase 1 budget (`<= 45 KB` Flash, `<= 8 KB` RAM) while guaranteeing zero symbols from proprietary `telemetry.c`, `block_device_flash_stm32.c`, or MicroPython.[^vernie-arch]

[^vernie-linker-ld]: Vernie OS Move Hub GNU linker script (`firmware/linker/vernie_movehub.ld`)
[^vernie-arch]: Vernie OS Architecture pure-MIT & memory configuration invariants
