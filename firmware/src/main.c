// SPDX-License-Identifier: MIT
// Vernie OS Phase 2 Firmware for LEGO BOOST Move Hub (STM32F070RB).
//
// Features:
//   - Pure-MIT build (compile-time guard enforces PBSYS_CONFIG_TELEMETRY == 0)
//   - Auto-boot via PBSYS_CONFIG_HMI_NONE == 1 + Watchdog Safe Mode
//   - Non-blocking resilient BLE advertising (never stalls 50 Hz safety/shutdown loop)
//   - Native SPI1 LIS3DH 3-axis accelerometer (upright torso, pickup/bump/stationary double-tap)
//   - Port C/D auto-detection, non-trigger single-direction head homing, armed-only dart launcher
//   - 88007 Color & Distance Sensor (SPEC1 combined sensing + 4-state COL_O chest LED)
//   - 2-voice symmetrical bipolar singing-motor synth (TIM1 & TIM3) with R2-D2 SFX & 3s thermal cap
//   - CRC32 persistent calibration/macros in unchecked FLASH_USER_1 (0x0801F800)

#include <stdbool.h>
#include <stdint.h>

#include <pbdrv/battery.h>
#include <pbdrv/bluetooth.h>
#include <pbdrv/button.h>
#include <pbdrv/clock.h>
#include <pbdrv/reset.h>
#include <pbio/bluetooth.h>
#include <pbio/color.h>
#include <pbio/error.h>
#include <pbio/light.h>
#include <pbio/os.h>
#include <pbsys/command.h>
#include <pbsys/config.h>
#include <pbsys/host.h>
#include <pbsys/light.h>
#include <pbsys/main.h>
#include <pbsys/program_stop.h>
#include <pbsys/status.h>

#include "vernie_hw.h"
#include "vernie_imu.h"
#include "vernie_runtime.h"
#include "vernie_storage.h"
#include "vernie_synth.h"

// Layer 1 static licensing & memory-safety compile-time assertions.
#if PBSYS_CONFIG_TELEMETRY != 0
#error "PBSYS_CONFIG_TELEMETRY must be 0 to guarantee a pure-MIT build."
#endif

#if PBDRV_CONFIG_BLOCK_DEVICE != 0 || PBSYS_CONFIG_STORAGE != 0
#error "Pybricks block device/storage must be 0 so SRAM fits and FLASH_USER_0 stays untouched."
#endif

#if PBSYS_CONFIG_HMI_NONE != 1 || PBSYS_CONFIG_HMI_PUP != 0
#error "Vernie OS requires PBSYS_CONFIG_HMI_NONE=1 for immediate auto-boot."
#endif

static vernie_runtime_t g_rt;
static vernie_storage_t g_storage;
static vernie_imu_t g_imu;
static vernie_synth_t g_synth;
static vernie_hw_t g_hw;
static volatile bool g_stop_requested = false;

// --- pbsys_main application hooks ---

pbio_error_t pbsys_main_program_validate(pbsys_main_program_t *program) {
    (void)program;
    return PBIO_SUCCESS;
}

void pbsys_main_stop_program(bool force_stop) {
    if (force_stop) {
        g_stop_requested = true;
    }
}

bool pbsys_main_stdin_event(uint8_t c) {
    (void)c;
    return false;
}

void pbsys_main_run_program_cleanup(void) {
    pbsys_command_set_write_app_data_callback(NULL);
    pbsys_host_app_data_clear_pending();
    vernie_synth_stop_all(&g_synth);
    vernie_hw_coast_all(&g_hw);
    (void)vernie_storage_try_flush(&g_storage, false);
}

// --- BLE AppData RX handler (<= 17 bytes inside PBIO_PYBRICKS_COMMAND_WRITE_APP_DATA) ---

static pbio_error_t vernie_on_app_data_rx(uint16_t offset, uint32_t size, const uint8_t *data) {
    vernie_parse_result_t res = vernie_runtime_on_rx(&g_rt, offset, data, (size_t)size, pbdrv_clock_get_ms());
    if (res == VERNIE_PARSE_OK) {
        return PBIO_SUCCESS;
    }
    if (res == VERNIE_PARSE_ERR_INTERLOCK) {
        return PBIO_ERROR_INVALID_OP;
    }
    return PBIO_ERROR_INVALID_ARG;
}

// --- Hub LED output helper ---

static void vernie_apply_led(const vernie_led_cmd_t *led) {
    if (led->kind == VERNIE_LED_KIND_RGB) {
        pbio_color_rgb_t rgb = {
            .r = led->a,
            .g = led->b,
            .b = led->c,
        };
        pbio_color_light_on(pbsys_status_light_main, pbio_color_from_rgb(&rgb));
    } else {
        pbio_color_light_on(pbsys_status_light_main, PBIO_COLOR_ENCODE(led->hue, led->a, led->b));
    }
}

static bool vernie_is_adv_active(void) {
    return pbdrv_bluetooth_advertising_state == PBDRV_BLUETOOTH_ADVERTISING_STATE_ADVERTISING_PYBRICKS;
}

static bool vernie_should_stop(void) {
    return g_stop_requested || pbsys_status_test(PBIO_PYBRICKS_STATUS_SHUTDOWN_REQUEST);
}

// --- Cooperative Vernie OS 50 Hz runtime process ---

static pbio_error_t vernie_os_thread(pbio_os_state_t *state, void *context) {
    (void)context;
    static pbio_os_timer_t tick_timer;
    static pbio_os_state_t ble_sub;
    static pbio_os_state_t tx_sub;
    static bool adv_in_flight;
    static bool tx_in_flight;

    PBIO_OS_ASYNC_BEGIN(state);

    adv_in_flight = false;
    tx_in_flight = false;
    pbio_os_timer_set(&tick_timer, 20);

    // Play friendly startup boot chime if not in Watchdog Safe Mode.
    if (!g_rt.ctrl.safe_mode) {
        (void)vernie_synth_command(
            &g_synth, VERNIE_SYNTH_VOICE_TRACKS, VERNIE_SFX_BOOT_CHIME, 0u, pbdrv_clock_get_ms()
        );
    }

    while (!vernie_should_stop()) {
        PBIO_OS_AWAIT_UNTIL(state, pbio_os_timer_is_expired(&tick_timer) || vernie_should_stop());
        if (vernie_should_stop()) {
            break;
        }
        pbio_os_timer_reset(&tick_timer);

        uint32_t now_ms = pbdrv_clock_get_ms();

        // 1. Advance non-blocking BLE advertising request (never stalls 50 Hz loop or shutdown!).
        if (adv_in_flight) {
            pbio_error_t adv_err = pbio_bluetooth_await_advertise_or_scan_command(&ble_sub, NULL);
            if (adv_err != PBIO_ERROR_AGAIN) {
                adv_in_flight = false;
                vernie_runtime_on_adv_result(&g_rt, now_ms, adv_err == PBIO_SUCCESS && vernie_is_adv_active());
            }
        }

        // 2. Advance non-blocking telemetry TX notification.
        if (tx_in_flight) {
            pbio_error_t tx_err = pbsys_host_send_app_data(&tx_sub, g_rt.telemetry_buf, VERNIE_TELEMETRY_BYTES);
            if (tx_err != PBIO_ERROR_AGAIN) {
                tx_in_flight = false;
            }
        }

        // 3. Dispatch pending BLE synth command & advance 2-voice bipolar synth / thermal watchdog.
        if (g_rt.ctrl.synth_cmd_pending) {
            g_rt.ctrl.synth_cmd_pending = false;
            (void)vernie_synth_command(
                &g_synth,
                g_rt.ctrl.synth_voice,
                g_rt.ctrl.synth_preset_or_note,
                g_rt.ctrl.synth_dur_ms,
                now_ms
            );
        }
        vernie_synth_tick(&g_synth, now_ms);

        // 4. Step motors, Port C/D auto-detect, head homing/dart FSM, and 88007 sensor.
        vernie_hw_snapshot_t snap;
        vernie_hw_step(&g_hw, &g_rt.ctrl, &g_synth, g_imu.picked_up, now_ms, &snap);

        // 5. Poll native SPI1 LIS3DH IMU (fused with real track motion & stall state).
        (void)vernie_imu_poll(&g_imu, snap.tracks_moving, snap.tracks_stalled, now_ms);
        bool tap_event = vernie_imu_consume_tap_event(&g_imu);

        snap.pitch_deg = g_imu.pitch_deg;
        snap.roll_deg = g_imu.roll_deg;
        snap.picked_up = g_imu.picked_up;
        snap.bump = g_imu.bump_detected;
        snap.tap = tap_event || (g_imu.tap_hold_until_ms != 0u && (int32_t)(now_ms - g_imu.tap_hold_until_ms) < 0);
        snap.synth_active = vernie_synth_is_active(&g_synth);

        // 6. Step runtime state machine (BLE advertising, mode cycling, LED caching, 10 Hz telemetry).
        vernie_tick_actions_t actions;
        vernie_runtime_tick(
            &g_rt,
            now_ms,
            pbsys_host_is_connected(),
            vernie_is_adv_active(),
            adv_in_flight,
            (pbdrv_button_get_pressed() & PBIO_BUTTON_CENTER) != 0,
            tap_event,
            tx_in_flight,
            snap.battery_mv,
            &snap,
            &actions
        );

        if (actions.need_clear_pending) {
            tx_in_flight = false;
            pbsys_host_app_data_clear_pending();
            vernie_synth_stop_all(&g_synth);
            vernie_hw_coast_all(&g_hw);
        }

        if (actions.mode_cycled && !g_rt.ctrl.safe_mode) {
            (void)vernie_synth_command(
                &g_synth, VERNIE_SYNTH_VOICE_BOTH, VERNIE_SFX_MODE_TICK, 0u, now_ms
            );
        }

        if (actions.led_changed) {
            vernie_apply_led(&actions.led);
        }

        if (actions.send_telemetry) {
            tx_sub = 0;
            pbio_error_t tx_err = pbsys_host_send_app_data(&tx_sub, g_rt.telemetry_buf, VERNIE_TELEMETRY_BYTES);
            tx_in_flight = (tx_err == PBIO_ERROR_AGAIN);
        }

        if (actions.need_start_adv && !adv_in_flight) {
            pbio_error_t start_err = pbio_bluetooth_start_advertising(true);
            if (start_err == PBIO_SUCCESS) {
                ble_sub = 0;
                pbio_error_t poll_err = pbio_bluetooth_await_advertise_or_scan_command(&ble_sub, NULL);
                if (poll_err == PBIO_ERROR_AGAIN) {
                    adv_in_flight = true;
                } else {
                    vernie_runtime_on_adv_result(&g_rt, now_ms, poll_err == PBIO_SUCCESS && vernie_is_adv_active());
                }
            } else {
                vernie_runtime_on_adv_result(&g_rt, now_ms, false);
            }
        }

        // 7. Flush dirty FLASH_USER_1 calibration/macros ONLY when motors & synth are idle.
        if (g_storage.dirty && !snap.motors_active && !snap.synth_active) {
            (void)vernie_storage_try_flush(&g_storage, false);
        }
    }

    vernie_synth_stop_all(&g_synth);
    vernie_hw_coast_all(&g_hw);
    (void)vernie_storage_try_flush(&g_storage, false);
    pbsys_host_app_data_clear_pending();
    PBIO_OS_ASYNC_END(PBIO_SUCCESS);
}

void pbsys_main_run_program(pbsys_main_program_t *program) {
    (void)program;

    bool safe_mode = (pbdrv_reset_get_reason() == PBDRV_RESET_REASON_WATCHDOG);
    g_stop_requested = false;

    vernie_flash_backend_t flash_backend = vernie_storage_stm32_backend();
    (void)vernie_storage_init(&g_storage, &flash_backend, VERNIE_FLASH_USER_1_ADDR);

    vernie_runtime_init(&g_rt, safe_mode);
    if (!safe_mode) {
        g_rt.ctrl.mode_id = g_storage.blob.default_mode;
    }

    vernie_hw_init(&g_hw, g_storage.blob.head_home_offset_deg);

    vernie_synth_hal_t synth_hal = vernie_synth_stm32_hal(vernie_hw_coast_tracks, vernie_hw_coast_external);
    vernie_synth_init(&g_synth, &synth_hal, g_storage.blob.synth_volume_pct);

    vernie_imu_bus_t imu_bus = vernie_imu_stm32_spi1_bus();
    (void)vernie_imu_init(
        &g_imu, &imu_bus, g_storage.blob.imu_pitch_zero_deg, g_storage.blob.imu_roll_zero_deg
    );

    // Disable short-press program stop so green button cycles modes; 2s hold still shuts down.
    pbsys_program_stop_set_buttons(0);
    pbsys_command_set_write_app_data_callback(vernie_on_app_data_rx);

    static pbio_os_process_t vernie_proc;
    pbio_os_process_start(&vernie_proc, vernie_os_thread, NULL);

    while (vernie_proc.err == PBIO_ERROR_AGAIN) {
        pbio_os_run_processes_and_wait_for_event();
    }
}
