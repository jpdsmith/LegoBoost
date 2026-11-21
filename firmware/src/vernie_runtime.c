// SPDX-License-Identifier: MIT
// Pure, HAL-independent Vernie OS runtime state machine.

#include "vernie_runtime.h"

#include <string.h>

static bool led_cmd_equals(const vernie_led_cmd_t *x, const vernie_led_cmd_t *y) {
    return x->kind == y->kind &&
           x->hue == y->hue &&
           x->a == y->a &&
           x->b == y->b &&
           x->c == y->c;
}

static vernie_led_cmd_t compute_led_cmd(const vernie_control_state_t *ctrl, uint32_t now_ms) {
    vernie_led_cmd_t cmd;
    memset(&cmd, 0, sizeof(cmd));

    if (ctrl->safe_mode) {
        // Watchdog Safe Mode: crisp alternating red (0) / blue (240) alert every 250 ms.
        cmd.kind = VERNIE_LED_KIND_HSV;
        cmd.hue = ((now_ms / 250u) & 1u) ? 0u : 240u;
        cmd.a = 100u;
        cmd.b = 100u;
        return cmd;
    }

    if (ctrl->led_override) {
        cmd.kind = VERNIE_LED_KIND_RGB;
        cmd.a = ctrl->hub_r;
        cmd.b = ctrl->hub_g;
        cmd.c = ctrl->hub_b;
        return cmd;
    }

    // Mode hues: 0=Blue(Pet), 1=Green(Explorer), 2=Red(Sentry), 3=Yellow(Cards), 4=Purple(Remote)
    static const uint16_t mode_hues[5] = { 215u, 120u, 0u, 50u, 285u };
    uint8_t mode = ctrl->mode_id <= VERNIE_MODE_MAX ? ctrl->mode_id : VERNIE_MODE_PET;

    // Triangle wave breathing brightness 15..95 over 2 seconds (integer math only).
    uint32_t phase = now_ms % 2000u;
    uint32_t tri = phase < 1000u ? phase : (2000u - phase);
    uint8_t val = (uint8_t)(15u + (tri * 80u) / 1000u);

    cmd.kind = VERNIE_LED_KIND_HSV;
    cmd.hue = mode_hues[mode];
    cmd.a = 100u;
    cmd.b = val;
    return cmd;
}

void vernie_runtime_init(vernie_runtime_t *rt, bool safe_mode) {
    memset(rt, 0, sizeof(*rt));
    vernie_control_init(&rt->ctrl, safe_mode);
}

vernie_parse_result_t vernie_runtime_on_rx(
    vernie_runtime_t *rt,
    uint16_t offset,
    const uint8_t *data,
    size_t size,
    uint32_t now_ms
) {
    if (!rt || offset != 0u) {
        return VERNIE_PARSE_ERR_VALUE;
    }
    vernie_cmd_t cmd;
    vernie_parse_result_t res = vernie_cmd_decode(data, size, &cmd);
    if (res != VERNIE_PARSE_OK) {
        return res;
    }
    return vernie_control_apply(&rt->ctrl, &cmd, now_ms);
}

void vernie_runtime_tick(
    vernie_runtime_t *rt,
    uint32_t now_ms,
    bool host_connected,
    bool adv_is_active,
    bool btn_pressed,
    bool tx_in_flight,
    uint16_t batt_mv,
    vernie_tick_actions_t *actions
) {
    memset(actions, 0, sizeof(*actions));

    // 1. Detect BLE host connect / disconnect transitions.
    if (host_connected && !rt->was_connected) {
        rt->was_connected = true;
        rt->adv_retry_armed = false;
        if (!rt->ctrl.safe_mode) {
            rt->ctrl.mode_id = VERNIE_MODE_REMOTE;
        }
    } else if (!host_connected && rt->was_connected) {
        rt->was_connected = false;
        rt->has_sent_tx = false;
        rt->adv_retry_armed = false; // Restart advertising immediately on host disconnect.
        actions->need_clear_pending = true;
        vernie_control_on_disconnect(&rt->ctrl);
    }

    // 2. Detect GAP-only advertising drop (peer connected at link layer before CCCD subscribe).
    //    Arm a 500 ms backoff so normal GATT discovery completes undisturbed, while aborted
    //    or rapid GAP-only connections automatically resume advertising.
    if (!host_connected && !adv_is_active && rt->was_adv_active && !actions->need_clear_pending) {
        rt->adv_retry_armed = true;
        rt->next_adv_retry_ms = now_ms + VERNIE_ADV_RETRY_MS;
    }
    rt->was_adv_active = adv_is_active;

    // 3. Keep BLE advertising alive whenever no host is connected.
    if (!host_connected && !adv_is_active) {
        if (!rt->adv_retry_armed || (int32_t)(now_ms - rt->next_adv_retry_ms) >= 0) {
            actions->need_start_adv = true;
            rt->adv_retry_armed = true;
            rt->next_adv_retry_ms = now_ms + VERNIE_ADV_RETRY_MS;
        }
    }

    // 4. Enforce drive dead-man failsafe timeout.
    (void)vernie_control_tick(&rt->ctrl, now_ms);

    // 5. Green button: short press (40..799 ms) cycles standalone modes (0..3).
    //    Long holds (>= 800 ms, e.g. aborted or completed 2s shutdown) do not cycle mode.
    if (btn_pressed && !rt->prev_btn_pressed) {
        rt->btn_press_start_ms = now_ms;
        rt->btn_hold_active = true;
    } else if (!btn_pressed && rt->prev_btn_pressed && rt->btn_hold_active) {
        uint32_t held_ms = now_ms - rt->btn_press_start_ms;
        rt->btn_hold_active = false;
        if (held_ms >= VERNIE_BTN_SHORT_MIN_MS &&
            held_ms < VERNIE_BTN_SHORT_MAX_MS &&
            !rt->ctrl.safe_mode &&
            !host_connected) {
            rt->ctrl.mode_id = (uint8_t)((rt->ctrl.mode_id + 1u) % 4u);
            rt->ctrl.led_override = false;
        }
    }
    rt->prev_btn_pressed = btn_pressed;

    // 6. Compute LED target and emit update only when color actually changes.
    vernie_led_cmd_t desired_led = compute_led_cmd(&rt->ctrl, now_ms);
    if (!rt->led_initialized || !led_cmd_equals(&desired_led, &rt->last_led)) {
        rt->last_led = desired_led;
        rt->led_initialized = true;
        actions->led_changed = true;
        actions->led = desired_led;
    }

    // 7. Schedule 18-byte binary telemetry at 10 Hz (100 ms interval) when host connected.
    bool tx_due = !rt->has_sent_tx || (uint32_t)(now_ms - rt->last_tx_ms) >= VERNIE_TELEMETRY_PERIOD_MS;
    if (host_connected && !tx_in_flight && tx_due) {
        uint8_t flags = 0;
        if (rt->ctrl.dart_armed) {
            flags |= VERNIE_FLAG_DART_ARMED;
        }
        if (rt->ctrl.safe_mode) {
            flags |= VERNIE_FLAG_SAFE_MODE;
        }
        if (btn_pressed) {
            // Phase 1 bring-up diagnostic: surface live green-button press on TAP flag bit.
            flags |= VERNIE_FLAG_TAP;
        }

        vernie_telemetry_t t = {
            .battery_mv = batt_mv,
            .distance_pct = 0xFFu, // Phase 2 attaches 88007 sensor
            .color_id = 0u,
            .pitch_deg = 0,
            .roll_deg = 0,
            .flags = flags,
            .mode_id = rt->ctrl.mode_id,
            .enc_a = 0,
            .enc_b = 0,
            .head_deg = rt->ctrl.head_target_deg,
            .speed_a = rt->ctrl.drive_left,
            .speed_b = rt->ctrl.drive_right,
            .seq = rt->telemetry_seq++,
        };

        vernie_telemetry_encode(&t, rt->telemetry_buf);
        rt->last_tx_ms = now_ms;
        rt->has_sent_tx = true;
        actions->send_telemetry = true;
    }
}

void vernie_runtime_on_adv_result(vernie_runtime_t *rt, uint32_t now_ms, bool started_ok) {
    if (!rt) {
        return;
    }
    if (started_ok) {
        rt->was_adv_active = true;
        rt->adv_retry_armed = false;
    } else {
        rt->was_adv_active = false;
        rt->adv_retry_armed = true;
        rt->next_adv_retry_ms = now_ms + VERNIE_ADV_RETRY_MS;
    }
}
