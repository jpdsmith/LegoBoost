// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for Vernie OS runtime state machine (vernie_runtime.c).

#include "vernie_runtime.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_ble_advertising_resilience(void) {
    vernie_runtime_t rt;
    vernie_tick_actions_t act;
    vernie_runtime_init(&rt, false);

    // Boot tick 0: not connected, not advertising, not in flight -> requests adv immediately.
    vernie_runtime_tick(&rt, 0u, false, false, false, false, false, false, 8200u, NULL, &act);
    assert(act.need_start_adv);
    assert(!act.need_clear_pending);
    assert(!act.send_telemetry);

    // While adv_in_flight == true, must NOT trigger duplicate adv starts.
    vernie_runtime_tick(&rt, 20u, false, false, true, false, false, false, 8200u, NULL, &act);
    assert(!act.need_start_adv);

    // Simulate first adv start failing (HCI busy) -> backs off 500 ms before retrying.
    vernie_runtime_on_adv_result(&rt, 20u, false);
    vernie_runtime_tick(&rt, 500u, false, false, false, false, false, false, 8200u, NULL, &act);
    assert(!act.need_start_adv);
    vernie_runtime_tick(&rt, 520u, false, false, false, false, false, false, 8200u, NULL, &act);
    assert(act.need_start_adv);

    // Adv succeeds -> while adv_is_active stays true, zero redundant start_adv requests.
    vernie_runtime_on_adv_result(&rt, 520u, true);
    vernie_runtime_tick(&rt, 600u, false, true, false, false, false, false, 8200u, NULL, &act);
    assert(!act.need_start_adv);

    // Second-review fix: GAP-only connect drops adv_is_active -> waits full 2500 ms so ChromeOS
    // BlueZ GATT discovery completes undisturbed, then automatically restarts if peer aborted!
    vernie_runtime_tick(&rt, 700u, false, false, false, false, false, false, 8200u, NULL, &act);
    assert(!act.need_start_adv);
    vernie_runtime_tick(&rt, 3180u, false, false, false, false, false, false, 8200u, NULL, &act);
    assert(!act.need_start_adv);
    vernie_runtime_tick(&rt, 3200u, false, false, false, false, false, false, 8200u, NULL, &act);
    assert(act.need_start_adv);
    vernie_runtime_on_adv_result(&rt, 3200u, true);

    // Normal host connect: mode becomes REMOTE, telemetry fires immediately on first connected tick.
    vernie_runtime_tick(&rt, 3300u, true, false, false, false, false, false, 8100u, NULL, &act);
    assert(!act.need_start_adv);
    assert(rt.ctrl.mode_id == VERNIE_MODE_REMOTE);
    assert(act.send_telemetry);
    assert(rt.telemetry_buf[0] == VERNIE_OP_TELEMETRY);
    assert(rt.telemetry_buf[8] == VERNIE_MODE_REMOTE);

    // Clean host disconnect: clears pending, resets control state, and restarts adv IMMEDIATELY.
    const uint8_t arm_pkt[] = { VERNIE_OP_DART, VERNIE_DART_ARM, VERNIE_DART_MAGIC };
    assert(vernie_runtime_on_rx(&rt, 0u, arm_pkt, sizeof(arm_pkt), 3310u) == VERNIE_PARSE_OK);
    assert(rt.ctrl.dart_armed);

    vernie_runtime_tick(&rt, 3320u, false, false, false, false, false, true, 8100u, NULL, &act);
    assert(act.need_clear_pending);
    assert(act.need_start_adv);
    assert(!rt.ctrl.dart_armed);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET);
}

static void test_button_and_imu_tap_mode_cycling(void) {
    vernie_runtime_t rt;
    vernie_tick_actions_t act;
    vernie_runtime_init(&rt, false);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET);

    // Glitch bounce (20 ms < 40 ms): must NOT cycle mode.
    vernie_runtime_tick(&rt, 100u, false, true, false, true, false, false, 8000u, NULL, &act);
    vernie_runtime_tick(&rt, 120u, false, true, false, false, false, false, 8000u, NULL, &act);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET && !act.mode_cycled);

    // Valid short presses (150 ms) cycle 0 -> 1 -> 2 -> 3 -> 0.
    for (uint8_t expected = 1u; expected <= 4u; expected++) {
        uint32_t t = 1000u * expected;
        vernie_runtime_tick(&rt, t, false, true, false, true, false, false, 8000u, NULL, &act);
        vernie_runtime_tick(&rt, t + 150u, false, true, false, false, false, false, 8000u, NULL, &act);
        assert(rt.ctrl.mode_id == (expected % 4u) && act.mode_cycled);
    }

    // Stationary LIS3DH double-tap cycles mode when disconnected & not in Safe Mode!
    vernie_runtime_tick(&rt, 5000u, false, true, false, false, true, false, 8000u, NULL, &act);
    assert(rt.ctrl.mode_id == VERNIE_MODE_EXPLORER && act.mode_cycled);

    // Long hold (1500 ms) must NOT cycle mode.
    vernie_runtime_tick(&rt, 6000u, false, true, false, true, false, false, 8000u, NULL, &act);
    vernie_runtime_tick(&rt, 7500u, false, true, false, false, false, false, 8000u, NULL, &act);
    assert(rt.ctrl.mode_id == VERNIE_MODE_EXPLORER && !act.mode_cycled);
}

static void test_phase2_hw_snapshot_telemetry_and_led_caching(void) {
    vernie_runtime_t rt;
    vernie_tick_actions_t act;
    vernie_runtime_init(&rt, false);

    vernie_hw_snapshot_t snap = {
        .battery_mv = 8350u,
        .distance_pct = 30u,
        .color_id = 5u,
        .pitch_deg = -12,
        .roll_deg = 7,
        .enc_a = -420,
        .enc_b = 420,
        .head_deg = -15,
        .speed_a = 45,
        .speed_b = -45,
        .picked_up = true,
        .bump = true,
        .tap = false,
        .head_homed = true,
        .sensor_ok = true,
        .synth_active = true,
    };

    vernie_runtime_tick(&rt, 0u, true, false, false, false, false, false, 0u, &snap, &act);
    assert(act.send_telemetry);
    assert(act.led_changed && act.led.hue == 285u);
    assert(rt.telemetry_buf[3] == 30u); // distance_pct
    assert(rt.telemetry_buf[4] == 5u);  // color_id
    assert((int8_t)rt.telemetry_buf[5] == -12);
    assert((int8_t)rt.telemetry_buf[6] == 7);
    uint8_t flags = rt.telemetry_buf[7];
    assert((flags & VERNIE_FLAG_PICKED_UP) != 0);
    assert((flags & VERNIE_FLAG_BUMP) != 0);
    assert((flags & VERNIE_FLAG_HEAD_HOMED) != 0);
    assert((flags & VERNIE_FLAG_SENSOR_OK) != 0);
    assert((flags & VERNIE_FLAG_SYNTH_ACTIVE) != 0);

    // SET_MODE(1) while BLE-connected updates LED hue to green (120).
    const uint8_t mode_explorer[] = { VERNIE_OP_SET_MODE, VERNIE_MODE_EXPLORER };
    assert(vernie_runtime_on_rx(&rt, 0u, mode_explorer, sizeof(mode_explorer), 20u) == VERNIE_PARSE_OK);
    vernie_runtime_tick(&rt, 20u, true, false, false, false, false, false, 0u, &snap, &act);
    assert(act.led_changed && act.led.hue == 120u);

    // Static RGB override caches cleanly and skips redundant writes.
    const uint8_t led_rgb[] = { VERNIE_OP_LED, VERNIE_LED_TARGET_HUB_RGB, 0, 168, 232 };
    assert(vernie_runtime_on_rx(&rt, 0u, led_rgb, sizeof(led_rgb), 40u) == VERNIE_PARSE_OK);
    vernie_runtime_tick(&rt, 40u, true, false, false, false, false, false, 0u, &snap, &act);
    assert(act.led_changed && act.led.kind == VERNIE_LED_KIND_RGB);
    vernie_runtime_tick(&rt, 60u, true, false, false, false, false, false, 0u, &snap, &act);
    assert(!act.led_changed);
}

int main(void) {
    test_ble_advertising_resilience();
    test_button_and_imu_tap_mode_cycling();
    test_phase2_hw_snapshot_telemetry_and_led_caching();
    printf("ALL VERNIE RUNTIME C UNIT TESTS PASSED.\n");
    return 0;
}
