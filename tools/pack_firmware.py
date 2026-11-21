#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Vernie OS Firmware Packager & Verifier for LEGO BOOST Move Hub (device-id 0x40).

Emits two distinct, non-conflicting artifacts (plus optional manifest.json):
  1. firmware.zip — Compatible with code.pybricks.com & pybricksdev:
     - firmware-base.bin (UNCHECKSUMMED, 4-byte aligned, .name patchable)
     - firmware.metadata.json (metadata-version "2.0.0" flat schema)
     - ReadMe_OSS.txt
  2. firmware.bin — Ready for direct flashing by our Web Bluetooth lwp3Flasher.ts:
     - firmware-base.bin patched with hub_name + appended 4-byte sum_complement
       over checksum-size = 108,544 bytes (FLASH_FIRMWARE 104K + FLASH_USER_0 2K).
     - Enforces FLASH_FIRMWARE <= 106,496 bytes so FLASH_USER_0 remains erased 0xFFFFFFFF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

MOVE_HUB_DEVICE_ID = 0x40
FLASH_FIRMWARE_MAX_BYTES = 104 * 1024  # 106,496 B (0x08005000..0x0801F000)
EXPECTED_CHECKSUM_SIZE = 108544        # 104 KiB FLASH_FIRMWARE + 2 KiB FLASH_USER_0
# Upstream BlueNRG-MS bluetooth_stm32_bluenrg.c copies hub_name into response_data[25]
# starting at index 13 -> maximum safe UTF-8 hub name length is 25 - 13 = 12 bytes.
MAX_BLUENRG_HUB_NAME_BYTES = 12
DEFAULT_HUB_NAME_SENTINEL = b"Pybricks\x00"

README_OSS = """Vernie OS Firmware for LEGO BOOST Move Hub
License: MIT

Built on top of:
- Pybricks lib/pbio (MIT License, PBSYS_CONFIG_TELEMETRY=0 pure-MIT configuration)
- STMicroelectronics BlueNRG-MS & STM32F0 HAL (BSD-3-Clause)
- ARM CMSIS_6 (Apache-2.0)

LEGO and BOOST are trademarks of the LEGO Group, which does not sponsor,
authorize, or endorse this project.
"""


def sum_complement(
    data: bytes,
    checksum_size: int = EXPECTED_CHECKSUM_SIZE,
    max_firmware_bytes: int = FLASH_FIRMWARE_MAX_BYTES,
) -> int:
    """Compute LEGO Move Hub bootloader 32-bit additive complement checksum."""
    if checksum_size <= 0 or checksum_size % 4 != 0:
        raise ValueError(f"checksum_size {checksum_size} must be a positive multiple of 4")
    if len(data) % 4 != 0:
        raise ValueError(f"Base firmware length {len(data)} is not 4-byte aligned")
    if len(data) + 4 > max_firmware_bytes:
        raise ValueError(
            f"Firmware ({len(data)} + 4 bytes) exceeds FLASH_FIRMWARE limit ({max_firmware_bytes} bytes)"
        )
    if len(data) + 4 > checksum_size:
        raise ValueError(
            f"Firmware ({len(data)} + 4 bytes) exceeds checksum region ({checksum_size} bytes)"
        )

    total = 0
    for (word,) in struct.iter_unpack("<I", data):
        total += word

    # Unprogrammed flash words between appended checksum and end of FLASH_USER_0 are 0xFFFFFFFF.
    remaining_words = (checksum_size - 4 - len(data)) // 4
    total += remaining_words * 0xFFFFFFFF
    total &= 0xFFFFFFFF
    return (0x100000000 - total) & 0xFFFFFFFF


def verify_checksummed_image(
    fw_bytes: bytes,
    checksum_size: int = EXPECTED_CHECKSUM_SIZE,
    max_firmware_bytes: int = FLASH_FIRMWARE_MAX_BYTES,
) -> bool:
    """Return True iff fw_bytes fits FLASH_FIRMWARE and 32-bit additive sum across checksum_size == 0."""
    if (
        checksum_size <= 0
        or checksum_size % 4 != 0
        or len(fw_bytes) < 4
        or len(fw_bytes) % 4 != 0
        or len(fw_bytes) > max_firmware_bytes
        or len(fw_bytes) > checksum_size
    ):
        return False
    total = 0
    for (word,) in struct.iter_unpack("<I", fw_bytes):
        total += word
    remaining_words = (checksum_size - len(fw_bytes)) // 4
    total += remaining_words * 0xFFFFFFFF
    return (total & 0xFFFFFFFF) == 0


def parse_map_file(map_path: Path) -> dict[str, int]:
    """Extract FLASH_FIRMWARE, FLASH_USER_0, and .name offsets from GNU ld .map file."""
    flash_origin = None
    flash_firmware_size = None
    flash_user_0_size = 0
    name_start = None
    name_size = None

    text = map_path.read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        m = re.match(r"^FLASH_FIRMWARE\s+(0x[0-9A-Fa-f]+)\s+(0x[0-9A-Fa-f]+)", line)
        if m:
            flash_origin = int(m.group(1), 0)
            flash_firmware_size = int(m.group(2), 0)
            continue

        m = re.match(r"^FLASH_USER_0\s+(0x[0-9A-Fa-f]+)\s+(0x[0-9A-Fa-f]+)", line)
        if m:
            flash_user_0_size = int(m.group(2), 0)
            continue

        m = re.match(r"^\.name\s+(0x[0-9A-Fa-f]+)\s+(0x[0-9A-Fa-f]+)", line)
        if m:
            name_start = int(m.group(1), 0)
            name_size = int(m.group(2), 0)
            continue

    if flash_origin is None or flash_firmware_size is None:
        raise ValueError("Missing FLASH_FIRMWARE entry in linker map")
    if name_start is None or name_size is None:
        raise ValueError("Missing .name section in linker map")
    if name_start < flash_origin:
        raise ValueError(f".name address 0x{name_start:08X} precedes FLASH_FIRMWARE 0x{flash_origin:08X}")

    return {
        "flash_origin": flash_origin,
        "flash_firmware_size": flash_firmware_size,
        "flash_user_0_size": flash_user_0_size,
        "checksum_size": flash_firmware_size + flash_user_0_size,
        "name_start": name_start,
        "hub_name_offset": name_start - flash_origin,
        "hub_name_size": name_size,
    }


def verify_elf_name_symbol(elf_path: Path, expected_addr: int) -> None:
    """Cross-check pbsys_host_hub_name symbol in ELF matches linker map .name VMA."""
    nm = shutil.which("arm-none-eabi-nm")
    if not nm:
        return
    proc = subprocess.run([nm, str(elf_path)], check=True, capture_output=True, text=True)
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[2] == "pbsys_host_hub_name":
            actual = int(parts[0], 16)
            if actual != expected_addr:
                raise ValueError(
                    f"ELF pbsys_host_hub_name at 0x{actual:08X} != map .name 0x{expected_addr:08X}"
                )
            return
    raise ValueError("Symbol pbsys_host_hub_name missing from ELF")


def patch_hub_name(
    base_bytes: bytes,
    offset: int,
    max_size: int,
    name: str,
    expect_sentinel: bytes | None = None,
) -> bytearray:
    """Patch null-terminated UTF-8 hub name into a copy of firmware-base.bin.

    Enforces <= min(max_size - 1, 12) UTF-8 bytes so upstream BlueNRG-MS
    scan-response buffer `response_data[25]` (offset 13) can never overflow.
    """
    if offset < 0 or max_size <= 1:
        raise ValueError(f"Invalid .name region offset={offset}, max_size={max_size}")
    if offset + max_size > len(base_bytes):
        raise ValueError(
            f".name region [{offset}:{offset + max_size}] exceeds firmware-base.bin ({len(base_bytes)} B)"
        )
    if expect_sentinel is not None:
        slot = base_bytes[offset : offset + max_size]
        if not slot.startswith(expect_sentinel):
            raise ValueError(
                f"Expected .name sentinel {expect_sentinel!r} at offset {offset}, found {slot[:12]!r}"
            )

    raw_name = name.encode("utf-8")
    max_utf8 = min(max_size - 1, MAX_BLUENRG_HUB_NAME_BYTES)
    if len(raw_name) > max_utf8:
        raise ValueError(
            f"Hub name '{name}' ({len(raw_name)} UTF-8 bytes) exceeds BlueNRG-MS limit of {max_utf8} bytes"
        )

    encoded = raw_name + b"\x00"
    buf = bytearray(base_bytes)
    buf[offset : offset + max_size] = encoded.ljust(max_size, b"\x00")
    return buf


def build_artifacts(
    base_bin_path: Path,
    map_path: Path,
    fw_version: str,
    hub_name: str,
    out_zip: Path,
    out_bin: Path,
    elf_path: Path | None = None,
    out_manifest: Path | None = None,
    expect_sentinel: bytes | None = DEFAULT_HUB_NAME_SENTINEL,
) -> dict[str, object]:
    raw_base = base_bin_path.read_bytes()
    if len(raw_base) % 4 != 0:
        pad = 4 - (len(raw_base) % 4)
        raw_base = raw_base + (b"\xFF" * pad)

    info = parse_map_file(map_path)
    if info["checksum_size"] != EXPECTED_CHECKSUM_SIZE:
        raise ValueError(
            f"Unexpected checksum_size {info['checksum_size']} (expected {EXPECTED_CHECKSUM_SIZE})"
        )
    if info["flash_firmware_size"] > FLASH_FIRMWARE_MAX_BYTES:
        raise ValueError(
            f"Unexpected flash_firmware_size {info['flash_firmware_size']} (> {FLASH_FIRMWARE_MAX_BYTES})"
        )
    if elf_path is not None:
        verify_elf_name_symbol(elf_path, info["name_start"])

    # Patch default hub name cleanly into unchecksummed base binary so both zip & bin identify as VernieOS.
    patched_base = bytes(
        patch_hub_name(
            raw_base,
            info["hub_name_offset"],
            info["hub_name_size"],
            hub_name,
            expect_sentinel=expect_sentinel,
        )
    )

    metadata = {
        "metadata-version": "2.0.0",
        "firmware-version": fw_version,
        "device-id": MOVE_HUB_DEVICE_ID,
        "checksum-type": "sum",
        "checksum-size": info["checksum_size"],
        "hub-name-offset": info["hub_name_offset"],
        "hub-name-size": info["hub_name_size"],
    }

    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("firmware-base.bin", patched_base)
        zf.writestr("firmware.metadata.json", json.dumps(metadata, indent=4, sort_keys=True) + "\n")
        zf.writestr("ReadMe_OSS.txt", README_OSS)

    checksum_word = sum_complement(
        patched_base,
        checksum_size=info["checksum_size"],
        max_firmware_bytes=info["flash_firmware_size"],
    )
    flashable_bin = patched_base + struct.pack("<I", checksum_word)

    out_bin.parent.mkdir(parents=True, exist_ok=True)
    out_bin.write_bytes(flashable_bin)

    summary: dict[str, object] = {
        "version": fw_version,
        "base_size": len(patched_base),
        "bin_size": len(flashable_bin),
        "checksum_word": f"0x{checksum_word:08X}",
        "bin_sha256": hashlib.sha256(flashable_bin).hexdigest(),
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "metadata": metadata,
    }

    if out_manifest is not None:
        out_manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest = {
            "version": summary["version"],
            "base_size": summary["base_size"],
            "bin_size": summary["bin_size"],
            "checksum_word": summary["checksum_word"],
            "bin_sha256": summary["bin_sha256"],
            "built_at": summary["built_at"],
        }
        out_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return summary


def _require(condition: bool, message: str) -> None:
    """Runtime invariant check that is never stripped under `python3 -O`."""
    if not condition:
        raise ValueError(message)


def verify_artifacts(zip_path: Path, bin_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())
        required = {"firmware-base.bin", "firmware.metadata.json", "ReadMe_OSS.txt"}
        _require(required.issubset(names), f"Missing files in {zip_path}: {required - names}")

        base = zf.read("firmware-base.bin")
        meta = json.loads(zf.read("firmware.metadata.json").decode("utf-8"))

    _require(meta.get("metadata-version") == "2.0.0", f"Bad metadata-version: {meta.get('metadata-version')}")
    _require(meta.get("device-id") == MOVE_HUB_DEVICE_ID, f"Bad device-id: {meta.get('device-id')}")
    _require(meta.get("checksum-type") == "sum", f"Bad checksum-type: {meta.get('checksum-type')}")
    _require(meta.get("checksum-size") == EXPECTED_CHECKSUM_SIZE, f"Bad checksum-size: {meta.get('checksum-size')}")
    _require(len(base) % 4 == 0, "firmware-base.bin must be 4-byte aligned")
    _require(len(base) + 4 <= FLASH_FIRMWARE_MAX_BYTES, "firmware exceeds 104 KiB FLASH_FIRMWARE")
    _require(
        0 <= meta["hub-name-offset"] <= len(base) - meta["hub-name-size"],
        "hub-name-offset out of firmware-base.bin bounds",
    )

    fw_bin = bin_path.read_bytes()
    _require(len(fw_bin) == len(base) + 4, "firmware.bin must be firmware-base.bin + 4B checksum")
    _require(fw_bin[:-4] == base, "firmware.bin prefix must match firmware-base.bin")
    _require(
        verify_checksummed_image(fw_bin, meta["checksum-size"]),
        "32-bit additive checksum across 108,544 B did not equal 0!",
    )

    # T2.5: Simulate code.pybricks.com patching a custom name and recomputing checksum.
    renamed = bytes(
        patch_hub_name(base, meta["hub-name-offset"], meta["hub-name-size"], "TestVernie")
    )
    renamed_csum = sum_complement(renamed, meta["checksum-size"])
    _require(
        verify_checksummed_image(renamed + struct.pack("<I", renamed_csum), meta["checksum-size"]),
        "Re-named firmware failed zero-sum verification!",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Package & verify Vernie OS Move Hub firmware.")
    parser.add_argument("--base-bin", type=Path, required=True)
    parser.add_argument("--map-file", type=Path, required=True)
    parser.add_argument("--elf-file", type=Path, required=False)
    parser.add_argument("--version", type=str, default="vernie-os-0.1.0")
    parser.add_argument("--hub-name", type=str, default="VernieOS")
    parser.add_argument("--out-zip", type=Path, required=True)
    parser.add_argument("--out-bin", type=Path, required=True)
    parser.add_argument("--out-manifest", type=Path, required=False)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    summary = build_artifacts(
        base_bin_path=args.base_bin,
        map_path=args.map_file,
        fw_version=args.version,
        hub_name=args.hub_name,
        out_zip=args.out_zip,
        out_bin=args.out_bin,
        elf_path=args.elf_file,
        out_manifest=args.out_manifest,
    )
    if args.verify:
        verify_artifacts(args.out_zip, args.out_bin)

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
