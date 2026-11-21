// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for Vernie Hardware FSM (vernie_hw.c).
// Covers T3.14 (Port C/D auto-detection), T3.15 (non-trigger single-direction head homing & clamp),
// armed-only dart fire + auto-disarm, and 88007 SPEC1 decoding.

#include "vernie_hw.h"

#include <assert.h>
#include <stdio.h>

static void test_port_cd_auto_detection(void) {
    vernie_port_map_t map;

    // Standard Vernie: C=Head, D=Sensor -> TIM3 safe!
    vernie_hw_resolve_ports(VERNIE_EXT_DEV_HEAD, VERNIE_EXT_DEV_SENSOR, &map);
    assert(map.head_port == VERNIE_HEAD_PORT_C);
    assert(map.sensor_port == VERNIE_HEAD_PORT_D);
    assert(map.sibling_safe_for_tim3);

    // Swapped plugs: C=Sensor, D=Head -> TIM3 still safe!
    vernie_hw_resolve_ports(VERNIE_EXT_DEV_SENSOR, VERNIE_EXT_DEV_HEAD, &map);
    assert(map.head_port == VERNIE_HEAD_PORT_D);
    assert(map.sensor_port == VERNIE_HEAD_PORT_C);
    assert(map.sibling_safe_for_tim3);

    // Missing sensor (C=Head, D=None) -> TIM3 safe!
    vernie_hw_resolve_ports(VERNIE_EXT_DEV_HEAD, VERNIE_EXT_DEV_NONE, &map);
    assert(map.head_port == VERNIE_HEAD_PORT_C && map.sensor_port == VERNIE_HEAD_PORT_NONE);
    assert(map.sibling_safe_for_tim3);

    // Two external motors (C=Head, D=Head) -> TIM3 NOT safe (must not drive sibling)!
    vernie_hw_resolve_ports(VERNIE_EXT_DEV_HEAD, VERNIE_EXT_DEV_HEAD, &map);
    assert(!map.sibling_safe_for_tim3);

    // No head motor (C=Sensor, D=None) -> TIM3 disabled!
    vernie_hw_resolve_ports(VERNIE_EXT_DEV_SENSOR, VERNIE_EXT_DEV_NONE, &map);
    assert(map.head_port == VERNIE_HEAD_PORT_NONE && !map.sibling_safe_for_tim3);
}

static void test_non_trigger_head_homing_and_dart_interlock(void) {
    vernie_head_fsm_t fsm;
    vernie_head_action_t act;
    vernie_head_fsm_init(&fsm, 45);
    assert(!fsm.homed);

    // C2 regression: MOVE_TARGET before homing MUST be rejected & cleared (never hits trigger!).
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, true, 35, 50u, false, false, 80u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_NONE && act.clear_head_cmd_pending);

    // Attempting dart fire BEFORE homing (even if armed) MUST be rejected!
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, true, true, 100u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_NONE && act.clear_dart_fire_req);

    // Request homing -> strictly negative (non-trigger) speed & duty <= 30%!
    vernie_head_fsm_step(&fsm, true, false, false, true, false, true, false, 0, 50u, false, false, 200u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_SEEK_NON_TRIGGER);
    assert(act.speed_deg_s < 0);
    assert(act.duty_limit_pct > 0 && act.duty_limit_pct <= 30);
    assert(act.clear_head_home_req);
    assert(fsm.state == VERNIE_HEAD_STATE_HOMING_SEEK);

    // C3 regression: premature dart_fire_requested during HOMING_SEEK MUST be cleared (never latched)!
    vernie_head_fsm_step(&fsm, true, false, false, false, false, false, false, 0, 50u, true, true, 400u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_NONE && act.clear_dart_fire_req);
    assert(fsm.state == VERNIE_HEAD_STATE_HOMING_SEEK);

    // Motor stalls against non-trigger stop -> resets encoder to -45 deg and centers to 0!
    vernie_head_fsm_step(&fsm, true, false, false, false, true, false, false, 0, 50u, false, false, 600u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_RESET_AND_CENTER);
    assert(act.target_deg == -45);
    assert(fsm.state == VERNIE_HEAD_STATE_HOMING_BACKOFF);

    // C3 regression: premature dart fire during HOMING_BACKOFF MUST also be cleared!
    vernie_head_fsm_step(&fsm, true, false, false, false, false, false, false, 0, 50u, true, true, 700u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_NONE && act.clear_dart_fire_req);

    // Centering completes -> READY & homed!
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, false, false, 900u, &act);
    assert(fsm.state == VERNIE_HEAD_STATE_READY && fsm.homed);

    // Normal angle command exceeding +35 deg MUST clamp strictly to +35 (never enters trigger zone!).
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, true, 80, 60u, false, false, 1000u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_MOVE_TARGET);
    assert(act.target_deg == VERNIE_HEAD_MAX_DEG);

    // Disarmed dart fire STILL rejected even after homing!
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, false, true, 1100u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_NONE && act.clear_dart_fire_req);

    // I5 regression: armed + homed dart fire rejected when picked up!
    vernie_head_fsm_step(&fsm, true, false, true, true, false, false, false, 0, 50u, true, true, 1150u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_NONE && act.clear_dart_fire_req);

    // Armed + homed dart fire sweeps to +70, holds 200 ms, returns to 0, and AUTO-DISARMS!
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, true, true, 1200u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_FIRE_SWEEP && act.target_deg == VERNIE_DART_TRIGGER_DEG);
    assert(fsm.state == VERNIE_HEAD_STATE_DART_FIRING);

    // I5 regression: pickup mid-DART_FIRING immediately coasts & disarms!
    vernie_head_fsm_step(&fsm, true, false, true, false, false, false, false, 0, 50u, true, false, 1250u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_COAST && act.clear_dart_armed && fsm.state == VERNIE_HEAD_STATE_READY);

    // Re-arm and complete normal dart fire lifecycle.
    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, true, true, 1300u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_FIRE_SWEEP && fsm.state == VERNIE_HEAD_STATE_DART_FIRING);

    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, true, false, 1400u, &act);
    assert(fsm.state == VERNIE_HEAD_STATE_DART_HOLD);

    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, true, false, 1600u, &act);
    assert(act.kind == VERNIE_HEAD_ACT_RETURN_CENTER && act.target_deg == 0);
    assert(fsm.state == VERNIE_HEAD_STATE_DART_RETURNING);

    vernie_head_fsm_step(&fsm, true, false, false, true, false, false, false, 0, 50u, true, false, 1800u, &act);
    assert(fsm.state == VERNIE_HEAD_STATE_READY);
    assert(act.clear_dart_armed && act.clear_dart_fire_req);
}

static void test_88007_spec1_decoding(void) {
    uint8_t col = 0u, dist = 0u;
    const int8_t sample1[4] = { 9, 4, 0, 0 }; // Red, proximity 4 -> 40%
    vernie_sensor_decode_spec1(sample1, &col, &dist);
    assert(col == 9u && dist == 40u);

    const int8_t sample_neg[4] = { -1, -2, 0, 0 }; // I4: negative proximity -> 0xFF (N/A, NOT 0% obstacle!)
    vernie_sensor_decode_spec1(sample_neg, &col, &dist);
    assert(col == 0u && dist == 0xFFu);

    const int8_t sample_hi[4] = { 3, 15, 0, 0 }; // Blue, clamped proximity 100%
    vernie_sensor_decode_spec1(sample_hi, &col, &dist);
    assert(col == 3u && dist == 100u);
}

static void test_remote_drive_ignores_pickup_orientation(void) {
    vernie_control_state_t ctrl;
    vernie_control_init(&ctrl, false);
    ctrl.drive_active = true;
    ctrl.drive_left = 50;
    ctrl.drive_right = 50;

    // Mode 4 (Remote Cockpit): manual tank drive MUST work regardless of IMU orientation!
    ctrl.mode_id = VERNIE_MODE_REMOTE;
    assert(vernie_hw_tracks_allowed(&ctrl, false));
    assert(vernie_hw_tracks_allowed(&ctrl, true));

    // Autonomous modes (Modes 0..3): pickup safety cutout still halts unattended tracks!
    ctrl.mode_id = VERNIE_MODE_EXPLORER;
    assert(vernie_hw_tracks_allowed(&ctrl, false));
    assert(!vernie_hw_tracks_allowed(&ctrl, true));

    // Watchdog Safe Mode: ALWAYS blocks tracks even in Remote mode!
    ctrl.mode_id = VERNIE_MODE_REMOTE;
    ctrl.safe_mode = true;
    assert(!vernie_hw_tracks_allowed(&ctrl, false));
}

int main(void) {
    test_port_cd_auto_detection();
    test_non_trigger_head_homing_and_dart_interlock();
    test_88007_spec1_decoding();
    test_remote_drive_ignores_pickup_orientation();
    printf("ALL VERNIE HW C UNIT TESTS PASSED.\n");
    return 0;
}
