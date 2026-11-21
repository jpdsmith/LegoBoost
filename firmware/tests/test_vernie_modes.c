// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for Autonomous Modes Brain (vernie_modes.c).
// Covers T3.18: Living Pet, Room Explorer (proximity+bump scan/pivot), Desk Sentry (armed-only dart),
// Color-Card Commander (250 ms close-range debounce), pickup reflex, and Remote/Safe Mode yield.

#include "vernie_modes.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static vernie_mode_input_t base_input(uint8_t mode_id) {
    vernie_mode_input_t in;
    memset(&in, 0, sizeof(in));
    in.mode_id = mode_id;
    in.sensor_ok = true;
    in.distance_pct = 90u;
    in.head_homed = true;
    return in;
}

static void test_pet_mode_and_pickup_reflex(void) {
    vernie_modes_t m;
    vernie_modes_init(&m);
    vernie_mode_input_t in = base_input(VERNIE_MODE_PET);
    vernie_mode_output_t out;

    // Enter Pet mode: idle, tracks coasted.
    vernie_modes_tick(&m, &in, 0u, &out);
    assert(out.active && !out.drive_active);

    // Hand close (<= 50%) after 1200 ms -> playful reverse + curious beep!
    in.distance_pct = 30u;
    vernie_modes_tick(&m, &in, 1500u, &out);
    assert(out.drive_active && out.drive_left < 0 && out.drive_right < 0);
    assert(out.synth_cmd && out.synth_preset_or_note == VERNIE_SFX_CURIOUS_BEEP);

    // Picked up mid-reverse -> MUST coast immediately, flash red LED, squawk & shake head!
    in.picked_up = true;
    vernie_modes_tick(&m, &in, 1600u, &out);
    assert(!out.drive_active && out.hub_led_alert);
    assert(out.synth_cmd && out.synth_preset_or_note == VERNIE_SFX_ALARM_SQUAWK);
    assert(out.head_cmd && (out.head_angle_deg == -25 || out.head_angle_deg == 25));
}

static void test_explorer_bump_and_scan_pivot(void) {
    vernie_modes_t m;
    vernie_modes_init(&m);
    vernie_mode_input_t in = base_input(VERNIE_MODE_EXPLORER);
    vernie_mode_output_t out;

    // Cruise forward
    vernie_modes_tick(&m, &in, 0u, &out);
    assert(out.drive_active && out.drive_left > 0 && out.drive_right > 0);

    // Trigger obstacle via IMU/stall bump (even with clear IR distance 90%!)
    in.bump = true;
    vernie_modes_tick(&m, &in, 100u, &out);
    assert(out.drive_active && out.drive_left < 0 && out.drive_right < 0); // BACKING!
    in.bump = false;

    // After 450 ms backing -> SCAN_LEFT (-35 deg)
    vernie_modes_tick(&m, &in, 560u, &out);
    assert(!out.drive_active && out.head_cmd && out.head_angle_deg == -35);

    // Sample left distance = 80% (clearer) at t=800
    in.distance_pct = 80u;
    vernie_modes_tick(&m, &in, 800u, &out);

    // Transition to SCAN_RIGHT (+35 deg) at t=1020
    vernie_modes_tick(&m, &in, 1020u, &out);
    assert(out.head_cmd && out.head_angle_deg == 35);

    // Sample right distance = 20% (blocked) at t=1250
    in.distance_pct = 20u;
    vernie_modes_tick(&m, &in, 1250u, &out);

    // Transition to PIVOT at t=1480 -> MUST pivot LEFT (left < 0, right > 0) toward clearer 80%!
    vernie_modes_tick(&m, &in, 1480u, &out);
    assert(out.head_cmd && out.head_angle_deg == 0);
    vernie_modes_tick(&m, &in, 1500u, &out);
    assert(out.drive_active && out.drive_left < 0 && out.drive_right > 0);

    // After 650 ms pivot -> returns to forward cruise!
    in.distance_pct = 90u;
    vernie_modes_tick(&m, &in, 2150u, &out);
    vernie_modes_tick(&m, &in, 2170u, &out);
    assert(out.drive_active && out.drive_left > 0 && out.drive_right > 0);
}

static void test_sentry_never_fires_disarmed_and_fires_when_armed(void) {
    vernie_modes_t m;
    vernie_modes_init(&m);
    vernie_mode_input_t in = base_input(VERNIE_MODE_SENTRY);
    vernie_mode_output_t out;

    // Enter Sentry (DISARMED default!)
    in.dart_armed = false;
    vernie_modes_tick(&m, &in, 0u, &out);

    // Intruder appears at t=100, stays for 1600 ms -> warning siren + laser zap, NEVER want_dart_fire!
    in.distance_pct = 20u;
    vernie_modes_tick(&m, &in, 100u, &out);
    assert(out.synth_cmd && out.synth_preset_or_note == VERNIE_SFX_WARNING_SIREN);
    assert(!out.want_dart_fire);

    vernie_modes_tick(&m, &in, 1650u, &out);
    assert(!out.want_dart_fire);
    assert(out.synth_cmd && out.synth_preset_or_note == VERNIE_SFX_LASER_ZAP);

    // Now test ARMED + HOMED Sentry -> fires after >= 1500 ms lock!
    vernie_modes_init(&m);
    in.dart_armed = true;
    in.head_homed = true;
    in.distance_pct = 90u;
    vernie_modes_tick(&m, &in, 0u, &out);

    in.distance_pct = 20u;
    vernie_modes_tick(&m, &in, 100u, &out);
    vernie_modes_tick(&m, &in, 1599u, &out);
    assert(!out.want_dart_fire);
    vernie_modes_tick(&m, &in, 1600u, &out);
    assert(out.want_dart_fire);

    // Even if hardware auto-disarms on the next tick, ENGAGE MUST NOT wiggle tracks while firing!
    in.dart_armed = false;
    vernie_modes_tick(&m, &in, 1700u, &out);
    assert(!out.drive_active);
}

static void test_sentry_to_remote_restores_spec1_and_preempt_reset(void) {
    vernie_modes_t m;
    vernie_modes_init(&m);
    vernie_mode_input_t in = base_input(VERNIE_MODE_SENTRY);
    vernie_mode_output_t out;

    vernie_modes_tick(&m, &in, 0u, &out);
    // At t=800 ms, Sentry pulses chest LED RED.
    vernie_modes_tick(&m, &in, 800u, &out);
    assert(out.chest_led_cmd && out.chest_led == VERNIE_CHEST_LED_RED);

    // Switching directly to REMOTE during the red blink MUST emit chest_led OFF (restores SPEC1)!
    in.mode_id = VERNIE_MODE_REMOTE;
    vernie_modes_tick(&m, &in, 850u, &out);
    assert(!out.active);
    assert(out.chest_led_cmd && out.chest_led == VERNIE_CHEST_LED_OFF);

    // Re-entering Explorer after preemption cleanly starts in CRUISE.
    in.mode_id = VERNIE_MODE_EXPLORER;
    vernie_modes_tick(&m, &in, 900u, &out);
    assert(out.active && out.drive_active && out.drive_left > 0);
    vernie_modes_notify_preempted(&m);
    vernie_modes_tick(&m, &in, 950u, &out);
    assert(out.active && out.chest_led_cmd && out.chest_led == VERNIE_CHEST_LED_OFF);
}

static void test_color_card_250ms_close_range_debounce(void) {
    vernie_modes_t m;
    vernie_modes_init(&m);
    vernie_mode_input_t in = base_input(VERNIE_MODE_COLOR_CARDS);
    vernie_mode_output_t out;
    in.has_saved_macro = true;

    vernie_modes_tick(&m, &in, 0u, &out);

    // Ambient far card (distance 40% > 25%) held for 500 ms MUST be ignored!
    in.color_id = VERNIE_LEGO_COLOR_GREEN;
    in.distance_pct = 40u;
    vernie_modes_tick(&m, &in, 100u, &out);
    vernie_modes_tick(&m, &in, 600u, &out);
    assert(!out.drive_active && !out.synth_cmd);

    // Close card (distance 15% <= 25%) held for only 200 ms (< 250 ms) MUST be ignored!
    in.distance_pct = 15u;
    vernie_modes_tick(&m, &in, 700u, &out);
    vernie_modes_tick(&m, &in, 900u, &out);
    assert(!out.drive_active && !out.synth_cmd);

    // Held >= 250 ms (t=950) -> Green card triggers forward drive + happy chirp!
    vernie_modes_tick(&m, &in, 950u, &out);
    assert(out.synth_cmd && out.synth_preset_or_note == VERNIE_SFX_HAPPY_CHIRP);
    vernie_modes_tick(&m, &in, 970u, &out);
    assert(out.drive_active && out.drive_left > 0 && out.drive_right > 0);

    // Yellow card held >= 250 ms triggers want_macro_play!
    vernie_modes_init(&m);
    in.color_id = VERNIE_LEGO_COLOR_YELLOW;
    in.distance_pct = 10u;
    vernie_modes_tick(&m, &in, 0u, &out);
    vernie_modes_tick(&m, &in, 250u, &out);
    assert(out.want_macro_play);
}

static void test_remote_and_safe_mode_inactive(void) {
    vernie_modes_t m;
    vernie_modes_init(&m);
    vernie_mode_output_t out;

    vernie_mode_input_t remote_in = base_input(VERNIE_MODE_REMOTE);
    vernie_modes_tick(&m, &remote_in, 100u, &out);
    assert(!out.active && !out.drive_active);

    vernie_mode_input_t safe_in = base_input(VERNIE_MODE_EXPLORER);
    safe_in.safe_mode = true;
    vernie_modes_tick(&m, &safe_in, 120u, &out);
    assert(!out.active && !out.drive_active);
}

int main(void) {
    test_pet_mode_and_pickup_reflex();
    test_explorer_bump_and_scan_pivot();
    test_sentry_never_fires_disarmed_and_fires_when_armed();
    test_sentry_to_remote_restores_spec1_and_preempt_reset();
    test_color_card_250ms_close_range_debounce();
    test_remote_and_safe_mode_inactive();
    printf("ALL VERNIE MODES C UNIT TESTS PASSED.\n");
    return 0;
}
