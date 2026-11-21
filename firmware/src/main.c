// SPDX-License-Identifier: MIT
// Vernie OS Phase 1 Bring-Up Firmware for LEGO BOOST Move Hub (STM32F070RB).
//
// Features verified in Phase 1:
//   - Pure-MIT build (compile-time guard enforces PBSYS_CONFIG_TELEMETRY == 0)
//   - Auto-boot via PBSYS_CONFIG_HMI_NONE == 1 (no second button press needed)
//   - Resilient BLE advertising at boot, on host disconnect, and on GAP-only disconnect
//   - Watchdog Safe Mode on PBDRV_RESET_REASON_WATCHDOG (motors coasted, red/blue alert)
//   - Debounced short green-button press cycles mode_id (2-second hold cleanly shuts hub down)
//   - Live 10 Hz 18-byte binary telemetry over Pybricks AppData + RX command handling
//   - Instant software reboot into LEGO bootloader via Pybricks L1 command [0x05]

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

#include "vernie_runtime.h"

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
static volatile bool g_stop_requested = false;

// --- pbsys_main application hooks ---

pbio_error_t pbsys_main_program_validate(pbsys_main_program_t *program) {
    (void)program;
    return PBIO_SUCCESS;
}

void pbsys_main_stop_program(bool force_stop) {
    // Only stop Vernie OS on forced shutdown (e.g., 2s button hold or critical battery).
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

// --- Cooperative Vernie OS runtime process ---

static pbio_error_t vernie_os_thread(pbio_os_state_t *state, void *context) {
    (void)context;
    static pbio_os_timer_t tick_timer;
    static pbio_os_state_t ble_sub;
    static pbio_os_state_t tx_sub;
    static bool tx_in_flight;
    static pbio_error_t adv_err;

    PBIO_OS_ASYNC_BEGIN(state);

    tx_in_flight = false;
    pbio_os_timer_set(&tick_timer, 20);

    // Attempt initial BLE advertising immediately after auto-boot; if busy/failed,
    // vernie_runtime_tick() retries automatically every 500 ms.
    adv_err = pbio_bluetooth_start_advertising(true);
    if (adv_err == PBIO_SUCCESS) {
        ble_sub = 0;
        PBIO_OS_AWAIT(state, &ble_sub, (adv_err = pbio_bluetooth_await_advertise_or_scan_command(&ble_sub, NULL)));
    }
    vernie_runtime_on_adv_result(&g_rt, pbdrv_clock_get_ms(), adv_err == PBIO_SUCCESS && vernie_is_adv_active());

    while (!vernie_should_stop()) {
        PBIO_OS_AWAIT_UNTIL(state, pbio_os_timer_is_expired(&tick_timer) || vernie_should_stop());
        if (vernie_should_stop()) {
            break;
        }
        pbio_os_timer_reset(&tick_timer);

        // Advance in-flight telemetry TX notification before evaluating next tick.
        if (tx_in_flight) {
            pbio_error_t tx_err = pbsys_host_send_app_data(&tx_sub, g_rt.telemetry_buf, VERNIE_TELEMETRY_BYTES);
            if (tx_err != PBIO_ERROR_AGAIN) {
                tx_in_flight = false;
            }
        }

        uint16_t batt_mv = 0;
        (void)pbdrv_battery_get_voltage_now(&batt_mv);

        vernie_tick_actions_t actions;
        vernie_runtime_tick(
            &g_rt,
            pbdrv_clock_get_ms(),
            pbsys_host_is_connected(),
            vernie_is_adv_active(),
            (pbdrv_button_get_pressed() & PBIO_BUTTON_CENTER) != 0,
            tx_in_flight,
            batt_mv,
            &actions
        );

        if (actions.need_clear_pending) {
            tx_in_flight = false;
            pbsys_host_app_data_clear_pending();
        }

        if (actions.led_changed) {
            vernie_apply_led(&actions.led);
        }

        if (actions.send_telemetry) {
            tx_sub = 0;
            pbio_error_t tx_err = pbsys_host_send_app_data(&tx_sub, g_rt.telemetry_buf, VERNIE_TELEMETRY_BYTES);
            tx_in_flight = (tx_err == PBIO_ERROR_AGAIN);
        }

        if (actions.need_start_adv) {
            adv_err = pbio_bluetooth_start_advertising(true);
            if (adv_err == PBIO_SUCCESS) {
                ble_sub = 0;
                PBIO_OS_AWAIT(
                    state,
                    &ble_sub,
                    (adv_err = pbio_bluetooth_await_advertise_or_scan_command(&ble_sub, NULL))
                );
            }
            vernie_runtime_on_adv_result(
                &g_rt,
                pbdrv_clock_get_ms(),
                adv_err == PBIO_SUCCESS && vernie_is_adv_active()
            );
        }
    }

    pbsys_host_app_data_clear_pending();
    PBIO_OS_ASYNC_END(PBIO_SUCCESS);
}

void pbsys_main_run_program(pbsys_main_program_t *program) {
    (void)program;

    bool safe_mode = (pbdrv_reset_get_reason() == PBDRV_RESET_REASON_WATCHDOG);
    vernie_runtime_init(&g_rt, safe_mode);
    g_stop_requested = false;

    // Disable short-press program stop so green button cycles modes; 2s hold still shuts down.
    pbsys_program_stop_set_buttons(0);
    pbsys_command_set_write_app_data_callback(vernie_on_app_data_rx);

    static pbio_os_process_t vernie_proc;
    pbio_os_process_start(&vernie_proc, vernie_os_thread, NULL);

    while (vernie_proc.err == PBIO_ERROR_AGAIN) {
        pbio_os_run_processes_and_wait_for_event();
    }
}
