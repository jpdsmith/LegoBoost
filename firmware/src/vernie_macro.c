// SPDX-License-Identifier: MIT
// Vernie OS Chunked Flash Macro Engine (0x07 MACRO_OP -> FLASH_USER_1 persistence).

#include "vernie_macro.h"

#include <string.h>

#include "vernie_protocol.h"

static int8_t clamp_i8(int32_t v, int8_t lo, int8_t hi) {
    if (v < (int32_t)lo) return lo;
    if (v > (int32_t)hi) return hi;
    return (int8_t)v;
}

static uint16_t clamp_u16(uint16_t v, uint16_t lo, uint16_t hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static bool is_valid_chest_state(uint8_t s) {
    return s == VERNIE_CHEST_LED_OFF ||
           s == VERNIE_CHEST_LED_BLUE ||
           s == VERNIE_CHEST_LED_GREEN ||
           s == VERNIE_CHEST_LED_RED;
}

static void hub_palette_rgb(uint8_t idx, uint8_t *r, uint8_t *g, uint8_t *b) {
    static const uint8_t k_pal[6][3] = {
        {   0, 168, 232 }, // 0: Boost Cyan
        { 255, 122,   0 }, // 1: Vernie Orange
        {  16, 220,  96 }, // 2: Emerald
        { 255,  24,  24 }, // 3: Sentry Red
        { 170,  40, 255 }, // 4: Ultraviolet
        { 255, 220,   0 }, // 5: Solar Yellow
    };
    uint8_t i = idx < 6u ? idx : 0u;
    *r = k_pal[i][0];
    *g = k_pal[i][1];
    *b = k_pal[i][2];
}

void vernie_macro_init(vernie_macro_t *m, const vernie_storage_blob_t *saved_blob) {
    memset(m, 0, sizeof(*m));
    if (saved_blob && saved_blob->macro_len > 0u && saved_blob->macro_len <= VERNIE_MACRO_MAX_BYTES) {
        m->len = saved_blob->macro_len;
        memcpy(m->buf, saved_blob->macro_data, m->len);
    }
}

bool vernie_macro_start(vernie_macro_t *m, uint32_t now_ms) {
    if (!m || m->len < VERNIE_MACRO_STEP_BYTES || (m->len % VERNIE_MACRO_STEP_BYTES) != 0u) {
        return false;
    }
    m->playing = true;
    m->step_offset = 0u;
    m->step_end_ms = now_ms;
    m->step_started = false;
    return true;
}

void vernie_macro_stop(vernie_macro_t *m) {
    if (!m) {
        return;
    }
    m->playing = false;
    m->step_offset = 0u;
    m->step_started = false;
}

bool vernie_macro_handle_cmd(
    vernie_macro_t *m,
    vernie_storage_t *storage,
    uint8_t subcmd,
    uint8_t offset,
    const uint8_t *data,
    uint8_t data_len,
    uint32_t now_ms
) {
    if (!m) {
        return false;
    }

    switch (subcmd) {
        case VERNIE_MACRO_SUB_CLEAR:
            vernie_macro_stop(m);
            m->len = 0u;
            memset(m->buf, 0, sizeof(m->buf));
            return true;

        case VERNIE_MACRO_SUB_WRITE_CHUNK: {
            if (data_len == 0u || !data || data_len > VERNIE_MACRO_CHUNK_MAX) {
                return false;
            }
            uint16_t end = (uint16_t)offset + (uint16_t)data_len;
            if (end > VERNIE_MACRO_MAX_BYTES) {
                return false;
            }
            vernie_macro_stop(m);
            memcpy(&m->buf[offset], data, data_len);
            if (end > m->len) {
                m->len = end;
            }
            return true;
        }

        case VERNIE_MACRO_SUB_PLAY:
            return vernie_macro_start(m, now_ms);

        case VERNIE_MACRO_SUB_STOP:
            vernie_macro_stop(m);
            return true;

        case VERNIE_MACRO_SUB_SAVE:
            if (!storage || m->len > VERNIE_STORAGE_MACRO_MAX || (m->len % VERNIE_MACRO_STEP_BYTES) != 0u) {
                return false;
            }
            storage->blob.macro_len = m->len;
            memset(storage->blob.macro_data, 0, sizeof(storage->blob.macro_data));
            if (m->len > 0u) {
                memcpy(storage->blob.macro_data, m->buf, m->len);
            }
            vernie_storage_mark_dirty(storage);
            return true;

        default:
            return false;
    }
}

void vernie_macro_tick(
    vernie_macro_t *m,
    bool safe_mode,
    bool picked_up,
    uint32_t now_ms,
    vernie_macro_output_t *out
) {
    memset(out, 0, sizeof(*out));
    if (!m || !m->playing) {
        return;
    }

    if (safe_mode || picked_up) {
        vernie_macro_stop(m);
        return;
    }

    // Advance past completed step.
    if (m->step_started && (int32_t)(now_ms - m->step_end_ms) >= 0) {
        m->step_offset = (uint16_t)(m->step_offset + VERNIE_MACRO_STEP_BYTES);
        m->step_started = false;
    }

    if ((uint16_t)(m->step_offset + VERNIE_MACRO_STEP_BYTES) > m->len) {
        vernie_macro_stop(m);
        return;
    }

    const uint8_t *step = &m->buf[m->step_offset];
    uint8_t op = step[0];
    uint8_t arg0 = step[1];
    uint8_t arg1 = step[2];
    uint16_t raw_dur = (uint16_t)((uint16_t)step[3] | ((uint16_t)step[4] << 8));
    uint16_t dur_ms = clamp_u16(raw_dur, VERNIE_MACRO_DUR_MIN_MS, VERNIE_MACRO_DUR_MAX_MS);

    bool first_tick = !m->step_started;
    if (first_tick) {
        m->step_started = true;
        m->step_end_ms = now_ms + dur_ms;
    }

    out->active = true;

    switch (op) {
        case VERNIE_MSTEP_DRIVE:
            out->drive_left = clamp_i8((int8_t)arg0, -100, 100);
            out->drive_right = clamp_i8((int8_t)arg1, -100, 100);
            out->drive_active = (out->drive_left != 0 || out->drive_right != 0);
            break;

        case VERNIE_MSTEP_HEAD:
            if (first_tick) {
                out->head_cmd = true;
                out->head_angle_deg = clamp_i8((int8_t)arg0, VERNIE_HEAD_MIN_DEG, VERNIE_HEAD_MAX_DEG);
                out->head_speed = arg1 < 10u ? 10u : (arg1 > 100u ? 100u : arg1);
            }
            break;

        case VERNIE_MSTEP_SYNTH:
            if (first_tick && arg0 <= 2u) {
                out->synth_cmd = true;
                out->synth_voice = arg0;
                out->synth_preset_or_note = arg1;
                out->synth_dur_ms = dur_ms > 3000u ? 3000u : dur_ms;
            }
            break;

        case VERNIE_MSTEP_LED:
            if (first_tick) {
                if (arg0 == 0u) {
                    out->hub_led_cmd = true;
                    hub_palette_rgb(arg1, &out->hub_r, &out->hub_g, &out->hub_b);
                } else if (arg0 == 1u && is_valid_chest_state(arg1)) {
                    out->chest_led_cmd = true;
                    out->chest_led = arg1;
                }
            }
            break;

        case VERNIE_MSTEP_WAIT:
        default:
            // Coast tracks & wait dur_ms (unknown opcodes fail safe as WAIT).
            break;
    }
}
