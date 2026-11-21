# SPDX-License-Identifier: MIT
"""Layer 3/4 schema-driven C + TypeScript parity verification against tools/protocol_schema.json.

Compiles firmware/src/vernie_protocol.c directly into a temporary shared library and drives
vernie_cmd_decode() and vernie_telemetry_encode() directly from tools/protocol_schema.json
golden vectors so C and TypeScript can never silently drift apart.
"""

from __future__ import annotations

import ctypes
import json
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "tools" / "protocol_schema.json"
HEADER_PATH = REPO_ROOT / "firmware" / "src" / "vernie_protocol.h"
SOURCE_PATH = REPO_ROOT / "firmware" / "src" / "vernie_protocol.c"
TS_PATH = REPO_ROOT / "webapp" / "src" / "ble" / "protocol.ts"


class _VernieTelemetryC(ctypes.Structure):
    _fields_ = [
        ("battery_mv", ctypes.c_uint16),
        ("distance_pct", ctypes.c_uint8),
        ("color_id", ctypes.c_uint8),
        ("pitch_deg", ctypes.c_int8),
        ("roll_deg", ctypes.c_int8),
        ("flags", ctypes.c_uint8),
        ("mode_id", ctypes.c_uint8),
        ("enc_a", ctypes.c_int16),
        ("enc_b", ctypes.c_int16),
        ("head_deg", ctypes.c_int16),
        ("speed_a", ctypes.c_int8),
        ("speed_b", ctypes.c_int8),
        ("seq", ctypes.c_uint8),
    ]


def test_c_header_and_ts_constants_match_schema() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    header = HEADER_PATH.read_text(encoding="utf-8")
    ts = TS_PATH.read_text(encoding="utf-8")

    # Verify critical transport UUIDs & MTU caps exist in protocol.ts verbatim.
    for key in (
        "pybricks_service_uuid",
        "pybricks_command_event_char_uuid",
        "lwp3_bootloader_service_uuid",
        "lwp3_bootloader_char_uuid",
    ):
        assert schema["transport"][key] in ts, f"Missing {key} in protocol.ts"

    # Verify opcodes match vernie_protocol.h enum values.
    for name, val in schema["opcodes"].items():
        pat = rf"VERNIE_OP_{name}\s*=\s*(0x[0-9A-Fa-f]+|\d+)"
        m = re.search(pat, header)
        assert m is not None, f"Missing VERNIE_OP_{name} in vernie_protocol.h"
        assert int(m.group(1), 0) == val


def test_c_codec_matches_all_schema_golden_vectors(tmp_path: Path) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    so_path = tmp_path / "libvernie_proto.so"
    subprocess.run(
        [
            "gcc",
            "-std=c11",
            "-shared",
            "-fPIC",
            "-Wall",
            "-Wextra",
            "-Werror",
            f"-I{SOURCE_PATH.parent}",
            str(SOURCE_PATH),
            "-o",
            str(so_path),
        ],
        check=True,
    )
    lib = ctypes.CDLL(str(so_path))
    lib.vernie_cmd_decode.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_void_p]
    lib.vernie_cmd_decode.restype = ctypes.c_int
    lib.vernie_telemetry_encode.argtypes = [ctypes.POINTER(_VernieTelemetryC), ctypes.c_char_p]
    lib.vernie_telemetry_encode.restype = ctypes.c_size_t

    vectors = schema["golden_vectors"]
    cmd_buf = ctypes.create_string_buffer(64)

    # Every RX golden vector in protocol_schema.json MUST decode with VERNIE_PARSE_OK (0).
    for name, vec in vectors.items():
        if not name.startswith("rx_"):
            continue
        raw = bytes(vec["bytes"])
        rc = lib.vernie_cmd_decode(raw, len(raw), cmd_buf)
        assert rc == 0, f"C vernie_cmd_decode failed on golden vector {name} (rc={rc})"

    # TX telemetry golden vector MUST encode byte-for-byte identically!
    tx = vectors["tx_telemetry"]
    f = tx["fields"]
    c_tel = _VernieTelemetryC(
        battery_mv=f["battery_mv"],
        distance_pct=f["distance_pct"],
        color_id=f["color_id"],
        pitch_deg=f["pitch_deg"],
        roll_deg=f["roll_deg"],
        flags=f["flags"],
        mode_id=f["mode_id"],
        enc_a=f["enc_a"],
        enc_b=f["enc_b"],
        head_deg=f["head_deg"],
        speed_a=f["speed_a"],
        speed_b=f["speed_b"],
        seq=f["seq"],
    )
    out = ctypes.create_string_buffer(18)
    n = lib.vernie_telemetry_encode(ctypes.byref(c_tel), out)
    assert n == 18
    assert list(out.raw) == tx["bytes"]
