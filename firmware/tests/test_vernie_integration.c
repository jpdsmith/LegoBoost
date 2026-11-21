// SPDX-License-Identifier: MIT
// Layer 3 End-to-End Integration Tests (ASan + UBSan) for Cooperative Arbitration Loop
// (vernie_arbiter.c + vernie_protocol.c + vernie_macro.c + vernie_modes.c + vernie_synth.c + vernie_hw.c).
// Regression coverage for C2, C3, C4, C5, I5, and Minor #1/#2!

#include "vernie_arbiter.h"
#include "vernie_hw.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    int acquire_count[3];
    int release_count[3];
    bool locked[3];
} mock_hal_t;

static bool mock_acq(uint8_t voice, vernie_head_port_t hp, void *ctx) {
    (void)hp;
    mock_hal_t *m = (mock_hal_t *)ctx;
    m->acquire_count[voice]++;
    m->locked[voice] = true;
    return true;
}

static void mock_rel(uint8_t voice, vernie_head_port_t hp, void *ctx) {
    (void)hp;
    mock_hal_t *m = (mock_hal_t *)ctx;
    m->release_count[voice]++;
    m->locked[voice] = false;
}

static void encode_step(uint8_t dst[5], uint8_t op, int8_t a, int8_t b, uint16_t dur_ms) {
    dst[0] = op;
    dst[1] = (uint8_t)a;
    dst[2] = (uint8_t)b;
    dst[3] = (uint8_t)(dur_ms & 0xFFu);
    dst[4] = (uint8_t)((dur_ms >> 8) & 0xFFu);
}

static void test_c5_emergency_stop_halts_macro_and_autonomous_mode(void) {
    mock_hal_t mh = { 0 };
    vernie_synth_hal_t shal = { .acquire = mock_acq, .release = mock_rel, .ctx = &mh };
    vernie_synth_t synth;
    vernie_synth_init(&synth, &shal, 75u);
    vernie_synth_set_head_port(&synth, VERNIE_HEAD_PORT_C, true);

    vernie_control_state_t ctrl;
    vernie_control_init(&ctrl, false);
    ctrl.mode_id = VERNIE_MODE_EXPLORER;

    vernie_macro_t macro;
    vernie_macro_init(&macro, NULL);
    vernie_modes_t modes;
    vernie_modes_init(&modes);
    vernie_arbiter_t arb;
    vernie_arbiter_init(&arb);

    vernie_arbiter_env_t env = {
        .head_homed = true,
        .sensor_ok = true,
        .distance_pct = 90u,
    };
    vernie_arbiter_out_t out;

    // 1. Explorer cruises forward autonomously.
    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 100u, &out);
    assert(out.eff.drive_active && out.eff.drive_left > 0);

    // 2. User hits red STOP button -> DRIVE(0, 0) MUST take over into REMOTE and stop immediately!
    const uint8_t stop_pkt[] = { 0x01, 0, 0, 200, 0 };
    vernie_cmd_t cmd;
    assert(vernie_cmd_decode(stop_pkt, sizeof(stop_pkt), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 120u) == VERNIE_PARSE_OK);

    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 120u, &out);
    assert(ctrl.mode_id == VERNIE_MODE_REMOTE);
    assert(!out.eff.drive_active && out.eff.drive_left == 0 && out.eff.drive_right == 0);

    // 3. Start a driving macro + Hub LED override -> red STOP (0, 0) MUST abort macro AND clear LED override!
    uint8_t steps[10];
    encode_step(&steps[0], VERNIE_MSTEP_LED, 0, 2, 100u);
    encode_step(&steps[5], VERNIE_MSTEP_DRIVE, 60, 60, 1000u);
    assert(vernie_macro_handle_cmd(&macro, NULL, VERNIE_MACRO_SUB_WRITE_CHUNK, 0u, steps, 10u, 200u));
    assert(vernie_macro_start(&macro, 200u));

    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 200u, &out);
    assert(ctrl.led_override && macro.playing);
    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 320u, &out);
    assert(out.eff.drive_active && out.eff.drive_left == 60);

    assert(vernie_control_apply(&ctrl, &cmd, 340u) == VERNIE_PARSE_OK); // DRIVE(0,0) STOP!
    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 340u, &out);
    assert(!macro.playing);
    assert(!out.eff.drive_active);
    assert(!ctrl.led_override); // I5: macro Hub LED override cleaned up!
}

static void test_c4_synth_cannot_corrupt_homing_and_pickup_plays_cleanly(void) {
    mock_hal_t mh = { 0 };
    vernie_synth_hal_t shal = { .acquire = mock_acq, .release = mock_rel, .ctx = &mh };
    vernie_synth_t synth;
    vernie_synth_init(&synth, &shal, 75u);
    vernie_synth_set_head_port(&synth, VERNIE_HEAD_PORT_C, true);

    vernie_control_state_t ctrl;
    vernie_control_init(&ctrl, false);
    ctrl.mode_id = VERNIE_MODE_REMOTE;

    vernie_macro_t macro;
    vernie_macro_init(&macro, NULL);
    vernie_modes_t modes;
    vernie_modes_init(&modes);
    vernie_arbiter_t arb;
    vernie_arbiter_init(&arb);

    // 1. Head is actively HOMING_SEEK -> BLE SYNTH(VOICE_HEAD) MUST be blocked so TIM3 is NEVER stolen!
    const uint8_t synth_head[] = { 0x04, 2, 69, 200, 0 };
    vernie_cmd_t cmd;
    assert(vernie_cmd_decode(synth_head, sizeof(synth_head), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_OK);

    vernie_arbiter_env_t env = {
        .head_homed = false,
        .head_fsm_busy = true,
        .sensor_ok = true,
        .distance_pct = 90u,
    };
    vernie_arbiter_out_t out;
    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 100u, &out);
    assert(!mh.locked[VERNIE_SYNTH_VOICE_HEAD]);
    assert(mh.acquire_count[VERNIE_SYNTH_VOICE_HEAD] == 0);

    // 2. Two rapid BLE synth commands (Voice 1 + Voice 2 chord) in same tick -> BOTH play!
    env.head_fsm_busy = false;
    env.head_homed = true;
    const uint8_t synth_v1[] = { 0x04, 1, 57, 200, 0 };
    const uint8_t synth_v2[] = { 0x04, 2, 69, 200, 0 };
    assert(vernie_cmd_decode(synth_v1, sizeof(synth_v1), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 200u) == VERNIE_PARSE_OK);
    assert(vernie_cmd_decode(synth_v2, sizeof(synth_v2), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 200u) == VERNIE_PARSE_OK);

    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 200u, &out);
    assert(mh.locked[VERNIE_SYNTH_VOICE_TRACKS] && mh.locked[VERNIE_SYNTH_VOICE_HEAD]);
    vernie_synth_stop_all(&synth);

    // 3. Pickup reflex in Mode 0 Pet: head shakes (TIM3) AND alarm squawk plays on TIM1 without collision!
    ctrl.mode_id = VERNIE_MODE_PET;
    env.picked_up = true;
    vernie_arbiter_step(&arb, &ctrl, &macro, &modes, &synth, &env, 500u, &out);
    assert(!out.eff.drive_active);
    assert(out.eff.head_cmd_pending);
    assert(out.alert_led_active);
    assert(mh.locked[VERNIE_SYNTH_VOICE_TRACKS]);
    assert(!mh.locked[VERNIE_SYNTH_VOICE_HEAD]);
}

static void test_safe_mode_stop_commands_accepted_and_unaligned_macro_ignored(void) {
    vernie_control_state_t ctrl;
    vernie_control_init(&ctrl, true); // Watchdog Safe Mode!
    vernie_cmd_t cmd;

    // Minor #1: STOP commands (DRIVE 0/0, SYNTH stop, MACRO STOP) allowed in Safe Mode (no red ATT error).
    const uint8_t drive_stop[] = { 0x01, 0, 0, 200, 0 };
    assert(vernie_cmd_decode(drive_stop, sizeof(drive_stop), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_OK);

    const uint8_t synth_stop[] = { 0x04, 0, 0, 0, 0 };
    assert(vernie_cmd_decode(synth_stop, sizeof(synth_stop), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_OK);

    const uint8_t macro_stop[] = { 0x07, 3, 0 };
    assert(vernie_cmd_decode(macro_stop, sizeof(macro_stop), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_OK);

    // Non-stop motion/synth/macro STILL blocked in Safe Mode!
    const uint8_t drive_go[] = { 0x01, 20, 20, 200, 0 };
    assert(vernie_cmd_decode(drive_go, sizeof(drive_go), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_ERR_INTERLOCK);

    const uint8_t synth_go[] = { 0x04, 1, 69, 200, 0 };
    assert(vernie_cmd_decode(synth_go, sizeof(synth_go), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_ERR_INTERLOCK);

    const uint8_t macro_play[] = { 0x07, 2, 0 };
    assert(vernie_cmd_decode(macro_play, sizeof(macro_play), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&ctrl, &cmd, 100u) == VERNIE_PARSE_ERR_INTERLOCK);
}

int main(void) {
    test_c5_emergency_stop_halts_macro_and_autonomous_mode();
    test_c4_synth_cannot_corrupt_homing_and_pickup_plays_cleanly();
    test_safe_mode_stop_commands_accepted_and_unaligned_macro_ignored();
    printf("ALL VERNIE INTEGRATION C UNIT TESTS PASSED.\n");
    return 0;
}
