// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for Vernie OS Layer-2 Binary BLE Protocol.
// Verifies shared golden vectors from tools/protocol_schema.json, boundary clamps,
// safety interlocks, defensive control_apply validation, and 10,000-packet fuzzing.

#include "vernie_protocol.h"

#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static void test_golden_rx_vectors(void) {
    vernie_cmd_t cmd;

    // rx_drive: left=-75, right=100, timeout_ms=400
    const uint8_t drive_bytes[] = { 1, 181, 100, 144, 1 };
    assert(vernie_cmd_decode(drive_bytes, sizeof(drive_bytes), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.opcode == VERNIE_OP_DRIVE);
    assert(cmd.u.drive.left == -75);
    assert(cmd.u.drive.right == 100);
    assert(cmd.u.drive.timeout_ms == 400);

    // DRIVE extreme int8 clamping: -128 -> -100, +127 -> +100
    const uint8_t drive_extreme[] = { 1, (uint8_t)-128, 127, 0xE8, 0x03 };
    assert(vernie_cmd_decode(drive_extreme, sizeof(drive_extreme), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.drive.left == -100);
    assert(cmd.u.drive.right == 100);
    assert(cmd.u.drive.timeout_ms == 1000);

    // rx_head_angle: angle=-25, speed=60
    const uint8_t head_angle[] = { 2, 231, 60 };
    assert(vernie_cmd_decode(head_angle, sizeof(head_angle), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.opcode == VERNIE_OP_HEAD);
    assert(!cmd.u.head.is_home);
    assert(cmd.u.head.angle_deg == -25);
    assert(cmd.u.head.speed == 60);

    // rx_head_home: sentinel 127
    const uint8_t head_home[] = { 2, 127, 25 };
    assert(vernie_cmd_decode(head_home, sizeof(head_home), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.head.is_home);
    assert(cmd.u.head.angle_deg == 0);
    assert(cmd.u.head.speed == 25);

    // Head angle clamping to [-40, +35]
    const uint8_t head_over_pos[] = { 2, 90, 120 };
    assert(vernie_cmd_decode(head_over_pos, sizeof(head_over_pos), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.head.angle_deg == 35);
    assert(cmd.u.head.speed == 100);

    const uint8_t head_over_neg[] = { 2, (uint8_t)-128, 50 };
    assert(vernie_cmd_decode(head_over_neg, sizeof(head_over_neg), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.head.angle_deg == -40);

    // rx_dart_arm: subcmd=1, magic=165
    const uint8_t dart_arm[] = { 3, 1, 165 };
    assert(vernie_cmd_decode(dart_arm, sizeof(dart_arm), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.dart.subcmd == VERNIE_DART_ARM);
    assert(cmd.u.dart.magic == VERNIE_DART_MAGIC);

    // Dart invalid subcmd=3 rejected with VALUE error
    const uint8_t dart_bad_sub[] = { 3, 3, 165 };
    assert(vernie_cmd_decode(dart_bad_sub, sizeof(dart_bad_sub), &cmd) == VERNIE_PARSE_ERR_VALUE);

    // rx_synth: voice=1, note=69, dur=250
    const uint8_t synth_bytes[] = { 4, 1, 69, 250, 0 };
    assert(vernie_cmd_decode(synth_bytes, sizeof(synth_bytes), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.synth.voice == 1);
    assert(cmd.u.synth.preset_or_note == 69);
    assert(cmd.u.synth.dur_ms == 250);

    // Synth 3-second thermal clamp + invalid voice=3 rejection
    const uint8_t synth_long[] = { 4, 2, 60, 0x88, 0x13 }; // 5000 ms
    assert(vernie_cmd_decode(synth_long, sizeof(synth_long), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.synth.dur_ms == 3000);
    const uint8_t synth_bad_voice[] = { 4, 3, 60, 100, 0 };
    assert(vernie_cmd_decode(synth_bad_voice, sizeof(synth_bad_voice), &cmd) == VERNIE_PARSE_ERR_VALUE);

    // rx_led_hub
    const uint8_t led_hub[] = { 5, 0, 16, 200, 255 };
    assert(vernie_cmd_decode(led_hub, sizeof(led_hub), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.led.target == VERNIE_LED_TARGET_HUB_RGB);
    assert(cmd.u.led.a == 16 && cmd.u.led.b == 200 && cmd.u.led.c == 255);

    // Chest LED must reject non-88007 states (only 0, 3, 5, 9 allowed) and unknown target=2
    const uint8_t led_chest_bad[] = { 5, 1, 7, 0, 0 };
    assert(vernie_cmd_decode(led_chest_bad, sizeof(led_chest_bad), &cmd) == VERNIE_PARSE_ERR_VALUE);
    const uint8_t led_bad_target[] = { 5, 2, 0, 0, 0 };
    assert(vernie_cmd_decode(led_bad_target, sizeof(led_bad_target), &cmd) == VERNIE_PARSE_ERR_VALUE);
    const uint8_t valid_chest[] = { 0, 3, 5, 9 };
    for (size_t i = 0; i < sizeof(valid_chest); i++) {
        uint8_t pkt[5] = { 5, 1, valid_chest[i], 0xAA, 0xBB };
        assert(vernie_cmd_decode(pkt, sizeof(pkt), &cmd) == VERNIE_PARSE_OK);
        assert(cmd.u.led.a == valid_chest[i] && cmd.u.led.b == 0 && cmd.u.led.c == 0);
    }

    // rx_set_mode + out-of-range mode=5
    const uint8_t set_mode[] = { 6, 4 };
    assert(vernie_cmd_decode(set_mode, sizeof(set_mode), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.set_mode.mode_id == 4);
    const uint8_t bad_mode[] = { 6, 5 };
    assert(vernie_cmd_decode(bad_mode, sizeof(bad_mode), &cmd) == VERNIE_PARSE_ERR_VALUE);

    // rx_macro_chunk + boundary lengths 2, 3, 17, 18
    const uint8_t macro_chunk[] = { 7, 1, 0, 10, 20, 30, 40 };
    assert(vernie_cmd_decode(macro_chunk, sizeof(macro_chunk), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.macro_op.subcmd == 1);
    assert(cmd.u.macro_op.offset == 0);
    assert(cmd.u.macro_op.data_len == 4);
    assert(cmd.u.macro_op.data[0] == 10 && cmd.u.macro_op.data[3] == 40);

    const uint8_t macro_too_short[] = { 7, 1 };
    assert(vernie_cmd_decode(macro_too_short, sizeof(macro_too_short), &cmd) == VERNIE_PARSE_ERR_LENGTH);
    const uint8_t macro_empty_data[] = { 7, 2, 0 };
    assert(vernie_cmd_decode(macro_empty_data, sizeof(macro_empty_data), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.macro_op.data_len == 0);
}

static void test_golden_tx_telemetry(void) {
    const vernie_telemetry_t t = {
        .battery_mv = 8120,
        .distance_pct = 42,
        .color_id = 3,
        .pitch_deg = -12,
        .roll_deg = 5,
        .flags = 96,
        .mode_id = 4,
        .enc_a = -1234,
        .enc_b = 4321,
        .head_deg = -15,
        .speed_a = -50,
        .speed_b = 50,
        .seq = 201,
    };
    const uint8_t expected[VERNIE_TELEMETRY_BYTES] = {
        128, 184, 31, 42, 3, 244, 5, 96, 4, 46, 251, 225, 16, 241, 255, 206, 50, 201
    };
    uint8_t out[VERNIE_TELEMETRY_BYTES];
    size_t n = vernie_telemetry_encode(&t, out);
    assert(n == VERNIE_TELEMETRY_BYTES);
    assert(n <= VERNIE_TX_MAX_BYTES);
    assert(memcmp(out, expected, sizeof(expected)) == 0);

    // Extreme signed/unsigned limits round-trip encoding
    const vernie_telemetry_t extreme = {
        .battery_mv = 65535u,
        .distance_pct = 255u,
        .color_id = 255u,
        .pitch_deg = INT8_MIN,
        .roll_deg = INT8_MAX,
        .flags = 0xFFu,
        .mode_id = 4u,
        .enc_a = INT16_MIN,
        .enc_b = INT16_MAX,
        .head_deg = -40,
        .speed_a = -128,
        .speed_b = 127,
        .seq = 0u,
    };
    assert(vernie_telemetry_encode(&extreme, out) == VERNIE_TELEMETRY_BYTES);
    assert(out[1] == 0xFF && out[2] == 0xFF);
    assert(out[5] == 0x80 && out[6] == 0x7F);
    assert(out[9] == 0x00 && out[10] == 0x80);
    assert(out[11] == 0xFF && out[12] == 0x7F);
    assert(out[15] == 0x80 && out[16] == 0x7F);
}

static void test_mtu_and_bounds(void) {
    vernie_cmd_t cmd;
    uint8_t oversized[18] = { 7, 1, 0 };
    assert(vernie_cmd_decode(NULL, 5, &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(oversized, 5, NULL) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(oversized, 0, &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(oversized, 18, &cmd) == VERNIE_PARSE_ERR_LENGTH);
    // Exact 17-byte max macro chunk must succeed.
    assert(vernie_cmd_decode(oversized, 17, &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.macro_op.data_len == 14);

    // Truncated / wrong-length packets for each fixed-size opcode.
    const uint8_t short_drive[] = { 1, 10, 10 };
    const uint8_t short_head[] = { 2, 10 };
    const uint8_t short_dart[] = { 3, 1 };
    const uint8_t short_synth[] = { 4, 1, 60, 10 };
    const uint8_t short_led[] = { 5, 0, 1, 2 };
    const uint8_t long_mode[] = { 6, 1, 2 };
    assert(vernie_cmd_decode(short_drive, sizeof(short_drive), &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(short_head, sizeof(short_head), &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(short_dart, sizeof(short_dart), &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(short_synth, sizeof(short_synth), &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(short_led, sizeof(short_led), &cmd) == VERNIE_PARSE_ERR_LENGTH);
    assert(vernie_cmd_decode(long_mode, sizeof(long_mode), &cmd) == VERNIE_PARSE_ERR_LENGTH);

    const uint8_t bad_op[] = { 0xFE };
    assert(vernie_cmd_decode(bad_op, sizeof(bad_op), &cmd) == VERNIE_PARSE_ERR_OPCODE);
}

static void test_deadman_timeout_and_wraparound(void) {
    vernie_control_state_t st;
    vernie_control_init(&st, false);

    vernie_cmd_t cmd;
    const uint8_t drive_bytes[] = { 1, 50, 50, 144, 1 }; // timeout_ms = 400
    assert(vernie_cmd_decode(drive_bytes, sizeof(drive_bytes), &cmd) == VERNIE_PARSE_OK);

    // Test across uint32_t millisecond counter wraparound!
    uint32_t t0 = 0xFFFFFF00u;
    assert(vernie_control_apply(&st, &cmd, t0) == VERNIE_PARSE_OK);
    assert(st.drive_active);
    assert(!vernie_control_tick(&st, t0 + 399u));
    assert(st.drive_active);
    assert(vernie_control_tick(&st, t0 + 400u));
    assert(!st.drive_active && st.drive_left == 0 && st.drive_right == 0);

    // DRIVE(0, 0) sets drive_active = false immediately.
    const uint8_t drive_zero[] = { 1, 0, 0, 144, 1 };
    assert(vernie_cmd_decode(drive_zero, sizeof(drive_zero), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 5000u) == VERNIE_PARSE_OK);
    assert(!st.drive_active && st.drive_left == 0 && st.drive_right == 0);

    // Clamping timeout < 100 ms up to 100 ms, > 1000 ms down to 1000 ms.
    const uint8_t drive_tiny[] = { 1, 20, 20, 10, 0 };
    assert(vernie_cmd_decode(drive_tiny, sizeof(drive_tiny), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.drive.timeout_ms == 100);
    const uint8_t drive_huge[] = { 1, 20, 20, 0x10, 0x27 }; // 10000 ms
    assert(vernie_cmd_decode(drive_huge, sizeof(drive_huge), &cmd) == VERNIE_PARSE_OK);
    assert(cmd.u.drive.timeout_ms == 1000);
}

static void test_head_and_defensive_apply(void) {
    vernie_control_state_t st;
    vernie_control_init(&st, false);
    vernie_cmd_t cmd;

    // Move head to -25, then home -> head_target_deg must reset to 0 and head_home_requested = true.
    const uint8_t head_angle[] = { 2, 231, 60 };
    assert(vernie_cmd_decode(head_angle, sizeof(head_angle), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 100) == VERNIE_PARSE_OK);
    assert(st.head_target_deg == -25 && !st.head_home_requested);

    const uint8_t head_home[] = { 2, 127, 25 };
    assert(vernie_cmd_decode(head_home, sizeof(head_home), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 200) == VERNIE_PARSE_OK);
    assert(st.head_home_requested && st.head_target_deg == 0);

    // Subsequent angle command clears head_home_requested.
    assert(vernie_cmd_decode(head_angle, sizeof(head_angle), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 300) == VERNIE_PARSE_OK);
    assert(!st.head_home_requested && st.head_target_deg == -25);

    // Defensive vernie_control_apply checks when invoked directly without decode:
    memset(&cmd, 0, sizeof(cmd));
    cmd.opcode = VERNIE_OP_LED;
    cmd.u.led.target = 99;
    assert(vernie_control_apply(&st, &cmd, 400) == VERNIE_PARSE_ERR_VALUE);

    cmd.u.led.target = VERNIE_LED_TARGET_CHEST_4STATE;
    cmd.u.led.a = 7; // invalid 88007 chest LED state
    assert(vernie_control_apply(&st, &cmd, 400) == VERNIE_PARSE_ERR_VALUE);

    memset(&cmd, 0, sizeof(cmd));
    cmd.opcode = VERNIE_OP_SET_MODE;
    cmd.u.set_mode.mode_id = 9;
    assert(vernie_control_apply(&st, &cmd, 400) == VERNIE_PARSE_ERR_VALUE);

    memset(&cmd, 0, sizeof(cmd));
    cmd.opcode = VERNIE_OP_SYNTH;
    cmd.u.synth.voice = 5;
    assert(vernie_control_apply(&st, &cmd, 400) == VERNIE_PARSE_ERR_VALUE);

    assert(vernie_control_apply(NULL, &cmd, 400) == VERNIE_PARSE_ERR_VALUE);
    assert(vernie_control_apply(&st, NULL, 400) == VERNIE_PARSE_ERR_VALUE);
}

static void test_dart_interlock_and_safe_mode(void) {
    vernie_control_state_t st;
    vernie_control_init(&st, false);
    vernie_cmd_t cmd;

    // Boot default is disarmed -> FIRE must fail!
    const uint8_t dart_fire[] = { 3, 2, 165 };
    assert(vernie_cmd_decode(dart_fire, sizeof(dart_fire), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1000) == VERNIE_PARSE_ERR_INTERLOCK);
    assert(!st.dart_fire_requested);

    // Bad magic must fail decode!
    const uint8_t dart_bad_magic[] = { 3, 1, 0x00 };
    assert(vernie_cmd_decode(dart_bad_magic, sizeof(dart_bad_magic), &cmd) == VERNIE_PARSE_ERR_INTERLOCK);

    // Arm then Fire succeeds.
    const uint8_t dart_arm[] = { 3, 1, 165 };
    assert(vernie_cmd_decode(dart_arm, sizeof(dart_arm), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1000) == VERNIE_PARSE_OK);
    assert(st.dart_armed);

    assert(vernie_cmd_decode(dart_fire, sizeof(dart_fire), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1010) == VERNIE_PARSE_OK);
    assert(st.dart_fire_requested);

    // Disconnect clears armed + drive state and drops REMOTE back to PET.
    st.mode_id = VERNIE_MODE_REMOTE;
    vernie_control_on_disconnect(&st);
    assert(!st.dart_armed && !st.dart_fire_requested && !st.drive_active);
    assert(st.mode_id == VERNIE_MODE_PET);

    // Watchdog Safe Mode blocks drive/head/arm/mode/synth/macro, but allows LED & DART DISARM.
    vernie_control_init(&st, true);
    const uint8_t drive_bytes[] = { 1, 50, 50, 144, 1 };
    assert(vernie_cmd_decode(drive_bytes, sizeof(drive_bytes), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1000) == VERNIE_PARSE_ERR_INTERLOCK);

    assert(vernie_cmd_decode(dart_arm, sizeof(dart_arm), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1000) == VERNIE_PARSE_ERR_INTERLOCK);

    const uint8_t dart_disarm[] = { 3, 0, 165 };
    assert(vernie_cmd_decode(dart_disarm, sizeof(dart_disarm), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1000) == VERNIE_PARSE_OK);

    const uint8_t led_hub[] = { 5, 0, 255, 0, 0 };
    assert(vernie_cmd_decode(led_hub, sizeof(led_hub), &cmd) == VERNIE_PARSE_OK);
    assert(vernie_control_apply(&st, &cmd, 1000) == VERNIE_PARSE_OK);
}

static uint32_t xorshift32(uint32_t *state) {
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

static void test_fuzz_decode_and_apply(void) {
    uint32_t rng = 0xC0FFEE42u;
    vernie_control_state_t st;
    vernie_control_init(&st, false);

    for (int iter = 0; iter < 10000; iter++) {
        size_t len = (size_t)(xorshift32(&rng) % 25u); // 0..24 bytes
        uint8_t buf[24];
        for (size_t i = 0; i < len; i++) {
            buf[i] = (uint8_t)(xorshift32(&rng) & 0xFFu);
        }
        // Bias ~50% of cases toward valid opcodes 1..7 to stress every branch deeply.
        if (len > 0 && (iter & 1)) {
            buf[0] = (uint8_t)(1u + (xorshift32(&rng) % 7u));
        }
        vernie_cmd_t cmd;
        vernie_parse_result_t res = vernie_cmd_decode(buf, len, &cmd);
        if (res == VERNIE_PARSE_OK) {
            assert(len >= 1u && len <= VERNIE_RX_MAX_BYTES);
            (void)vernie_control_apply(&st, &cmd, (uint32_t)iter * 20u);
            // Invariants that must ALWAYS hold regardless of input bytes:
            assert(st.drive_left >= -100 && st.drive_left <= 100);
            assert(st.drive_right >= -100 && st.drive_right <= 100);
            assert(st.head_target_deg >= VERNIE_HEAD_MIN_DEG && st.head_target_deg <= VERNIE_HEAD_MAX_DEG);
            assert(st.head_speed <= 100u);
            assert(st.mode_id <= VERNIE_MODE_MAX);
        }
    }
}

int main(void) {
    test_golden_rx_vectors();
    test_golden_tx_telemetry();
    test_mtu_and_bounds();
    test_deadman_timeout_and_wraparound();
    test_head_and_defensive_apply();
    test_dart_interlock_and_safe_mode();
    test_fuzz_decode_and_apply();
    printf("ALL VERNIE PROTOCOL C UNIT TESTS PASSED (including 10,000-packet fuzz).\n");
    return 0;
}
