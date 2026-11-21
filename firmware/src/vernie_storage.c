// SPDX-License-Identifier: MIT
// Vernie OS Persistent Storage on STM32F070RB FLASH_USER_1 (0x0801F800, 2 KiB, unchecked).

#include "vernie_storage.h"

#include <stddef.h>
#include <string.h>

#ifndef VERNIE_HOST_TEST
#include <stm32f0xx.h>
#include <stm32f0xx_hal.h>
#include <pbdrv/watchdog.h>
#endif

uint32_t vernie_crc32(const void *data, size_t len) {
    const uint8_t *bytes = (const uint8_t *)data;
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0u; i < len; i++) {
        crc ^= (uint32_t)bytes[i];
        for (uint8_t bit = 0u; bit < 8u; bit++) {
            if (crc & 1u) {
                crc = (crc >> 1) ^ 0xEDB88320u;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc ^ 0xFFFFFFFFu;
}

static bool blob_is_valid(const vernie_storage_blob_t *b) {
    if (b->magic != VERNIE_STORAGE_MAGIC || b->version != VERNIE_STORAGE_VERSION) {
        return false;
    }
    if (b->head_home_offset_deg < VERNIE_HEAD_HOME_OFFSET_MIN ||
        b->head_home_offset_deg > VERNIE_HEAD_HOME_OFFSET_MAX) {
        return false;
    }
    if (b->default_mode > 3u || b->synth_volume_pct < 10u || b->synth_volume_pct > 100u) {
        return false;
    }
    if (b->macro_len > VERNIE_STORAGE_MACRO_MAX) {
        return false;
    }
    uint32_t expected = vernie_crc32(b, offsetof(vernie_storage_blob_t, crc32));
    return b->crc32 == expected;
}

void vernie_storage_set_defaults(vernie_storage_blob_t *blob) {
    memset(blob, 0, sizeof(*blob));
    blob->magic = VERNIE_STORAGE_MAGIC;
    blob->version = VERNIE_STORAGE_VERSION;
    blob->flags = 0u;
    blob->head_home_offset_deg = VERNIE_HEAD_HOME_OFFSET_DEFAULT;
    blob->imu_pitch_zero_deg = 0;
    blob->imu_roll_zero_deg = 0;
    blob->default_mode = 0u;
    blob->synth_volume_pct = 75u;
    blob->macro_len = 0u;
    blob->crc32 = vernie_crc32(blob, offsetof(vernie_storage_blob_t, crc32));
}

bool vernie_storage_init(vernie_storage_t *st, const vernie_flash_backend_t *backend, uint32_t addr) {
    memset(st, 0, sizeof(*st));
    vernie_storage_set_defaults(&st->blob);

    // Strictly forbid any flash target other than unchecked FLASH_USER_1 (0x0801F800).
    if (addr != VERNIE_FLASH_USER_1_ADDR || !backend || !backend->read_page) {
        return false;
    }
    st->target_addr = addr;
    st->backend = *backend;

    vernie_storage_blob_t candidate;
    if (st->backend.read_page(st->target_addr, &candidate, sizeof(candidate), st->backend.ctx) &&
        blob_is_valid(&candidate)) {
        st->blob = candidate;
        st->loaded_valid = true;
        return true;
    }

    // Erased (0xFF) or corrupted flash -> safe defaults retained.
    st->loaded_valid = false;
    return false;
}

void vernie_storage_mark_dirty(vernie_storage_t *st) {
    if (st) {
        st->dirty = true;
    }
}

bool vernie_storage_try_flush(vernie_storage_t *st, bool motors_active) {
    if (!st || !st->dirty || motors_active) {
        return false;
    }
    if (st->target_addr != VERNIE_FLASH_USER_1_ADDR || !st->backend.erase_and_write_page) {
        return false;
    }

    // Re-clamp fields & recompute CRC32 before programming flash.
    st->blob.magic = VERNIE_STORAGE_MAGIC;
    st->blob.version = VERNIE_STORAGE_VERSION;
    if (st->blob.head_home_offset_deg < VERNIE_HEAD_HOME_OFFSET_MIN) {
        st->blob.head_home_offset_deg = VERNIE_HEAD_HOME_OFFSET_MIN;
    } else if (st->blob.head_home_offset_deg > VERNIE_HEAD_HOME_OFFSET_MAX) {
        st->blob.head_home_offset_deg = VERNIE_HEAD_HOME_OFFSET_MAX;
    }
    if (st->blob.default_mode > 3u) {
        st->blob.default_mode = 0u;
    }
    if (st->blob.synth_volume_pct < 10u) {
        st->blob.synth_volume_pct = 10u;
    } else if (st->blob.synth_volume_pct > 100u) {
        st->blob.synth_volume_pct = 100u;
    }
    if (st->blob.macro_len > VERNIE_STORAGE_MACRO_MAX) {
        st->blob.macro_len = VERNIE_STORAGE_MACRO_MAX;
    }
    st->blob.crc32 = vernie_crc32(&st->blob, offsetof(vernie_storage_blob_t, crc32));

    if (!st->backend.erase_and_write_page(
            st->target_addr, &st->blob, sizeof(st->blob), st->backend.ctx)) {
        return false;
    }

    // Verify readback if backend supports reading.
    if (st->backend.read_page) {
        vernie_storage_blob_t verify;
        if (!st->backend.read_page(st->target_addr, &verify, sizeof(verify), st->backend.ctx) ||
            memcmp(&verify, &st->blob, sizeof(verify)) != 0) {
            return false;
        }
    }

    st->dirty = false;
    st->loaded_valid = true;
    return true;
}

// ============================================================================
// STM32F070RB HAL Flash Backend (FLASH_USER_1 = 0x0801F800, 2 KiB page ONLY)
// ============================================================================
#ifndef VERNIE_HOST_TEST

static bool stm32_flash_read(uint32_t addr, void *dst, size_t len, void *ctx) {
    (void)ctx;
    if (addr != VERNIE_FLASH_USER_1_ADDR || len > VERNIE_FLASH_USER_1_SIZE) {
        return false;
    }
    memcpy(dst, (const void *)addr, len);
    return true;
}

static bool stm32_flash_erase_and_write(uint32_t addr, const void *src, size_t len, void *ctx) {
    (void)ctx;
    if (addr != VERNIE_FLASH_USER_1_ADDR || len == 0u || len > VERNIE_FLASH_USER_1_SIZE || (len % 4u) != 0u) {
        return false;
    }

    // Feed 3-second IWDG watchdog right before masking IRQs for ~30 ms flash erase/write.
    pbdrv_watchdog_update();

    if (HAL_FLASH_Unlock() != HAL_OK) {
        return false;
    }

    FLASH_EraseInitTypeDef erase = {
        .TypeErase = FLASH_TYPEERASE_PAGES,
        .PageAddress = VERNIE_FLASH_USER_1_ADDR,
        .NbPages = 1u,
    };
    uint32_t page_error = 0u;

    uint32_t primask = __get_PRIMASK();
    __disable_irq();
    HAL_StatusTypeDef status = HAL_FLASHEx_Erase(&erase, &page_error);
    __set_PRIMASK(primask);

    bool ok = (status == HAL_OK && page_error == 0xFFFFFFFFu);

    const uint32_t *words = (const uint32_t *)src;
    size_t word_count = len / 4u;
    for (size_t i = 0u; ok && i < word_count; i++) {
        primask = __get_PRIMASK();
        __disable_irq();
        status = HAL_FLASH_Program(
            FLASH_TYPEPROGRAM_WORD,
            VERNIE_FLASH_USER_1_ADDR + (uint32_t)(i * 4u),
            words[i]
        );
        __set_PRIMASK(primask);
        ok = (status == HAL_OK);
    }

    (void)HAL_FLASH_Lock();
    pbdrv_watchdog_update();
    return ok;
}

vernie_flash_backend_t vernie_storage_stm32_backend(void) {
    vernie_flash_backend_t backend = {
        .read_page = stm32_flash_read,
        .erase_and_write_page = stm32_flash_erase_and_write,
        .ctx = NULL,
    };
    return backend;
}
#endif // !VERNIE_HOST_TEST
