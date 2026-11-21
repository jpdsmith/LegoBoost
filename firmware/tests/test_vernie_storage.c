// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for FLASH_USER_1 CRC32 Storage (vernie_storage.c).
// Covers T3.16: strict 0x0801F800 guard, CRC32 round-trip, corrupt/erased fallback, deferred flush.

#include "vernie_storage.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    uint8_t page[VERNIE_FLASH_USER_1_SIZE];
    int write_count;
    uint32_t last_addr;
} mock_flash_t;

static bool mock_read(uint32_t addr, void *dst, size_t len, void *ctx) {
    mock_flash_t *m = (mock_flash_t *)ctx;
    if (addr != VERNIE_FLASH_USER_1_ADDR || len > sizeof(m->page)) return false;
    memcpy(dst, m->page, len);
    return true;
}

static bool mock_erase_write(uint32_t addr, const void *src, size_t len, void *ctx) {
    mock_flash_t *m = (mock_flash_t *)ctx;
    if (addr != VERNIE_FLASH_USER_1_ADDR || len > sizeof(m->page)) return false;
    memset(m->page, 0xFF, sizeof(m->page));
    memcpy(m->page, src, len);
    m->write_count++;
    m->last_addr = addr;
    return true;
}

static void test_crc32_known_vector(void) {
    // Standard IEEE 802.3 CRC-32 check vector: CRC32("123456789") == 0xCBF43926
    assert(vernie_crc32("123456789", 9u) == 0xCBF43926u);
}

static void test_flash_user_0_rejected_and_erased_fallback(void) {
    mock_flash_t mf;
    memset(mf.page, 0xFF, sizeof(mf.page));
    mf.write_count = 0;

    vernie_flash_backend_t backend = {
        .read_page = mock_read,
        .erase_and_write_page = mock_erase_write,
        .ctx = &mf,
    };
    vernie_storage_t st;

    // MUST reject FLASH_USER_0 (0x0801F000) to protect bootloader zero-sum region!
    assert(!vernie_storage_init(&st, &backend, 0x0801F000u));
    vernie_storage_mark_dirty(&st);
    assert(!vernie_storage_try_flush(&st, false));
    assert(mf.write_count == 0);

    // Erased 0xFF FLASH_USER_1 falls back cleanly to safe defaults.
    assert(!vernie_storage_init(&st, &backend, VERNIE_FLASH_USER_1_ADDR));
    assert(!st.loaded_valid);
    assert(st.blob.head_home_offset_deg == VERNIE_HEAD_HOME_OFFSET_DEFAULT);
    assert(st.blob.synth_volume_pct == 75u);
    assert(st.blob.default_mode == 0u);
}

static void test_roundtrip_deferred_flush_and_corruption_recovery(void) {
    mock_flash_t mf;
    memset(mf.page, 0xFF, sizeof(mf.page));
    mf.write_count = 0;

    vernie_flash_backend_t backend = {
        .read_page = mock_read,
        .erase_and_write_page = mock_erase_write,
        .ctx = &mf,
    };
    vernie_storage_t st;
    (void)vernie_storage_init(&st, &backend, VERNIE_FLASH_USER_1_ADDR);

    st.blob.head_home_offset_deg = 52;
    st.blob.imu_pitch_zero_deg = -3;
    st.blob.default_mode = 2u;
    st.blob.synth_volume_pct = 90u;
    st.blob.macro_len = 4u;
    st.blob.macro_data[0] = 0xAAu;
    st.blob.macro_data[3] = 0x55u;
    vernie_storage_mark_dirty(&st);

    // Flush MUST be deferred whenever motors are active!
    assert(!vernie_storage_try_flush(&st, true));
    assert(st.dirty && mf.write_count == 0);

    // Once motors are idle, flush succeeds to exact FLASH_USER_1 address.
    assert(vernie_storage_try_flush(&st, false));
    assert(!st.dirty && mf.write_count == 1 && mf.last_addr == VERNIE_FLASH_USER_1_ADDR);

    // Cold-boot reload restores every saved field verbatim.
    vernie_storage_t reloaded;
    assert(vernie_storage_init(&reloaded, &backend, VERNIE_FLASH_USER_1_ADDR));
    assert(reloaded.loaded_valid);
    assert(reloaded.blob.head_home_offset_deg == 52);
    assert(reloaded.blob.imu_pitch_zero_deg == -3);
    assert(reloaded.blob.default_mode == 2u);
    assert(reloaded.blob.synth_volume_pct == 90u);
    assert(reloaded.blob.macro_len == 4u && reloaded.blob.macro_data[3] == 0x55u);

    // Flip 1 bit in flash -> CRC32 fails -> safe defaults restored cleanly!
    mf.page[12] ^= 0x01u;
    vernie_storage_t corrupted;
    assert(!vernie_storage_init(&corrupted, &backend, VERNIE_FLASH_USER_1_ADDR));
    assert(!corrupted.loaded_valid);
    assert(corrupted.blob.head_home_offset_deg == VERNIE_HEAD_HOME_OFFSET_DEFAULT);
    assert(corrupted.blob.default_mode == 0u);
}

int main(void) {
    test_crc32_known_vector();
    test_flash_user_0_rejected_and_erased_fallback();
    test_roundtrip_deferred_flush_and_corruption_recovery();
    printf("ALL VERNIE STORAGE C UNIT TESTS PASSED.\n");
    return 0;
}
