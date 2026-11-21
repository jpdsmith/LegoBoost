#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic OKF v0.2 Attester: LWP3 Move Hub Bootloader Zero-Sum Checksum.

Verifies (with zero LLM involvement) that a flashable Move Hub firmware binary:
  1. Is 4-byte aligned, <= max_firmware_size (106,496 B FLASH_FIRMWARE), and <= checksum_size (108,544 B)
  2. Has a 32-bit little-endian additive sum across checksum_size (0xFF-padded) equal to 0
  3. Optionally matches a provided receipt JSON's bin_sha256 & checksum_word
Always emits structured JSON (never raw tracebacks on validation failures).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

FLASH_FIRMWARE_MAX_BYTES = 104 * 1024  # 106,496 B
DEFAULT_CHECKSUM_SIZE = 108544         # 104 KiB FLASH_FIRMWARE + 2 KiB FLASH_USER_0


def verify_lwp3_checksum(
    bin_path: Path,
    checksum_size: int = DEFAULT_CHECKSUM_SIZE,
    max_firmware_size: int = FLASH_FIRMWARE_MAX_BYTES,
    receipt_path: Path | None = None,
) -> dict[str, object]:
    errors: list[str] = []

    if checksum_size <= 0 or checksum_size % 4 != 0:
        errors.append(f"checksum_size {checksum_size} must be a positive multiple of 4")

    if not bin_path.is_file():
        return {
            "verdict": "FAIL",
            "binary": str(bin_path),
            "errors": [f"Binary file not found: {bin_path}"],
        }

    data = bin_path.read_bytes()
    size = len(data)
    sha256 = hashlib.sha256(data).hexdigest()

    if size < 4 or size % 4 != 0:
        errors.append(f"Binary size {size} is not >= 4 and 4-byte aligned")
    if size > max_firmware_size:
        errors.append(f"Binary size {size} exceeds FLASH_FIRMWARE limit {max_firmware_size}")
    if size > checksum_size:
        errors.append(f"Binary size {size} exceeds checksum_size {checksum_size}")

    checksum_word_str: str | None = None
    residual_str: str | None = None

    if not errors:
        total = 0
        for (word,) in struct.iter_unpack("<I", data):
            total += word
        remaining_words = (checksum_size - size) // 4
        total += remaining_words * 0xFFFFFFFF
        residual = total & 0xFFFFFFFF
        checksum_word = struct.unpack("<I", data[-4:])[0]
        checksum_word_str = f"0x{checksum_word:08X}"
        residual_str = f"0x{residual:08X}"
        if residual != 0:
            errors.append(f"32-bit zero-sum residual is {residual_str}, expected 0x00000000")

    if receipt_path is not None:
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"Failed to read receipt {receipt_path}: {exc}")
        else:
            if receipt.get("bin_sha256") != sha256:
                errors.append(
                    f"Receipt bin_sha256 ({receipt.get('bin_sha256')}) does not match binary ({sha256})"
                )
            if checksum_word_str is not None and receipt.get("checksum_word") != checksum_word_str:
                errors.append(
                    f"Receipt checksum_word ({receipt.get('checksum_word')}) does not match binary ({checksum_word_str})"
                )

    return {
        "verdict": "PASS" if not errors else "FAIL",
        "binary": str(bin_path),
        "bin_size": size,
        "max_firmware_size": max_firmware_size,
        "checksum_size": checksum_size,
        "checksum_word": checksum_word_str,
        "residual": residual_str,
        "sha256": sha256,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Attest LWP3 zero-sum bootloader checksum.")
    parser.add_argument("--bin", type=Path, required=True, help="Path to checksummed firmware.bin")
    parser.add_argument("--checksum-size", type=int, default=DEFAULT_CHECKSUM_SIZE)
    parser.add_argument("--max-firmware-size", type=int, default=FLASH_FIRMWARE_MAX_BYTES)
    parser.add_argument("--receipt", type=Path, help="Optional JSON receipt to cross-check")
    args = parser.parse_args()

    result = verify_lwp3_checksum(
        args.bin,
        checksum_size=args.checksum_size,
        max_firmware_size=args.max_firmware_size,
        receipt_path=args.receipt,
    )
    print(json.dumps(result, indent=2))
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
