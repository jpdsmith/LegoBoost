// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for Chunked Flash Macro Engine (vernie_macro.c).
// Covers T3.5 (chunk bounds), bytecode playback, pickup/safe-mode abort, and FLASH_USER_1 save/reload.

#include "vernie_macro.h"
#include "vernie_protocol.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    uint8_t page[VERNIE_FLASH_USER_1_SIZE];
    int writes;
} mock_flash_t;

static bool mock_read(uint32_t addr, void *dst, size_t len, void *ctx) {
    mock_flash_t *f = (mock_flash_t *)ctx;
    if (addr != VERNIE_FLASH_USER_1_ADDR || len > sizeof(f->page)) return false;
    memcpy(dst, f->page, len);
    return true;
}

static bool mock_write(uint32_t addr, const void *src, size_t len, void *ctx) {
    mock_flash_t *f = (mock_flash_t *)ctx;
    if (addr != VERNIE_FLASH_USER_1_ADDR || len > sizeof(f->page)) return false;
    memset(f->page, 0xFF, sizeof(f->page));
    memcpy(f->page, src, len);
    f->writes++;
    return true;
}

static void encode_step(uint8_t dst[5], uint8_t op, int8_t a, int8_t b, uint16_t dur_ms) {
    dst[0] = op;
    dst[1] = (uint8_t)a;
    dst[2] = (uint8_t)b;
    dst[3] = (uint8_t)(dur_ms & 0xFFu);
    dst[4] = (uint8_t)((dur_ms >> 8) & 0xFFu);
}

static void test_chunk_bounds_and_validation(void) {
    vernie_macro_t m;
    vernie_macro_init(&m, NULL);

    uint8_t chunk[14] = { 0 };
    // Empty or oversized chunk (> 14 B) rejected.
    assert(!vernie_macro_handle_cmd(&m, NULL, VERNIE_MACRO_SUB_WRITE_CHUNK, 0u, chunk, 0u, 0u));
    assert(!vernie_macro_handle_cmd(&m, NULL, VERNIE_MACRO_SUB_WRITE_CHUNK, 0u, chunk, 15u, 0u));
    // Overflow past 232-byte FLASH_USER_1 macro buffer rejected (225 + 10 = 235 > 232).
    assert(!vernie_macro_handle_cmd(&m, NULL, VERNIE_MACRO_SUB_WRITE_CHUNK, 225u, chunk, 10u, 0u));

    // Unaligned length (3 bytes) cannot PLAY.
    assert(vernie_macro_handle_cmd(&m, NULL, VERNIE_MACRO_SUB_WRITE_CHUNK, 0u, chunk, 3u, 0u));
    assert(!vernie_macro_handle_cmd(&m, NULL, VERNIE_MACRO_SUB_PLAY, 0u, NULL, 0u, 10u));

    // Unknown subcmd rejected.
    assert(!vernie_macro_handle_cmd(&m, NULL, 99u, 0u, NULL, 0u, 10u));
}

static void test_chunked_upload_save_reload_and_playback(void) {
    mock_flash_t mf;
    memset(mf.page, 0xFF, sizeof(mf.page));
    mf.writes = 0;
    vernie_flash_backend_t fb = { .read_page = mock_read, .erase_and_write_page = mock_write, .ctx = &mf };
    vernie_storage_t st;
    (void)vernie_storage_init(&st, &fb, VERNIE_FLASH_USER_1_ADDR);

    vernie_macro_t m;
    vernie_macro_init(&m, &st.blob);

    // Build 4-step routine (20 bytes) uploaded as two 10-byte BLE chunks (<= 14 B each!):
    //   Step 0: DRIVE(120->100, -50, 300 ms)
    //   Step 1: HEAD(80->35, 60%, 200 ms)
    //   Step 2: SYNTH(voice=1, preset=2, 4000->3000 ms)
    //   Step 3: LED(target=1 chest, RED=9, 150 ms)
    uint8_t chunk1[10];
    uint8_t chunk2[10];
    encode_step(&chunk1[0], VERNIE_MSTEP_DRIVE, 120, -50, 300u);
    encode_step(&chunk1[5], VERNIE_MSTEP_HEAD, 80, 60, 200u);
    encode_step(&chunk2[0], VERNIE_MSTEP_SYNTH, 1, 2, 4000u);
    encode_step(&chunk2[5], VERNIE_MSTEP_LED, 1, VERNIE_CHEST_LED_RED, 150u);

    assert(vernie_macro_handle_cmd(&m, &st, VERNIE_MACRO_SUB_CLEAR, 0u, NULL, 0u, 0u));
    assert(vernie_macro_handle_cmd(&m, &st, VERNIE_MACRO_SUB_WRITE_CHUNK, 0u, chunk1, 10u, 10u));
    assert(vernie_macro_handle_cmd(&m, &st, VERNIE_MACRO_SUB_WRITE_CHUNK, 10u, chunk2, 10u, 20u));
    assert(m.len == 20u);

    // SAVE marks storage dirty; idle flush persists to FLASH_USER_1!
    assert(vernie_macro_handle_cmd(&m, &st, VERNIE_MACRO_SUB_SAVE, 0u, NULL, 0u, 30u));
    assert(st.dirty);
    assert(vernie_storage_try_flush(&st, false, 100u));
    assert(mf.writes == 1);

    // Cold-boot reload restores exact 20-byte macro from FLASH_USER_1!
    vernie_storage_t st2;
    assert(vernie_storage_init(&st2, &fb, VERNIE_FLASH_USER_1_ADDR));
    vernie_macro_t m2;
    vernie_macro_init(&m2, &st2.blob);
    assert(m2.len == 20u);
    assert(vernie_macro_start(&m2, 1000u));

    vernie_macro_output_t out;
    // Step 0: DRIVE(100, -50) active on [1000, 1300)
    vernie_macro_tick(&m2, false, false, 1000u, &out);
    assert(out.active && out.drive_active && out.drive_left == 100 && out.drive_right == -50);
    vernie_macro_tick(&m2, false, false, 1280u, &out);
    assert(out.active && out.drive_active);

    // Step 1: HEAD clamped to +35 deg fires once at t=1300
    vernie_macro_tick(&m2, false, false, 1300u, &out);
    assert(out.active && !out.drive_active && out.head_cmd && out.head_angle_deg == 35);
    vernie_macro_tick(&m2, false, false, 1340u, &out);
    assert(out.active && !out.head_cmd);

    // Step 2: SYNTH duration clamped to 3000 ms thermal limit at t=1500
    vernie_macro_tick(&m2, false, false, 1500u, &out);
    assert(out.active && out.synth_cmd && out.synth_voice == 1u && out.synth_preset_or_note == 2u);
    assert(out.synth_dur_ms == 3000u);

    // Step 3: Chest LED RED at t=5500 (step 2 clamped raw_dur=4000 ms -> 1500+4000=5500)
    vernie_macro_tick(&m2, false, false, 5500u, &out);
    assert(out.active && out.chest_led_cmd && out.chest_led == VERNIE_CHEST_LED_RED);

    // Macro finishes cleanly at t=5650!
    vernie_macro_tick(&m2, false, false, 5650u, &out);
    assert(!out.active && !m2.playing);
}

static void test_pickup_and_safe_mode_abort_macro(void) {
    vernie_macro_t m;
    vernie_macro_init(&m, NULL);
    uint8_t step[5];
    encode_step(step, VERNIE_MSTEP_DRIVE, 50, 50, 1000u);
    assert(vernie_macro_handle_cmd(&m, NULL, VERNIE_MACRO_SUB_WRITE_CHUNK, 0u, step, 5u, 0u));
    assert(vernie_macro_start(&m, 100u));

    vernie_macro_output_t out;
    vernie_macro_tick(&m, false, false, 100u, &out);
    assert(out.active && out.drive_active);

    // Picked up -> immediate abort & coast!
    vernie_macro_tick(&m, false, true, 120u, &out);
    assert(!out.active && !out.drive_active && !m.playing);

    // Safe mode -> immediate abort & coast!
    assert(vernie_macro_start(&m, 200u));
    vernie_macro_tick(&m, true, false, 200u, &out);
    assert(!out.active && !m.playing);
}

int main(void) {
    test_chunk_bounds_and_validation();
    test_chunked_upload_save_reload_and_playback();
    test_pickup_and_safe_mode_abort_macro();
    printf("ALL VERNIE MACRO C UNIT TESTS PASSED.\n");
    return 0;
}
