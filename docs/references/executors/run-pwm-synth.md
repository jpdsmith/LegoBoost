---
type: Executor
title: Run Bipolar PWM Synth Divider Attester
description: Invokes docs/references/attesters/attest_pwm_synth.py against firmware/src/vernie_synth.c.
resource: ../attesters/attest_pwm_synth.py
tags: [executor, synth, pwm, ci]
status: stable
generated: { by: antigravity/1.0, at: 2026-11-21T16:15:00Z }
verified:
  - { by: process:ci-build, at: 2026-11-21T16:18:00Z }
---

# Command

```bash
python3 docs/references/attesters/attest_pwm_synth.py \
  --source firmware/src/vernie_synth.c \
  --max-error-pct 0.5
```
