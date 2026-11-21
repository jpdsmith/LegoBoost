# Executors

* [Run Firmware Packager](run-pack-firmware.md) - Executes `tools/pack_firmware.py` to emit v2.0.0 `firmware.zip` and checksummed `firmware.bin`.
* [Run ELF Size & Pure-MIT Gate](run-elf-size.md) - Executes `attest_flash_ram.py` against `firmware/build/firmware.elf` and `.map`.
* [Run Bipolar PWM Synth Divider Attester](run-pwm-synth.md) - Executes `attest_pwm_synth.py` against `firmware/src/vernie_synth.c`.
