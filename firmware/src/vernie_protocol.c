// SPDX-License-Identifier: MIT
// Vernie OS Layer-2 Binary BLE Protocol codec & safety state machine.

#include "vernie_protocol.h"

#include <string.h>

static uint16_t read_u16_le(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static void write_u16_le(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
}

static int8_t clamp_i8(int32_t v, int8_t lo, int8_t hi) {
    if (v < (int32_t)lo) {
        return lo;
    }
    if (v > (int32_t)hi) {
        return hi;
    }
    return (int8_t)v;
}

static uint16_t clamp_u16(uint16_t v, uint16_t lo, uint16_t hi) {
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

static bool is_valid_chest_led(uint8_t state) {
    return state == VERNIE_CHEST_LED_OFF ||
           state == VERNIE_CHEST_LED_BLUE ||
           state == VERNIE_CHEST_LED_GREEN ||
           state == VERNIE_CHEST_LED_RED;
}

void vernie_control_init(vernie_control_state_t *st, bool safe_mode) {
    memset(st, 0, sizeof(*st));
    st->safe_mode = safe_mode;
    st->dart_armed = false; // Always disarmed on boot!
    st->mode_id = VERNIE_MODE_PET;
    st->chest_led = VERNIE_CHEST_LED_OFF;
}

vernie_parse_result_t vernie_cmd_decode(const uint8_t *buf, size_t len, vernie_cmd_t *out) {
    if (!buf || !out || len == 0u || len > VERNIE_RX_MAX_BYTES) {
        return VERNIE_PARSE_ERR_LENGTH;
    }

    memset(out, 0, sizeof(*out));
    uint8_t op = buf[0];
    out->opcode = (vernie_opcode_t)op;

    switch (op) {
        case VERNIE_OP_DRIVE: {
            if (len != 5u) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            out->u.drive.left = clamp_i8((int8_t)buf[1], -100, 100);
            out->u.drive.right = clamp_i8((int8_t)buf[2], -100, 100);
            out->u.drive.timeout_ms = clamp_u16(
                read_u16_le(&buf[3]),
                VERNIE_DRIVE_TIMEOUT_MIN_MS,
                VERNIE_DRIVE_TIMEOUT_MAX_MS);
            return VERNIE_PARSE_OK;
        }

        case VERNIE_OP_HEAD: {
            if (len != 3u) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            int8_t raw_angle = (int8_t)buf[1];
            out->u.head.speed = buf[2] > 100u ? 100u : buf[2];
            if (raw_angle == VERNIE_HEAD_HOME_SENTINEL) {
                out->u.head.is_home = true;
                out->u.head.angle_deg = 0;
            } else {
                out->u.head.is_home = false;
                out->u.head.angle_deg = clamp_i8(raw_angle, VERNIE_HEAD_MIN_DEG, VERNIE_HEAD_MAX_DEG);
            }
            return VERNIE_PARSE_OK;
        }

        case VERNIE_OP_DART: {
            if (len != 3u) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            uint8_t subcmd = buf[1];
            uint8_t magic = buf[2];
            if (subcmd > VERNIE_DART_FIRE) {
                return VERNIE_PARSE_ERR_VALUE;
            }
            if (magic != VERNIE_DART_MAGIC) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            out->u.dart.subcmd = subcmd;
            out->u.dart.magic = magic;
            return VERNIE_PARSE_OK;
        }

        case VERNIE_OP_SYNTH: {
            if (len != 5u) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            if (buf[1] > 2u) { // 0 = stop/both, 1 = voice1 (TIM1), 2 = voice2 (TIM3)
                return VERNIE_PARSE_ERR_VALUE;
            }
            out->u.synth.voice = buf[1];
            out->u.synth.preset_or_note = buf[2];
            uint16_t dur = read_u16_le(&buf[3]);
            out->u.synth.dur_ms = dur > 3000u ? 3000u : dur; // 3s hard thermal cap
            return VERNIE_PARSE_OK;
        }

        case VERNIE_OP_LED: {
            if (len != 5u) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            uint8_t target = buf[1];
            if (target == VERNIE_LED_TARGET_HUB_RGB) {
                out->u.led.target = target;
                out->u.led.a = buf[2];
                out->u.led.b = buf[3];
                out->u.led.c = buf[4];
                return VERNIE_PARSE_OK;
            }
            if (target == VERNIE_LED_TARGET_CHEST_4STATE) {
                if (!is_valid_chest_led(buf[2])) {
                    return VERNIE_PARSE_ERR_VALUE;
                }
                out->u.led.target = target;
                out->u.led.a = buf[2];
                out->u.led.b = 0;
                out->u.led.c = 0;
                return VERNIE_PARSE_OK;
            }
            return VERNIE_PARSE_ERR_VALUE;
        }

        case VERNIE_OP_SET_MODE: {
            if (len != 2u) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            if (buf[1] > VERNIE_MODE_MAX) {
                return VERNIE_PARSE_ERR_VALUE;
            }
            out->u.set_mode.mode_id = buf[1];
            return VERNIE_PARSE_OK;
        }

        case VERNIE_OP_MACRO_OP: {
            if (len < 3u || len > VERNIE_RX_MAX_BYTES) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            size_t data_len = len - 3u;
            if (data_len > VERNIE_MACRO_CHUNK_MAX) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            out->u.macro_op.subcmd = buf[1];
            out->u.macro_op.offset = buf[2];
            out->u.macro_op.data_len = (uint8_t)data_len;
            if (data_len > 0u) {
                memcpy(out->u.macro_op.data, &buf[3], data_len);
            }
            return VERNIE_PARSE_OK;
        }

        default:
            return VERNIE_PARSE_ERR_OPCODE;
    }
}

vernie_parse_result_t vernie_control_apply(vernie_control_state_t *st, const vernie_cmd_t *cmd, uint32_t now_ms) {
    if (!st || !cmd) {
        return VERNIE_PARSE_ERR_VALUE;
    }

    switch (cmd->opcode) {
        case VERNIE_OP_DRIVE:
            if (st->safe_mode) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            st->drive_left = cmd->u.drive.left;
            st->drive_right = cmd->u.drive.right;
            st->drive_active = (cmd->u.drive.left != 0 || cmd->u.drive.right != 0);
            st->drive_deadline_ms = now_ms + cmd->u.drive.timeout_ms;
            return VERNIE_PARSE_OK;

        case VERNIE_OP_HEAD:
            if (st->safe_mode) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            st->head_speed = cmd->u.head.speed;
            if (cmd->u.head.is_home) {
                st->head_home_requested = true;
                st->head_cmd_pending = false;
                st->head_target_deg = 0;
            } else {
                st->head_home_requested = false;
                st->head_cmd_pending = true;
                st->head_target_deg = clamp_i8(cmd->u.head.angle_deg, VERNIE_HEAD_MIN_DEG, VERNIE_HEAD_MAX_DEG);
            }
            return VERNIE_PARSE_OK;

        case VERNIE_OP_DART:
            if (cmd->u.dart.magic != VERNIE_DART_MAGIC) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            if (cmd->u.dart.subcmd == VERNIE_DART_DISARM) {
                st->dart_armed = false;
                st->dart_fire_requested = false;
                return VERNIE_PARSE_OK;
            }
            if (st->safe_mode) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            if (cmd->u.dart.subcmd == VERNIE_DART_ARM) {
                st->dart_armed = true;
                return VERNIE_PARSE_OK;
            }
            if (cmd->u.dart.subcmd == VERNIE_DART_FIRE) {
                if (!st->dart_armed) {
                    return VERNIE_PARSE_ERR_INTERLOCK;
                }
                st->dart_fire_requested = true;
                return VERNIE_PARSE_OK;
            }
            return VERNIE_PARSE_ERR_VALUE;

        case VERNIE_OP_LED:
            if (cmd->u.led.target == VERNIE_LED_TARGET_HUB_RGB) {
                st->led_override = true;
                st->hub_r = cmd->u.led.a;
                st->hub_g = cmd->u.led.b;
                st->hub_b = cmd->u.led.c;
                return VERNIE_PARSE_OK;
            }
            if (cmd->u.led.target == VERNIE_LED_TARGET_CHEST_4STATE) {
                if (!is_valid_chest_led(cmd->u.led.a)) {
                    return VERNIE_PARSE_ERR_VALUE;
                }
                st->chest_led = cmd->u.led.a;
                st->chest_led_dirty = true;
                return VERNIE_PARSE_OK;
            }
            return VERNIE_PARSE_ERR_VALUE;

        case VERNIE_OP_SET_MODE:
            if (cmd->u.set_mode.mode_id > VERNIE_MODE_MAX) {
                return VERNIE_PARSE_ERR_VALUE;
            }
            if (st->safe_mode) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            st->mode_id = cmd->u.set_mode.mode_id;
            st->led_override = false;
            return VERNIE_PARSE_OK;

        case VERNIE_OP_SYNTH:
            if (cmd->u.synth.voice > 2u) {
                return VERNIE_PARSE_ERR_VALUE;
            }
            if (st->safe_mode) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            st->synth_cmd_pending = true;
            st->synth_voice = cmd->u.synth.voice;
            st->synth_preset_or_note = cmd->u.synth.preset_or_note;
            st->synth_dur_ms = cmd->u.synth.dur_ms;
            return VERNIE_PARSE_OK;

        case VERNIE_OP_MACRO_OP:
            if (cmd->u.macro_op.data_len > VERNIE_MACRO_CHUNK_MAX) {
                return VERNIE_PARSE_ERR_LENGTH;
            }
            if (st->safe_mode) {
                return VERNIE_PARSE_ERR_INTERLOCK;
            }
            st->macro_cmd_pending = true;
            st->macro_subcmd = cmd->u.macro_op.subcmd;
            st->macro_offset = cmd->u.macro_op.offset;
            st->macro_data_len = cmd->u.macro_op.data_len;
            if (cmd->u.macro_op.data_len > 0u) {
                memcpy(st->macro_data, cmd->u.macro_op.data, cmd->u.macro_op.data_len);
            }
            return VERNIE_PARSE_OK;

        default:
            return VERNIE_PARSE_ERR_OPCODE;
    }
}

bool vernie_control_tick(vernie_control_state_t *st, uint32_t now_ms) {
    if (!st || !st->drive_active) {
        return false;
    }
    // Wraparound-safe signed difference check.
    if ((int32_t)(now_ms - st->drive_deadline_ms) >= 0) {
        st->drive_active = false;
        st->drive_left = 0;
        st->drive_right = 0;
        return true;
    }
    return false;
}

void vernie_control_on_disconnect(vernie_control_state_t *st) {
    if (!st) {
        return;
    }
    st->drive_active = false;
    st->drive_left = 0;
    st->drive_right = 0;
    st->head_home_requested = false;
    st->head_cmd_pending = false;
    st->dart_armed = false;
    st->dart_fire_requested = false;
    st->synth_cmd_pending = false;
    st->macro_cmd_pending = false;
    st->led_override = false;
    if (st->mode_id == VERNIE_MODE_REMOTE) {
        st->mode_id = VERNIE_MODE_PET;
    }
}

size_t vernie_telemetry_encode(const vernie_telemetry_t *t, uint8_t out[VERNIE_TELEMETRY_BYTES]) {
    out[0] = (uint8_t)VERNIE_OP_TELEMETRY;
    write_u16_le(&out[1], t->battery_mv);
    out[3] = t->distance_pct;
    out[4] = t->color_id;
    out[5] = (uint8_t)t->pitch_deg;
    out[6] = (uint8_t)t->roll_deg;
    out[7] = t->flags;
    out[8] = t->mode_id;
    write_u16_le(&out[9], (uint16_t)t->enc_a);
    write_u16_le(&out[11], (uint16_t)t->enc_b);
    write_u16_le(&out[13], (uint16_t)t->head_deg);
    out[15] = (uint8_t)t->speed_a;
    out[16] = (uint8_t)t->speed_b;
    out[17] = t->seq;
    return VERNIE_TELEMETRY_BYTES;
}
