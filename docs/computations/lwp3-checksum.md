---
type: Attested Computation
title: LWP3 Bootloader Zero-Sum Checksum
description: Computes and verifies the 32-bit little-endian additive complement word over FLASH_FIRMWARE + FLASH_USER_0 (108,544 bytes) required by the Move Hub bootloader.
status: stable
runtime: python
computation: ../../tools/pack_firmware.py
parameters:
  - { name: base_bin, type: path, required: true }
  - { name: map_file, type: path, required: true }
  - { name: hub_name, type: string, required: false }
  - { name: checksum_size, type: integer, required: true }
executor:
  resource: ../references/executors/run-pack-firmware.md
  receipt: [bin_size, checksum_word, bin_sha256, residual]
attester:
  resource: ../references/attesters/attest_lwp3_checksum.py
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-checksum-py
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/tools/flash/checksum.py
    title: Pybricks sum_complement() bootloader checksum reference
    author: team:pybricks
  - id: movehub-platform-ld
    resource: ../hardware/move-hub.md
    title: Move Hub FLASH_FIRMWARE + FLASH_USER_0 memory layout
---

# Overview

The LEGO BOOST Move Hub bootloader refuses to jump to `0x08005000` unless the 32-bit little-endian word sum across `FLASH_FIRMWARE` (104 KB) + `FLASH_USER_0` (2 KB) (`checksum_size = 108,544` bytes, with unprogrammed flash words treated as `0xFFFFFFFF`) equals `0 mod 2^32`.[^pybricks-checksum-py][^movehub-platform-ld]

This computation is implemented in `tools/pack_firmware.py` and attested independently (without an LLM) by `docs/references/attesters/attest_lwp3_checksum.py`. Runtime receipts are ephemeral CI outputs and are never committed into `docs/`.

[^pybricks-checksum-py]: Pybricks `sum_complement()` additive complement checksum implementation
[^movehub-platform-ld]: Move Hub memory map documenting 104 KB + 2 KB checksum span
