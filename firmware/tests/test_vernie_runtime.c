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

    // Boot tick 0: not connected, not advertising -> must request advertising immediately.
    vernie_runtime_tick(&rt, 0u, false, false, false, false, 8200u, &act);
    assert(act.need_start_adv);
    assert(!act.need_clear_pending);
    assert(!act.send_telemetry);

    // Simulate first adv start failing (e.g. HCI busy) -> must back off 500 ms before retrying.
    vernie_runtime_on_adv_result(&rt, 0u, false);
    vernie_runtime_tick(&rt, 480u, false, false, false, false, 8200u, &act);
    assert(!act.need_start_adv);
    vernie_runtime_tick(&rt, 500u, false, false, false, false, 8200u, &act);
    assert(act.need_start_adv);

    // Adv succeeds -> while adv_is_active stays true, no redundant start_adv requests.
    vernie_runtime_on_adv_result(&rt, 500u, true);
    vernie_runtime_tick(&rt, 600u, false, true, false, false, 8200u, &act);
    assert(!act.need_start_adv);

    // C2 regression: Peer GAP-connects (clearing adv_is_active) WITHOUT enabling CCCD, then drops.
    // Must wait 500 ms so normal GATT discovery isn't interrupted, then automatically restart adv!
    vernie_runtime_tick(&rt, 700u, false, false, false, false, 8200u, &act);
    assert(!act.need_start_adv);
    vernie_runtime_tick(&rt, 1180u, false, false, false, false, 8200u, &act);
    assert(!act.need_start_adv);
    vernie_runtime_tick(&rt, 1200u, false, false, false, false, 8200u, &act);
    assert(act.need_start_adv);
    vernie_runtime_on_adv_result(&rt, 1200u, true);

    // Normal host connect: mode becomes REMOTE, telemetry fires immediately on first connected tick.
    vernie_runtime_tick(&rt, 1300u, true, false, false, false, 8100u, &act);
    assert(!act.need_start_adv);
    assert(rt.ctrl.mode_id == VERNIE_MODE_REMOTE);
    assert(act.send_telemetry);
    assert(rt.telemetry_buf[0] == VERNIE_OP_TELEMETRY);
    assert(rt.telemetry_buf[8] == VERNIE_MODE_REMOTE);

    // Clean host disconnect: must clear pending, reset control state, and restart adv IMMEDIATELY.
    const uint8_t arm_pkt[] = { VERNIE_OP_DART, VERNIE_DART_ARM, VERNIE_DART_MAGIC };
    assert(vernie_runtime_on_rx(&rt, 0u, arm_pkt, sizeof(arm_pkt), 1310u) == VERNIE_PARSE_OK);
    assert(rt.ctrl.dart_armed);

    vernie_runtime_tick(&rt, 1320u, false, false, false, true, 8100u, &act);
    assert(act.need_clear_pending);
    assert(act.need_start_adv);
    assert(!rt.ctrl.dart_armed);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET);
}

static void test_button_short_press_vs_hold(void) {
    vernie_runtime_t rt;
    vernie_tick_actions_t act;
    vernie_runtime_init(&rt, false);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET);

    // Glitch bounce (20 ms < 40 ms): must NOT cycle mode.
    vernie_runtime_tick(&rt, 100u, false, true, true, false, 8000u, &act);
    vernie_runtime_tick(&rt, 120u, false, true, false, false, 8000u, &act);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET);

    // Valid short presses (150 ms) cycle 0 -> 1 -> 2 -> 3 -> 0.
    for (uint8_t expected = 1u; expected <= 4u; expected++) {
        uint32_t t = 1000u * expected;
        vernie_runtime_tick(&rt, t, false, true, true, false, 8000u, &act);
        vernie_runtime_tick(&rt, t + 150u, false, true, false, false, 8000u, &act);
        assert(rt.ctrl.mode_id == (expected % 4u));
    }

    // I1.2 regression: Long hold (1500 ms, e.g. aborted 2s shutdown) must NOT cycle mode!
    vernie_runtime_tick(&rt, 6000u, false, true, true, false, 8000u, &act);
    vernie_runtime_tick(&rt, 7500u, false, true, false, false, 8000u, &act);
    assert(rt.ctrl.mode_id == VERNIE_MODE_PET);

    // Connected host: green button does NOT cycle mode, and surfaces live TAP flag bit in telemetry.
    vernie_runtime_tick(&rt, 8000u, true, false, true, false, 8000u, &act);
    assert(act.send_telemetry);
    assert((rt.telemetry_buf[7] & VERNIE_FLAG_TAP) != 0);
    vernie_runtime_tick(&rt, 8150u, true, false, false, false, 8000u, &act);
    assert(rt.ctrl.mode_id == VERNIE_MODE_REMOTE);
}

static void test_led_mode_override_and_caching(void) {
    vernie_runtime_t rt;
    vernie_tick_actions_t act;
    vernie_runtime_init(&rt, false);

    // Connect -> mode REMOTE (purple hue 285).
    vernie_runtime_tick(&rt, 0u, true, false, false, false, 8000u, &act);
    assert(act.led_changed);
    assert(act.led.kind == VERNIE_LED_KIND_HSV && act.led.hue == 285u);

    // I1.3 regression: SET_MODE(1) while BLE-connected must switch LED hue to green (120)!
    const uint8_t mode_explorer[] = { VERNIE_OP_SET_MODE, VERNIE_MODE_EXPLORER };
    assert(vernie_runtime_on_rx(&rt, 0u, mode_explorer, sizeof(mode_explorer), 20u) == VERNIE_PARSE_OK);
    vernie_runtime_tick(&rt, 20u, true, false, false, false, 8000u, &act);
    assert(act.led_changed);
    assert(act.led.kind == VERNIE_LED_KIND_HSV && act.led.hue == 120u);

    // I1.4 regression: Static RGB override writes once, then skips redundant 50 Hz LED updates!
    const uint8_t led_rgb[] = { VERNIE_OP_LED, VERNIE_LED_TARGET_HUB_RGB, 0, 168, 232 };
    assert(vernie_runtime_on_rx(&rt, 0u, led_rgb, sizeof(led_rgb), 40u) == VERNIE_PARSE_OK);
    vernie_runtime_tick(&rt, 40u, true, false, false, false, 8000u, &act);
    assert(act.led_changed);
    assert(act.led.kind == VERNIE_LED_KIND_RGB && act.led.a == 0 && act.led.b == 168 && act.led.c == 232);

    vernie_runtime_tick(&rt, 60u, true, false, false, false, 8000u, &act);
    assert(!act.led_changed);
    vernie_runtime_tick(&rt, 80u, true, false, false, false, 8000u, &act);
    assert(!act.led_changed);
}

static void test_safe_mode_and_telemetry_pacing(void) {
    vernie_runtime_t rt;
    vernie_tick_actions_t act;
    vernie_runtime_init(&rt, true);

    // Safe Mode alternates blue (240) at 0..249 ms and red (0) at 250..499 ms, skipping unchanged ticks.
    vernie_runtime_tick(&rt, 0u, true, false, false, false, 7800u, &act);
    assert(act.led_changed && act.led.hue == 240u);
    assert(act.send_telemetry);
    assert((rt.telemetry_buf[7] & VERNIE_FLAG_SAFE_MODE) != 0);
    assert(rt.telemetry_buf[17] == 0u);

    // At 40 ms: LED unchanged, telemetry not due (< 100 ms).
    vernie_runtime_tick(&rt, 40u, true, false, false, false, 7800u, &act);
    assert(!act.led_changed);
    assert(!act.send_telemetry);

    // At 100 ms with tx_in_flight = true: telemetry backpressured until flight clears.
    vernie_runtime_tick(&rt, 100u, true, false, false, true, 7800u, &act);
    assert(!act.send_telemetry);
    vernie_runtime_tick(&rt, 120u, true, false, false, false, 7800u, &act);
    assert(act.send_telemetry && rt.telemetry_buf[17] == 1u);

    // At 250 ms: Safe Mode alert flips to red (hue 0).
    vernie_runtime_tick(&rt, 250u, true, false, false, false, 7800u, &act);
    assert(act.led_changed && act.led.hue == 0u);

    // RX non-zero offset rejected; motion commands blocked by interlock.
    const uint8_t drive_pkt[] = { VERNIE_OP_DRIVE, 50, 50, 144, 1 };
    assert(vernie_runtime_on_rx(&rt, 1u, drive_pkt, sizeof(drive_pkt), 260u) == VERNIE_PARSE_ERR_VALUE);
    assert(vernie_runtime_on_rx(&rt, 0u, drive_pkt, sizeof(drive_pkt), 260u) == VERNIE_PARSE_ERR_INTERLOCK);
}

int main(void) {
    test_ble_advertising_resilience();
    test_button_short_press_vs_hold();
    test_led_mode_override_and_caching();
    test_safe_mode_and_telemetry_pacing();
    printf("ALL VERNIE RUNTIME C UNIT TESTS PASSED.\n");
    return 0;
}
