#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic OKF v0.2 Attester: 2-Voice Bipolar Singing-Motor PWM Divider Table.

Compiles firmware/src/vernie_synth.c directly into a temporary shared library and attests
across all MIDI notes A3 (57, 220 Hz) through A7 (105, 3520 Hz) and volume levels 10..100%:
  1. 48 MHz / ((PSC + 1) * (ARR + 1)) matches target frequency within +/- 0.5%
  2. PSC <= 65535 and ARR <= 65535
  3. Symmetrical 0.0 V DC bipolar invariant: ccr2 == ARR - ccr1, ccr1 <= 0.15 * ARR,
     and coast dead-band (ccr2 - ccr1) >= 0.70 * ARR
"""

from __future__ import annotations

import argparse
import ctypes
import json
import subprocess
import sys
import tempfile
from pathlib import Path

CLK_HZ = 48_000_000


class _VernieSynthPwmC(ctypes.Structure):
    _fields_ = [
        ("psc", ctypes.c_uint16),
        ("arr", ctypes.c_uint16),
        ("ccr1", ctypes.c_uint16),
        ("ccr2", ctypes.c_uint16),
        ("actual_hz_x10", ctypes.c_uint32),
    ]


def attest_pwm_synth(source_path: Path, max_error_pct: float = 0.5) -> dict[str, object]:
    errors: list[str] = []
    if not source_path.is_file():
        return {"verdict": "FAIL", "source": str(source_path), "errors": ["Source file not found"]}

    with tempfile.TemporaryDirectory() as tmpdir:
        so_path = Path(tmpdir) / "libvernie_synth.so"
        proc = subprocess.run(
            [
                "gcc",
                "-std=c11",
                "-DVERNIE_HOST_TEST",
                "-shared",
                "-fPIC",
                "-Wall",
                "-Wextra",
                "-Werror",
                f"-I{source_path.parent}",
                str(source_path),
                "-o",
                str(so_path),
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return {
                "verdict": "FAIL",
                "source": str(source_path),
                "errors": [f"Failed to compile {source_path}: {proc.stderr.strip()}"],
            }

        lib = ctypes.CDLL(str(so_path))
        lib.vernie_midi_to_hz.argtypes = [ctypes.c_uint8]
        lib.vernie_midi_to_hz.restype = ctypes.c_uint16
        lib.vernie_synth_calc_pwm.argtypes = [
            ctypes.c_uint16,
            ctypes.c_uint8,
            ctypes.POINTER(_VernieSynthPwmC),
        ]
        lib.vernie_synth_calc_pwm.restype = ctypes.c_bool

        notes_checked = 0
        worst_err_pct = 0.0
        min_deadband_pct = 100.0
        max_duty_pct = 0.0

        for midi in range(57, 106):  # A3 (220 Hz) .. A7 (3520 Hz)
            hz = int(lib.vernie_midi_to_hz(midi))
            if hz < 220 or hz > 3520:
                errors.append(f"MIDI {midi} mapped to out-of-range frequency {hz} Hz")
                continue

            for vol in (10, 50, 75, 100):
                pwm = _VernieSynthPwmC()
                if not lib.vernie_synth_calc_pwm(hz, vol, ctypes.byref(pwm)):
                    errors.append(f"vernie_synth_calc_pwm failed for MIDI {midi} ({hz} Hz, vol {vol}%)")
                    continue

                notes_checked += 1
                actual_hz = CLK_HZ / ((pwm.psc + 1) * (pwm.arr + 1))
                err_pct = abs(actual_hz - hz) * 100.0 / hz
                worst_err_pct = max(worst_err_pct, err_pct)

                duty_pct = (pwm.ccr1 * 100.0) / pwm.arr
                deadband_pct = ((pwm.ccr2 - pwm.ccr1) * 100.0) / pwm.arr
                max_duty_pct = max(max_duty_pct, duty_pct)
                min_deadband_pct = min(min_deadband_pct, deadband_pct)

                if err_pct > max_error_pct:
                    errors.append(f"MIDI {midi} ({hz} Hz): pitch error {err_pct:.4f}% > {max_error_pct}%")
                if pwm.ccr2 != pwm.arr - pwm.ccr1:
                    errors.append(f"MIDI {midi}: asymmetric bipolar PWM (ccr1={pwm.ccr1}, ccr2={pwm.ccr2}, arr={pwm.arr})")
                if duty_pct > 15.0 + 1e-9:
                    errors.append(f"MIDI {midi}: duty {duty_pct:.2f}% exceeds 15% cap")
                if deadband_pct < 70.0 - 1e-9:
                    errors.append(f"MIDI {midi}: dead-band {deadband_pct:.2f}% below 70% minimum")

    return {
        "verdict": "PASS" if not errors else "FAIL",
        "source": str(source_path),
        "cases_checked": notes_checked,
        "worst_pitch_error_pct": round(worst_err_pct, 5),
        "max_duty_pct": round(max_duty_pct, 3),
        "min_deadband_pct": round(min_deadband_pct, 3),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Attest bipolar singing-motor PWM divider accuracy & 0V DC symmetry.")
    parser.add_argument("--source", type=Path, required=True, help="Path to firmware/src/vernie_synth.c")
    parser.add_argument("--max-error-pct", type=float, default=0.5)
    args = parser.parse_args()

    result = attest_pwm_synth(args.source, max_error_pct=args.max_error_pct)
    print(json.dumps(result, indent=2))
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
