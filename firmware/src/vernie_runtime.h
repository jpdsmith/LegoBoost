// SPDX-License-Identifier: MIT
// Pure, HAL-independent Vernie OS runtime state machine.
// Shared identically between bare-metal STM32 firmware (main.c) and ASan/UBSan host tests.

#ifndef VERNIE_RUNTIME_H
#define VERNIE_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "vernie_hw.h"
#include "vernie_protocol.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VERNIE_BTN_SHORT_MIN_MS    (40u)
#define VERNIE_BTN_SHORT_MAX_MS    (800u)
#define VERNIE_ADV_RETRY_MS        (500u)  // Retry delay after boot/HCI busy failure
#define VERNIE_ADV_GAP_RETRY_MS    (2500u) // Longer backoff on GAP-only connect (allows BlueZ GATT discovery)
#define VERNIE_TELEMETRY_PERIOD_MS (100u)

typedef enum {
    VERNIE_LED_KIND_HSV = 0,
    VERNIE_LED_KIND_RGB = 1,
} vernie_led_kind_t;

typedef struct {
    vernie_led_kind_t kind;
    uint16_t hue; // Used when kind == VERNIE_LED_KIND_HSV (0..359)
    uint8_t a;    // sat (HSV) or r (RGB)
    uint8_t b;    // val (HSV) or g (RGB)
    uint8_t c;    // 0   (HSV) or b (RGB)
} vernie_led_cmd_t;

typedef struct {
    vernie_control_state_t ctrl;
    bool was_connected;
    bool was_adv_active;
    bool adv_retry_armed;
    uint32_t next_adv_retry_ms;
    bool prev_btn_pressed;
    bool btn_hold_active;
    uint32_t btn_press_start_ms;
    bool has_sent_tx;
    uint32_t last_tx_ms;
    uint8_t telemetry_seq;
    uint8_t telemetry_buf[VERNIE_TELEMETRY_BYTES];
    bool led_initialized;
    vernie_led_cmd_t last_led;
} vernie_runtime_t;

typedef struct {
    bool need_clear_pending;
    bool need_start_adv;
    bool led_changed;
    vernie_led_cmd_t led;
    bool send_telemetry;
    bool mode_cycled;
} vernie_tick_actions_t;

void vernie_runtime_init(vernie_runtime_t *rt, bool safe_mode);

/**
 * Decode and apply an incoming AppData RX command.
 * Returns VERNIE_PARSE_ERR_VALUE if offset != 0, or the codec/control result.
 */
vernie_parse_result_t vernie_runtime_on_rx(
    vernie_runtime_t *rt,
    uint16_t offset,
    const uint8_t *data,
    size_t size,
    uint32_t now_ms
);

/**
 * Advance Vernie OS runtime state by one cooperative tick and emit HAL actions.
 * `hw_snap` supplies live Phase 2 sensor/IMU/encoder/synth telemetry (NULL uses battery_mv fallback).
 */
void vernie_runtime_tick(
    vernie_runtime_t *rt,
    uint32_t now_ms,
    bool host_connected,
    bool adv_is_active,
    bool adv_in_flight,
    bool btn_pressed,
    bool imu_tap_event,
    bool tx_in_flight,
    uint16_t batt_mv,
    const vernie_hw_snapshot_t *hw_snap,
    vernie_tick_actions_t *actions
);

/**
 * Report result of an attempted BLE advertising start so backoff updates accurately.
 */
void vernie_runtime_on_adv_result(vernie_runtime_t *rt, uint32_t now_ms, bool started_ok);

#ifdef __cplusplus
}
#endif

#endif // VERNIE_RUNTIME_H
