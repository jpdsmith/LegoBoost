---
type: Attested Computation
title: Singing-Motor Bipolar PWM Divider Table
description: Deterministic verification that vernie_synth_calc_pwm achieves <= 0.5% pitch accuracy and exact 0.0 V DC bipolar symmetry across MIDI A3–A7 at 48 MHz.
status: stable
runtime: python
computation: ../references/attesters/attest_pwm_synth.py
parameters:
  - { name: source, type: path, required: true }
  - { name: max_error_pct, type: number, required: false }
executor:
  resource: ../references/executors/run-pwm-synth.md
  receipt: [verdict, cases_checked, worst_pitch_error_pct, max_duty_pct, min_deadband_pct, errors]
attester:
  resource: ../references/attesters/attest_pwm_synth.py
generated: { by: antigravity/1.0, at: 2026-11-21T16:15:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T16:18:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: vernie-synth-c
    resource: ../../firmware/src/vernie_synth.c
    title: Vernie OS 2-voice bipolar PWM synthesizer C implementation
    author: human:jpdsmith
  - id: singing-motors-spec
    resource: ../hardware/singing-motors.md
    title: Symmetrical Bipolar Singing-Motor Hardware Spec
---

# Overview

Compiles `firmware/src/vernie_synth.c` directly via `gcc -shared` and exhaustively checks `vernie_synth_calc_pwm()` across all 49 MIDI notes from A3 (`220 Hz`) to A7 (`3520 Hz`) at 4 volume levels (`196` total cases), attesting pitch error `<= 0.5%`, `PSC <= 65535`, `ARR <= 65535`, `ccr2 == (ARR + 1) - ccr1`, `duty <= 15%`, and coast dead-band `>= 70%`.[^vernie-synth-c][^singing-motors-spec]

[^vernie-synth-c]: Vernie OS `firmware/src/vernie_synth.c` divider calculator
[^singing-motors-spec]: Vernie OS Singing-Motor Hardware Specification
