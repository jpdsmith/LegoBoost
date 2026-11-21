# SPDX-License-Identifier: MIT
# Vernie OS Standalone Firmware Makefile (LEGO BOOST Move Hub / STM32F070RB)
# Pure-MIT bare-metal C build on top of Pybricks lib/pbio (NO MicroPython, NO proprietary telemetry.c).

TOP        := $(abspath ..)
PBTOP      := $(TOP)/third_party/pybricks-micropython
STM32LIB   := $(TOP)/third_party/stm32lib
CMSIS6     := $(TOP)/third_party/CMSIS_6
BUILD      := build
FW_VERSION ?= vernie-os-0.1.0
HUB_NAME   ?= VernieOS

CROSS_COMPILE ?= arm-none-eabi-
CC      := $(CROSS_COMPILE)gcc
AS      := $(CROSS_COMPILE)as
OBJCOPY := $(CROSS_COMPILE)objcopy
SIZE    := $(CROSS_COMPILE)size
HOST_CC ?= gcc
PYTHON  ?= python3

PB_GIT_HASH := $(shell git -C $(PBTOP) rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Include order: our config/ overrides BEFORE upstream platform/move_hub/
INC := \
	-Iconfig \
	-Isrc \
	-I$(BUILD) \
	-isystem $(CMSIS6)/CMSIS/Core/Include \
	-isystem $(STM32LIB)/CMSIS/STM32F0xx/Include \
	-isystem $(STM32LIB)/STM32F0xx_HAL_Driver/Inc \
	-isystem $(PBTOP)/lib/lego \
	-isystem $(PBTOP)/lib/lwrb/src/include \
	-isystem $(PBTOP)/lib/pbio/include \
	-isystem $(PBTOP)/lib/pbio/platform/move_hub \
	-isystem $(PBTOP)/lib/pbio \
	-isystem $(PBTOP)/lib/BlueNRG-MS/includes

CFLAGS_MCU := -mthumb -mtune=cortex-m0 -mcpu=cortex-m0 -msoft-float
CFLAGS_COMMON := \
	$(INC) \
	-std=c11 \
	-nostdlib \
	-fshort-enums \
	-fsingle-precision-constant \
	-ffunction-sections \
	-fdata-sections \
	-Os \
	-DNDEBUG \
	-DSTM32F070xB \
	-DSTM32_H='<stm32f0xx.h>' \
	-DSTM32_HAL_H='<stm32f0xx_hal.h>' \
	-DUSE_FULL_LL_DRIVER \
	-DHSE_VALUE=0 \
	$(CFLAGS_MCU)

CFLAGS_VERNIE := $(CFLAGS_COMMON) -MMD -MP -Wall -Wextra -Werror -Wshadow -Wdouble-promotion
CFLAGS_VENDOR := $(CFLAGS_COMMON) -MMD -MP -Wall -Wextra -Werror -Wno-unused-parameter -Wno-maybe-uninitialized -Wno-sign-compare -Wdouble-promotion
CFLAGS_FREESTANDING := $(CFLAGS_VERNIE) -ffreestanding -fno-builtin -fno-tree-loop-distribute-patterns

AFLAGS := -mcpu=cortex-m0 -mthumb

LD_FILES := \
	linker/vernie_movehub.ld \
	$(PBTOP)/lib/pbio/platform/arm_common.ld

LDFLAGS := $(addprefix -T,$(LD_FILES)) -Wl,-Map=$(BUILD)/firmware.elf.map -Wl,--cref -Wl,--gc-sections
LIBGCC  := $(shell $(CC) $(CFLAGS_MCU) -print-libgcc-file-name)

# --- Vernie OS Application Sources ---
VERNIE_SRC_C := \
	src/main.c \
	src/vernie_protocol.c \
	src/vernie_runtime.c \
	src/string_minimal.c

# --- Pure-MIT Pybricks lib/pbio + Move Hub Driver Sources (NO telemetry.c, NO block_device) ---
PBIO_SRC_C := $(addprefix $(PBTOP)/,\
	lib/lwrb/src/lwrb/lwrb.c \
	lib/pbio/drv/adc/adc_stm32f0.c \
	lib/pbio/drv/battery/battery_adc.c \
	lib/pbio/drv/bluetooth/bluetooth_stm32_bluenrg.c \
	lib/pbio/drv/button/button_gpio.c \
	lib/pbio/drv/clock/clock_stm32.c \
	lib/pbio/drv/core.c \
	lib/pbio/drv/counter/counter_stm32f0_gpio_quad_enc.c \
	lib/pbio/drv/gpio/gpio_stm32.c \
	lib/pbio/drv/hardware/hardware_stm32.c \
	lib/pbio/drv/ioport/ioport.c \
	lib/pbio/drv/led/led_core.c \
	lib/pbio/drv/led/led_pwm.c \
	lib/pbio/drv/motor_driver/motor_driver_hbridge_pwm.c \
	lib/pbio/drv/pwm/pwm_core.c \
	lib/pbio/drv/pwm/pwm_stm32_tim.c \
	lib/pbio/drv/reset/reset_stm32.c \
	lib/pbio/drv/stack/stack_embedded.c \
	lib/pbio/drv/uart/uart_stm32f0.c \
	lib/pbio/drv/watchdog/watchdog_stm32.c \
	lib/pbio/platform/move_hub/platform.c \
	lib/pbio/src/angle.c \
	lib/pbio/src/battery.c \
	lib/pbio/src/bluetooth.c \
	lib/pbio/src/busy_count.c \
	lib/pbio/src/color/color_map.c \
	lib/pbio/src/color/conversion.c \
	lib/pbio/src/color/util.c \
	lib/pbio/src/control_settings.c \
	lib/pbio/src/control.c \
	lib/pbio/src/dcmotor.c \
	lib/pbio/src/differentiator.c \
	lib/pbio/src/drivebase.c \
	lib/pbio/src/error.c \
	lib/pbio/src/geometry.c \
	lib/pbio/src/int_math.c \
	lib/pbio/src/integrator.c \
	lib/pbio/src/light/animation.c \
	lib/pbio/src/light/color_light.c \
	lib/pbio/src/main.c \
	lib/pbio/src/motor_process.c \
	lib/pbio/src/motor/servo_settings.c \
	lib/pbio/src/observer.c \
	lib/pbio/src/os.c \
	lib/pbio/src/parent.c \
	lib/pbio/src/port_dcm/port_dcm_pup.c \
	lib/pbio/src/port_lump/protocol.c \
	lib/pbio/src/port_lump/sensors.c \
	lib/pbio/src/port.c \
	lib/pbio/src/protocol/pybricks.c \
	lib/pbio/src/servo.c \
	lib/pbio/src/tacho.c \
	lib/pbio/src/trajectory.c \
	lib/pbio/src/util.c \
	lib/pbio/sys/battery.c \
	lib/pbio/sys/command.c \
	lib/pbio/sys/core.c \
	lib/pbio/sys/hmi_none.c \
	lib/pbio/sys/host.c \
	lib/pbio/sys/light.c \
	lib/pbio/sys/main.c \
	lib/pbio/sys/program_stop.c \
	lib/pbio/sys/status.c \
	lib/pbio/sys/storage_settings.c \
	)

BLUENRG_SRC_C := $(addprefix $(PBTOP)/lib/BlueNRG-MS/hci/,\
	controller/bluenrg_gap_aci.c \
	controller/bluenrg_gatt_aci.c \
	controller/bluenrg_hal_aci.c \
	controller/bluenrg_l2cap_aci.c \
	controller/bluenrg_updater_aci.c \
	hci_le.c \
	)

STM32_HAL_SRC_C := $(addprefix $(STM32LIB)/STM32F0xx_HAL_Driver/Src/,\
	stm32f0xx_hal.c \
	stm32f0xx_hal_cortex.c \
	stm32f0xx_hal_dma.c \
	stm32f0xx_hal_flash.c \
	stm32f0xx_hal_flash_ex.c \
	stm32f0xx_hal_gpio.c \
	stm32f0xx_hal_rcc.c \
	stm32f0xx_hal_rcc_ex.c \
	)

STARTUP_SRC_S := $(PBTOP)/lib/pbio/platform/move_hub/startup.s

VERNIE_OBJ  := $(patsubst %.c,$(BUILD)/vernie/%.o,$(VERNIE_SRC_C))
PBIO_OBJ    := $(patsubst $(PBTOP)/%.c,$(BUILD)/pbio/%.o,$(PBIO_SRC_C))
BLUENRG_OBJ := $(patsubst $(PBTOP)/%.c,$(BUILD)/bluenrg/%.o,$(BLUENRG_SRC_C))
HAL_OBJ     := $(patsubst $(STM32LIB)/%.c,$(BUILD)/hal/%.o,$(STM32_HAL_SRC_C))
STARTUP_OBJ := $(BUILD)/startup.o

ALL_OBJ := $(STARTUP_OBJ) $(VERNIE_OBJ) $(PBIO_OBJ) $(BLUENRG_OBJ) $(HAL_OBJ)
ALL_DEP := $(patsubst %.o,%.d,$(VERNIE_OBJ) $(PBIO_OBJ) $(BLUENRG_OBJ) $(HAL_OBJ))

FW_SECTIONS := -j .isr_vector -j .text -j .data -j .name

.PHONY: all clean test verify-gates

all: $(BUILD)/firmware.zip $(BUILD)/firmware.bin

$(BUILD)/pbio_version_hash.h:
	@mkdir -p $(dir $@)
	@printf '#define PBIO_VERSION_HASH "%s"\n' "$(PB_GIT_HASH)" > $@

$(ALL_OBJ): | $(BUILD)/pbio_version_hash.h

$(BUILD)/startup.o: $(STARTUP_SRC_S)
	@mkdir -p $(dir $@)
	$(AS) $(AFLAGS) -o $@ $<

$(BUILD)/vernie/src/string_minimal.o: src/string_minimal.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS_FREESTANDING) -c -o $@ $<

$(BUILD)/vernie/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS_VERNIE) -c -o $@ $<

$(BUILD)/pbio/%.o: $(PBTOP)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS_VENDOR) -c -o $@ $<

$(BUILD)/bluenrg/%.o: $(PBTOP)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS_VENDOR) -c -o $@ $<

$(BUILD)/hal/%.o: $(STM32LIB)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS_VENDOR) -c -o $@ $<

$(BUILD)/firmware.elf: $(ALL_OBJ) $(LD_FILES)
	$(CC) $(CFLAGS_MCU) -nostdlib $(LDFLAGS) -o $@ $(ALL_OBJ) "$(LIBGCC)"
	$(SIZE) -A $@

$(BUILD)/firmware-base.bin: $(BUILD)/firmware.elf
	$(OBJCOPY) -O binary $(FW_SECTIONS) $< $@
	@wc -c $@

$(BUILD)/firmware.zip $(BUILD)/firmware.bin &: $(BUILD)/firmware-base.bin $(BUILD)/firmware.elf
	$(PYTHON) $(TOP)/tools/pack_firmware.py \
		--base-bin $(BUILD)/firmware-base.bin \
		--map-file $(BUILD)/firmware.elf.map \
		--elf-file $(BUILD)/firmware.elf \
		--version $(FW_VERSION) \
		--hub-name $(HUB_NAME) \
		--out-zip $(BUILD)/firmware.zip \
		--out-bin $(BUILD)/firmware.bin \
		--verify

verify-gates: $(BUILD)/firmware.zip $(BUILD)/firmware.bin
	$(PYTHON) $(TOP)/docs/references/attesters/attest_flash_ram.py --elf $(BUILD)/firmware.elf --map $(BUILD)/firmware.elf.map --max-flash 46080 --max-ram 8192
	$(PYTHON) $(TOP)/docs/references/attesters/attest_lwp3_checksum.py --bin $(BUILD)/firmware.bin --checksum-size 108544

# --- Layer 3: Host-compiled C unit tests with ASan + UBSan ---
HOST_TEST_FLAGS := -std=c11 -Wall -Wextra -Werror -Wshadow -g -O1 -fsanitize=address,undefined -Isrc

test:
	@mkdir -p $(BUILD)/host_tests
	$(HOST_CC) $(HOST_TEST_FLAGS) \
		src/vernie_protocol.c \
		tests/test_vernie_protocol.c \
		-o $(BUILD)/host_tests/test_vernie_protocol
	$(BUILD)/host_tests/test_vernie_protocol
	$(HOST_CC) $(HOST_TEST_FLAGS) \
		src/vernie_protocol.c \
		src/vernie_runtime.c \
		tests/test_vernie_runtime.c \
		-o $(BUILD)/host_tests/test_vernie_runtime
	$(BUILD)/host_tests/test_vernie_runtime
	$(HOST_CC) $(HOST_TEST_FLAGS) -fno-builtin -fno-tree-loop-distribute-patterns \
		tests/test_string_minimal.c \
		-o $(BUILD)/host_tests/test_string_minimal
	$(BUILD)/host_tests/test_string_minimal

-include $(ALL_DEP)

clean:
	rm -rf $(BUILD)
