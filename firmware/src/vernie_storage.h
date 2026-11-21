// SPDX-License-Identifier: MIT
// Vernie OS Persistent Storage on STM32F070RB FLASH_USER_1 (0x0801F800, 2 KiB, unchecked).
//
// Safety Invariants:
//   - Strictly targets FLASH_USER_1 [0x0801F800, 0x08020000); NEVER writes FLASH_USER_0 (0x0801F000)!
//   - Protected by magic + schema version + IEEE 802.3 CRC32; corrupt/erased page falls back to defaults.
//   - Dart launcher is NEVER persisted armed (always disarmed on boot).
//   - Deferred flush: never erases/writes flash while any motor is active.

#ifndef VERNIE_STORAGE_H
#define VERNIE_STORAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VERNIE_FLASH_USER_1_ADDR    (0x0801F800u)
#define VERNIE_FLASH_USER_1_SIZE    (2048u)
#define VERNIE_STORAGE_MAGIC        (0x5645524Eu) // "VERN"
#define VERNIE_STORAGE_VERSION      (1u)
#define VERNIE_STORAGE_MACRO_MAX    (232u)

#define VERNIE_HEAD_HOME_OFFSET_DEFAULT (45)
#define VERNIE_HEAD_HOME_OFFSET_MIN     (15)
#define VERNIE_HEAD_HOME_OFFSET_MAX     (75)

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t flags;
    int16_t head_home_offset_deg;
    int16_t imu_pitch_zero_deg;
    int16_t imu_roll_zero_deg;
    uint8_t default_mode;
    uint8_t synth_volume_pct;
    uint16_t macro_len;
    uint16_t reserved;
    uint8_t macro_data[VERNIE_STORAGE_MACRO_MAX];
    uint32_t crc32;
} vernie_storage_blob_t;

_Static_assert(sizeof(vernie_storage_blob_t) == 256u, "vernie_storage_blob_t must be exactly 256 bytes");

typedef struct {
    bool (*read_page)(uint32_t addr, void *dst, size_t len, void *ctx);
    bool (*erase_and_write_page)(uint32_t addr, const void *src, size_t len, void *ctx);
    void *ctx;
} vernie_flash_backend_t;

typedef struct {
    vernie_storage_blob_t blob;
    bool loaded_valid;
    bool dirty;
    uint32_t target_addr;
    vernie_flash_backend_t backend;
} vernie_storage_t;

/**
 * Standard IEEE 802.3 CRC-32 (polynomial 0xEDB88320 reflected).
 */
uint32_t vernie_crc32(const void *data, size_t len);

/**
 * Populate blob with safe factory defaults (head offset 45 deg, synth vol 75%, mode 0, dart disarmed).
 */
void vernie_storage_set_defaults(vernie_storage_blob_t *blob);

/**
 * Load & validate blob from FLASH_USER_1. Falls back cleanly to defaults on erased/corrupt flash.
 */
bool vernie_storage_init(vernie_storage_t *st, const vernie_flash_backend_t *backend, uint32_t addr);

/**
 * Mark staging blob dirty so the next idle/shutdown flush commits it to FLASH_USER_1.
 */
void vernie_storage_mark_dirty(vernie_storage_t *st);

/**
 * Attempt to flush dirty staging blob to FLASH_USER_1.
 * Defers (returns false) whenever motors_active == true so flash erase stall never disrupts motion.
 */
bool vernie_storage_try_flush(vernie_storage_t *st, bool motors_active);

#ifndef VERNIE_HOST_TEST
vernie_flash_backend_t vernie_storage_stm32_backend(void);
#endif

#ifdef __cplusplus
}
#endif

#endif // VERNIE_STORAGE_H
