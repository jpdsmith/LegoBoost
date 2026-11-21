# SPDX-License-Identifier: MIT
"""Layer 2 unit & tamper tests for tools/pack_firmware.py."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))
sys.path.insert(0, str(REPO_ROOT / "docs" / "references" / "attesters"))

import attest_lwp3_checksum  # noqa: E402
import pack_firmware  # noqa: E402


def _make_dummy_map(
    tmp_path: Path,
    name_offset: int = 32,
    name_size: int = 16,
    flash_fw_size: int = 0x1A000,
    flash_user0_size: int = 0x800,
) -> Path:
    map_path = tmp_path / "firmware.elf.map"
    map_path.write_text(
        f"FLASH_FIRMWARE   0x08005000 0x{flash_fw_size:08x} xr\n"
        f"FLASH_USER_0     0x0801f000 0x{flash_user0_size:08x} xr\n"
        f".name            0x{0x08005000 + name_offset:08x} 0x{name_size:x}\n",
        encoding="utf-8",
    )
    return map_path


def _make_base_with_sentinel(total_len: int = 64, name_offset: int = 32) -> bytes:
    buf = bytearray(b"\x11\x22\x33\x44" * ((total_len + 3) // 4))[:total_len]
    sentinel = b"Pybricks\x00".ljust(16, b"\x00")
    buf[name_offset : name_offset + 16] = sentinel
    return bytes(buf)


def test_pack_and_verify_dual_artifacts_and_manifest(tmp_path: Path) -> None:
    base_bin = tmp_path / "firmware-base.bin"
    base_bin.write_bytes(_make_base_with_sentinel(64, 32))
    map_file = _make_dummy_map(tmp_path, name_offset=32, name_size=16)

    out_zip = tmp_path / "firmware.zip"
    out_bin = tmp_path / "firmware.bin"
    out_manifest = tmp_path / "manifest.json"

    summary = pack_firmware.build_artifacts(
        base_bin_path=base_bin,
        map_path=map_file,
        fw_version="vernie-os-test",
        hub_name="VernieOS",
        out_zip=out_zip,
        out_bin=out_bin,
        out_manifest=out_manifest,
    )
    assert summary["base_size"] == 64
    assert summary["bin_size"] == 68
    pack_firmware.verify_artifacts(out_zip, out_bin)

    manifest = json.loads(out_manifest.read_text(encoding="utf-8"))
    assert manifest["version"] == "vernie-os-test"
    assert manifest["bin_size"] == 68
    assert manifest["bin_sha256"] == summary["bin_sha256"]
    assert manifest["checksum_word"] == summary["checksum_word"]

    with zipfile.ZipFile(out_zip, "r") as zf:
        meta = json.loads(zf.read("firmware.metadata.json"))
        assert meta["metadata-version"] == "2.0.0"
        assert meta["device-id"] == 64
        assert meta["checksum-size"] == 108544
        assert zf.read("firmware-base.bin")[32:41] == b"VernieOS\x00"


def test_unaligned_base_padded_with_ff(tmp_path: Path) -> None:
    raw = _make_base_with_sentinel(64, 32) + b"\xAA\xBB"  # 66 bytes -> padded to 68 bytes
    base_bin = tmp_path / "unaligned.bin"
    base_bin.write_bytes(raw)
    map_file = _make_dummy_map(tmp_path, name_offset=32, name_size=16)
    out_zip = tmp_path / "fw.zip"
    out_bin = tmp_path / "fw.bin"

    summary = pack_firmware.build_artifacts(base_bin, map_file, "v0.1", "VernieOS", out_zip, out_bin)
    assert summary["base_size"] == 68
    assert summary["bin_size"] == 72
    pack_firmware.verify_artifacts(out_zip, out_bin)
    with zipfile.ZipFile(out_zip, "r") as zf:
        assert zf.read("firmware-base.bin")[-2:] == b"\xFF\xFF"


def test_bluenrg_hub_name_ceiling_and_bounds_enforced() -> None:
    base = _make_base_with_sentinel(64, 32)

    # Exactly 12 ASCII UTF-8 bytes fits BlueNRG response_data[25] (13 + 12 == 25).
    patched_12 = pack_firmware.patch_hub_name(base, 32, 16, "VernieOS1234", expect_sentinel=b"Pybricks\x00")
    assert patched_12[32:45] == b"VernieOS1234\x00"

    # 13 ASCII bytes must be rejected even though .name slot is 16 bytes!
    with pytest.raises(ValueError, match="BlueNRG-MS limit of 12"):
        pack_firmware.patch_hub_name(base, 32, 16, "VernieOS12345")

    # Multi-byte UTF-8 exceeding 12 bytes must be rejected.
    with pytest.raises(ValueError, match="BlueNRG-MS limit of 12"):
        pack_firmware.patch_hub_name(base, 32, 16, "Vernie🤖🤖")

    # Negative offset must be rejected (no silent Python negative slicing).
    with pytest.raises(ValueError, match="Invalid .name region"):
        pack_firmware.patch_hub_name(base, -16, 16, "VernieOS")

    # Wrong sentinel must be rejected.
    with pytest.raises(ValueError, match="Expected .name sentinel"):
        pack_firmware.patch_hub_name(b"\x00" * 64, 32, 16, "VernieOS", expect_sentinel=b"Pybricks\x00")


def test_flash_firmware_104kb_ceiling_protects_flash_user_0() -> None:
    # 106,492 + 4 == 106,496 B (exact 104 KiB FLASH_FIRMWARE fit) -> PASS
    csum = pack_firmware.sum_complement(b"\x00" * 106492, 108544)
    fw_exact = b"\x00" * 106492 + struct.pack("<I", csum)
    assert pack_firmware.verify_checksummed_image(fw_exact, 108544)

    # 106,496 + 4 == 106,500 B spills into FLASH_USER_0 even though < 108,544 -> MUST REJECT!
    with pytest.raises(ValueError, match="FLASH_FIRMWARE limit"):
        pack_firmware.sum_complement(b"\x00" * 106496, 108544)
    assert not pack_firmware.verify_checksummed_image(b"\x00" * 106500, 108544)


def test_verify_artifacts_survives_python_dash_o(tmp_path: Path) -> None:
    base_bin = tmp_path / "firmware-base.bin"
    base_bin.write_bytes(_make_base_with_sentinel(64, 32))
    map_file = _make_dummy_map(tmp_path, name_offset=32, name_size=16)
    out_zip = tmp_path / "fw.zip"
    out_bin = tmp_path / "fw.bin"
    pack_firmware.build_artifacts(base_bin, map_file, "v0.1", "VernieOS", out_zip, out_bin)

    # Corrupt 1 byte in firmware.bin and run verify_artifacts under `python3 -O`!
    tampered = bytearray(out_bin.read_bytes())
    tampered[0] ^= 0x01
    out_bin.write_bytes(tampered)

    proc = subprocess.run(
        [
            sys.executable,
            "-O",
            "-c",
            (
                f"import sys; sys.path.insert(0, {str(REPO_ROOT / 'tools')!r}); "
                f"import pack_firmware; from pathlib import Path; "
                f"pack_firmware.verify_artifacts(Path({str(out_zip)!r}), Path({str(out_bin)!r}))"
            ),
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0
    assert "ValueError" in proc.stderr


def test_parse_map_file_missing_sections(tmp_path: Path) -> None:
    bad_map = tmp_path / "bad.map"
    bad_map.write_text("ONLY_RAM 0x20000000 0x4000\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Missing FLASH_FIRMWARE"):
        pack_firmware.parse_map_file(bad_map)

    no_name = tmp_path / "noname.map"
    no_name.write_text("FLASH_FIRMWARE 0x08005000 0x1a000 xr\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Missing .name section"):
        pack_firmware.parse_map_file(no_name)


def test_real_built_firmware_if_present() -> None:
    fw_zip = REPO_ROOT / "firmware" / "build" / "firmware.zip"
    fw_bin = REPO_ROOT / "firmware" / "build" / "firmware.bin"
    if fw_zip.exists() and fw_bin.exists():
        pack_firmware.verify_artifacts(fw_zip, fw_bin)
        res = attest_lwp3_checksum.verify_lwp3_checksum(fw_bin, 108544)
        assert res["verdict"] == "PASS"
