# SPDX-License-Identifier: MIT
"""Layer 1 & 2 positive/negative tests for OKF v0.2 deterministic attesters."""

from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))
sys.path.insert(0, str(REPO_ROOT / "docs" / "references" / "attesters"))

import attest_flash_ram  # noqa: E402
import attest_lwp3_checksum  # noqa: E402
import attest_pwm_synth  # noqa: E402
import pack_firmware  # noqa: E402


def _good_elf_inputs() -> tuple[dict[str, int], dict[str, int], str, str]:
    sections = {
        ".text": 28000,
        ".magic": 260,
        ".data": 16,
        ".bss": 4700,
        ".noinit": 0,
        ".bootloader_selector": 0,
        ".stack": 3072,
        ".name": 16,
        ".user": 4,
        ".checksum": 4,
    }
    symbols = {
        "_fw_isr_vector_src": 0x08005000,
        "_fw_isr_vector_dst": 0x20000000,
        "pbdrv_reset_stm32_bootloader_selector": 0x20000100,
        "pbdrv_stack_end": 0x20004000,
        "_checksum": 0x08005000 + 28036,
    }
    map_text = "build/vernie/src/main.o\nbuild/pbio/sys/hmi_none.o\n"
    disasm = (
        "08005da8 <memset>:\n"
        " 8005da8: 0003 movs r3, r0\n"
        " 8005db2: 4770 bx lr\n"
        "\n"
        "08005dd6 <strlen>:\n"
        " 8005dd6: 0003 movs r3, r0\n"
        " 8005de0: 4770 bx lr\n"
    )
    return sections, symbols, map_text, disasm


def test_flash_ram_attester_passes_clean_fixture() -> None:
    sections, symbols, map_text, disasm = _good_elf_inputs()
    res = attest_flash_ram.evaluate_elf_attestation(sections, symbols, map_text, disasm, 46080, 8192)
    assert res["verdict"] == "PASS"
    assert res["errors"] == []


def test_flash_ram_attester_catches_c1_recursive_memset_and_strlen() -> None:
    sections, symbols, map_text, _ = _good_elf_inputs()
    recursive_disasm = (
        "08005b5a <memset>:\n"
        " 8005b5a: b510 push {r4, lr}\n"
        " 8005b60: f7ff fffb bl 8005b5a <memset>\n"
        "\n"
        "08005b84 <strlen>:\n"
        " 8005b84: b510 push {r4, lr}\n"
        " 8005b86: f7ff fffd bl 8005b84 <strlen>\n"
    )
    res = attest_flash_ram.evaluate_elf_attestation(
        sections, symbols, map_text, recursive_disasm, 46080, 8192
    )
    assert res["verdict"] == "FAIL"
    joined = "\n".join(res["errors"])
    assert "<memset>" in joined
    assert "<strlen>" in joined


def test_flash_ram_attester_catches_budget_symbol_exidx_and_forbidden_violations() -> None:
    sections, symbols, map_text, disasm = _good_elf_inputs()
    sections[".text"] = 50000
    sections[".bss"] = 5500
    sections[".ARM.exidx"] = 8
    symbols["pbdrv_reset_stm32_bootloader_selector"] = 0x20000200
    symbols["pbsys_telemetry_init"] = 0x08006000
    map_text += "pbdrv_block_device_init ramdisk mp_obj_new_int\n"

    res = attest_flash_ram.evaluate_elf_attestation(sections, symbols, map_text, disasm, 46080, 8192)
    assert res["verdict"] == "FAIL"
    joined = "\n".join(res["errors"])
    assert "Flash" in joined
    assert "RAM" in joined
    assert ".ARM.exidx" in joined
    assert "pbdrv_reset_stm32_bootloader_selector" in joined
    assert "pbsys_telemetry_" in joined
    assert "pbdrv_block_device_" in joined
    assert "ramdisk" in joined
    assert "mp_obj_" in joined


def test_flash_ram_attester_passes_real_built_elf_if_present() -> None:
    elf = REPO_ROOT / "firmware" / "build" / "firmware.elf"
    elf_map = REPO_ROOT / "firmware" / "build" / "firmware.elf.map"
    if elf.exists() and elf_map.exists():
        res = attest_flash_ram.attest_elf(elf, elf_map, 55296, 11264)
        assert res["verdict"] == "PASS", f"ELF attestation failed: {res['errors']}"


def test_pwm_synth_attester_passes_real_source() -> None:
    src = REPO_ROOT / "firmware" / "src" / "vernie_synth.c"
    res = attest_pwm_synth.attest_pwm_synth(src)
    assert res["verdict"] == "PASS", f"PWM synth attestation failed: {res['errors']}"
    assert res["cases_checked"] == 196
    assert float(res["worst_pitch_error_pct"]) < 0.5
    assert float(res["max_duty_pct"]) <= 15.0
    assert float(res["min_deadband_pct"]) >= 70.0


def test_lwp3_attester_receipt_and_error_json(tmp_path: Path) -> None:
    base = b"\x01\x02\x03\x04" * 16
    csum = pack_firmware.sum_complement(base, 108544)
    fw = base + struct.pack("<I", csum)
    fw_path = tmp_path / "firmware.bin"
    fw_path.write_bytes(fw)

    good_receipt = tmp_path / "good_receipt.json"
    good_receipt.write_text(
        json.dumps({"bin_sha256": hashlib.sha256(fw).hexdigest(), "checksum_word": f"0x{csum:08X}"}),
        encoding="utf-8",
    )
    ok = attest_lwp3_checksum.verify_lwp3_checksum(fw_path, 108544, receipt_path=good_receipt)
    assert ok["verdict"] == "PASS"
    assert ok["errors"] == []

    # Both receipt fields wrong -> BOTH errors must be reported (no overwrite!).
    bad_receipt = tmp_path / "bad_receipt.json"
    bad_receipt.write_text(
        json.dumps({"bin_sha256": "0" * 64, "checksum_word": "0xDEADBEEF"}),
        encoding="utf-8",
    )
    bad = attest_lwp3_checksum.verify_lwp3_checksum(fw_path, 108544, receipt_path=bad_receipt)
    assert bad["verdict"] == "FAIL"
    assert len(bad["errors"]) == 2

    # Unaligned binary -> structured JSON FAIL via CLI (no raw Python traceback!)
    unaligned = tmp_path / "unaligned.bin"
    unaligned.write_bytes(b"\x01\x02\x03")
    proc = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "docs" / "references" / "attesters" / "attest_lwp3_checksum.py"),
            "--bin",
            str(unaligned),
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1
    assert "Traceback" not in proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["verdict"] == "FAIL"
    assert any("4-byte aligned" in e for e in payload["errors"])

    # Oversized > 106,496 B (spills into FLASH_USER_0) -> FAIL
    oversized = tmp_path / "oversized.bin"
    oversized.write_bytes(b"\x00" * 106500)
    over_res = attest_lwp3_checksum.verify_lwp3_checksum(oversized, 108544)
    assert over_res["verdict"] == "FAIL"
    assert any("FLASH_FIRMWARE limit" in e for e in over_res["errors"])
