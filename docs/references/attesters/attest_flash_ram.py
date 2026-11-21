#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic OKF v0.2 Attester: STM32F070RB Flash, SRAM, Linker, Pure-MIT & Recursion Gate.

Inspects firmware.elf and firmware.elf.map directly via arm-none-eabi-{size,nm,objdump}
and attests:
  1. Required Flash sections (.text, .name) exist and total Flash / LMA span <= max_flash (<= 106,496 B)
  2. SRAM (.magic + .data + .bss + .noinit + .bootloader_selector + .stack) <= max_ram (<= 16,384 B)
  3. Critical linker addresses: _fw_isr_vector_src == 0x08005000, _fw_isr_vector_dst == 0x20000000,
     pbdrv_reset_stm32_bootloader_selector == 0x20000100, pbdrv_stack_end == 0x20004000
  4. Zero proprietary pbsys_telemetry, block_device/ramdisk, or MicroPython symbols in ELF/map
  5. Zero GCC loop-idiom self-recursion in freestanding string_minimal functions (memset, strlen, ...)
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HARD_FLASH_MAX = 104 * 1024
HARD_RAM_MAX = 16 * 1024

FORBIDDEN_SUBSTRINGS = (
    "pbsys_telemetry_",
    "telemetry.o",
    "block_device_flash_stm32.o",
    "pbdrv_block_device_",
    "ramdisk",
    "pbsys_storage_write",
    "mp_obj_",
)

FREESTANDING_STRING_FUNCS = {
    "memcpy",
    "memmove",
    "memset",
    "memcmp",
    "strlen",
    "strcpy",
    "strncpy",
    "strcat",
    "strcmp",
}

FUNC_HEADER_RE = re.compile(r"^[0-9a-fA-F]+\s+<([^>]+)>:\s*$")
BRANCH_TARGET_RE = re.compile(r"\b(?:bl|b(?:\.[nw])?)\s+[0-9a-fA-F]+\s+<([^>+]+)>")


def parse_size_output(elf_path: Path) -> dict[str, int]:
    proc = subprocess.run(
        ["arm-none-eabi-size", "-A", str(elf_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    sections: dict[str, int] = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0].startswith("."):
            sections[parts[0]] = int(parts[1])
    return sections


def parse_nm_symbols(elf_path: Path) -> dict[str, int]:
    proc = subprocess.run(
        ["arm-none-eabi-nm", str(elf_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    symbols: dict[str, int] = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3:
            symbols[parts[2]] = int(parts[0], 16)
    return symbols


def disassemble_elf(elf_path: Path) -> str:
    proc = subprocess.run(
        ["arm-none-eabi-objdump", "-d", str(elf_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout


def check_disassembly_recursion(disasm_text: str) -> list[str]:
    """Fail if any freestanding string_minimal function recursively calls itself."""
    errors: list[str] = []
    current_func: str | None = None
    for line in disasm_text.splitlines():
        hdr = FUNC_HEADER_RE.match(line)
        if hdr:
            current_func = hdr.group(1)
            continue
        if current_func in FREESTANDING_STRING_FUNCS:
            m = BRANCH_TARGET_RE.search(line)
            if m and m.group(1) == current_func:
                errors.append(
                    f"Freestanding function <{current_func}> recursively branches to itself "
                    f"(missing -ffreestanding/-fno-tree-loop-distribute-patterns): {line.strip()}"
                )
    return errors


def evaluate_elf_attestation(
    sections: dict[str, int],
    symbols: dict[str, int],
    map_text: str,
    disasm_text: str,
    max_flash: int,
    max_ram: int,
    elf_label: str = "firmware.elf",
) -> dict[str, object]:
    flash_bytes = sum(sections.get(s, 0) for s in (".text", ".data", ".name", ".user", ".checksum"))
    ram_bytes = sum(
        sections.get(s, 0)
        for s in (".magic", ".data", ".bss", ".noinit", ".bootloader_selector", ".stack")
    )

    flash_limit = min(max_flash, HARD_FLASH_MAX)
    ram_limit = min(max_ram, HARD_RAM_MAX)

    errors: list[str] = []
    for req_sec in (".text", ".name"):
        if sections.get(req_sec, 0) <= 0:
            errors.append(f"Required ELF section {req_sec} missing or empty")
    if sections.get(".ARM.exidx", 0) > 0:
        errors.append(
            f"Unexpected .ARM.exidx section ({sections['.ARM.exidx']} B) — avoid 64-bit libgcc divisions"
        )

    if flash_bytes > flash_limit:
        errors.append(f"Flash {flash_bytes} B exceeds limit {flash_limit} B")
    if ram_bytes > ram_limit:
        errors.append(f"RAM {ram_bytes} B exceeds limit {ram_limit} B")

    # Cross-check actual Flash LMA span from _fw_isr_vector_src to end of _checksum if present.
    flash_lma_span: int | None = None
    if "_fw_isr_vector_src" in symbols and "_checksum" in symbols:
        flash_lma_span = (symbols["_checksum"] + 4) - symbols["_fw_isr_vector_src"]
        if flash_lma_span <= 0 or flash_lma_span > flash_limit:
            errors.append(f"Flash LMA span {flash_lma_span} B out of bounds (limit {flash_limit} B)")
        elif flash_lma_span != flash_bytes:
            errors.append(
                f"Flash LMA span ({flash_lma_span} B) != accounted Flash sections ({flash_bytes} B)"
            )

    expected_addrs = {
        "_fw_isr_vector_src": 0x08005000,
        "_fw_isr_vector_dst": 0x20000000,
        "pbdrv_reset_stm32_bootloader_selector": 0x20000100,
        "pbdrv_stack_end": 0x20004000,
    }
    for sym, addr in expected_addrs.items():
        actual = symbols.get(sym)
        if actual != addr:
            errors.append(
                f"Symbol {sym} expected at 0x{addr:08X}, got {hex(actual) if actual is not None else 'MISSING'}"
            )

    for bad in FORBIDDEN_SUBSTRINGS:
        if bad in map_text or any(bad in s for s in symbols):
            errors.append(f"Forbidden symbol/object detected in firmware: {bad}")

    errors.extend(check_disassembly_recursion(disasm_text))

    return {
        "verdict": "PASS" if not errors else "FAIL",
        "elf": elf_label,
        "flash_bytes": flash_bytes,
        "flash_lma_span": flash_lma_span,
        "flash_limit": flash_limit,
        "ram_bytes": ram_bytes,
        "ram_limit": ram_limit,
        "sections": sections,
        "errors": errors,
    }


def attest_elf(elf_path: Path, map_path: Path, max_flash: int, max_ram: int) -> dict[str, object]:
    sections = parse_size_output(elf_path)
    symbols = parse_nm_symbols(elf_path)
    map_text = map_path.read_text(encoding="utf-8", errors="replace")
    disasm_text = disassemble_elf(elf_path)
    return evaluate_elf_attestation(
        sections=sections,
        symbols=symbols,
        map_text=map_text,
        disasm_text=disasm_text,
        max_flash=max_flash,
        max_ram=max_ram,
        elf_label=str(elf_path),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Attest Move Hub ELF flash/RAM, pure-MIT & recursion gates.")
    parser.add_argument("--elf", type=Path, required=True)
    parser.add_argument("--map", type=Path, required=True)
    parser.add_argument("--max-flash", type=int, default=HARD_FLASH_MAX)
    parser.add_argument("--max-ram", type=int, default=HARD_RAM_MAX)
    args = parser.parse_args()

    result = attest_elf(args.elf, args.map, args.max_flash, args.max_ram)
    print(json.dumps(result, indent=2))
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
