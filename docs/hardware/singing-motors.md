---
type: Hardware Spec
title: Symmetrical Bipolar Singing-Motor Synthesizer
description: Zero-DC-creep 2-voice hardware PWM audio synthesis on STM32F070RB TIM1 (Port A) and TIM3 (confirmed Head Port C/D) with exact pbio 12 kHz timer restore.
resource: ../../firmware/src/vernie_synth.c
tags: [hardware, pwm, synth, tim1, tim3, stm32f0]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T16:15:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T16:18:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-movehub-platform
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/platform/move_hub/platform.c
    title: Pybricks Move Hub TIM1/TIM3 H-bridge GPIO and channel mapping
    author: team:pybricks
  - id: pybricks-pwm-tim
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/lib/pbio/drv/pwm/pwm_stm32_tim.c
    title: Pybricks STM32 timer PWM initialization and 12 kHz inverted register contract
    author: team:pybricks
---

# Hardware Timer & Channel Mapping

Verified directly from Move Hub `platform.c` (note that `platform.c:270` contains an upstream comment typo regarding Port D channels; the code uses CH2/CH4 for Port D and CH3/CH1 for Port C):[^pybricks-movehub-platform]

| Synth Voice | Port | Timer | `pin1` (Mode 1) | `pin2` (Mode 2) |
| :--- | :---: | :---: | :--- | :--- |
| **Voice 1 (Tracks / Bass)** | Port A | `TIM1` | `PA8` / AF2 / CH1 | `PA10` / AF2 / CH3 |
| **Voice 2 (Head / Melody)** | Port C | `TIM3` | `PC8` / AF0 / CH3 | `PC6` / AF0 / CH1 |
| **Voice 2 (Head / Melody)** | Port D | `TIM3` | `PC7` / AF0 / CH2 | `PC9` / AF0 / CH4 |

# Zero-DC-Creep 3-Level Bipolar Physics

Because both LB1836 H-bridge pins of a motor share one STM32 timer, driving `pin1` in non-inverted **PWM Mode 1** (`CCR1 = d`, HIGH on `[0, d)`) and `pin2` in non-inverted **PWM Mode 2** (`CCR2 = ARR - d`, HIGH on `[ARR - d, ARR]`) produces:
- A symmetrical `-V` pulse of width `d`
- A coast dead-band of width `ARR - 2d >= 0.70 * ARR` (both pins LOW)
- An equal `+V` pulse of width `d`

Net DC average across the motor coil is **0.0 V**, preventing track creep and head drift while capping half-cycle duty `<= 15%` and continuous tone time `<= 3000 ms` (with mandatory `500 ms` thermal cooldown). Pitch accuracy (`<= 0.5%`, measured `0.00273%` worst-case across MIDI A3–A7) is verified by [PWM Synth Divider Table](../computations/pwm-synth-dividers.md).

# Timer Arbitration & `pbio` Restore Contract

Before touching `TIM1` or `TIM3`, `vernie_synth` coasts the paired ports (`A & B` for `TIM1`; confirmed head motor `C` or `D` for `TIM3` only when the sibling port is safe). Immediately upon yield or completion, pins are forced GPIO LOW and `pbio`'s exact `pwm_stm32_tim.c` defaults (`PSC = 3`, `ARR = 1000`, `CCR1..4 = 0`, `CCMR1 = CCMR2 = 0x6868`, `CCER = 0x3333`, `TIM1->BDTR |= MOE`, `CR1 = CEN`, `EGR = UG`) are restored.[^pybricks-pwm-tim]

[^pybricks-movehub-platform]: Pybricks `lib/pbio/platform/move_hub/platform.c` Move Hub timer pinout
[^pybricks-pwm-tim]: Pybricks `lib/pbio/drv/pwm/pwm_stm32_tim.c` 12 kHz inverted PWM setup
