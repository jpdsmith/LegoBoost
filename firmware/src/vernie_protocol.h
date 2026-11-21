// SPDX-License-Identifier: MIT
// Vernie OS Layer-2 Binary BLE Protocol (runs inside Pybricks AppData).
// Verified against BlueNRG-MS ATT_MTU=23:
//   - RX max AppData payload = 17 bytes (20B ATT - 3B WRITE_APP_DATA header)
//   - TX max AppData payload = 19 bytes (20B ATT - 1B EVENT_WRITE_APP_DATA header)

#ifndef _VERNIE_PROTOCOL_H_
#define _VERNIE_PROTOCOL_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Transport payload ceilings enforced by BlueNRG-MS ATT_MTU=23.
#define VERNIE_RX_MAX_BYTES        (17u)
#define VERNIE_TX_MAX_BYTES        (19u)
#define VERNIE_TELEMETRY_BYTES     (18u)
#define VERNIE_MACRO_CHUNK_MAX     (14u)

// Safety bounds matching tools/protocol_schema.json.
#define VERNIE_DRIVE_TIMEOUT_MIN_MS (100u)
#define VERNIE_DRIVE_TIMEOUT_MAX_MS (1000u)
#define VERNIE_HEAD_MIN_DEG         (-40)
#define VERNIE_HEAD_MAX_DEG         (35)
#define VERNIE_HEAD_HOME_SENTINEL   (127)
#define VERNIE_DART_MAGIC           (0xA5u)
#define VERNIE_MODE_MAX             (4u)

typedef enum {
    VERNIE_OP_DRIVE     = 0x01,
    VERNIE_OP_HEAD      = 0x02,
    VERNIE_OP_DART      = 0x03,
    VERNIE_OP_SYNTH     = 0x04,
    VERNIE_OP_LED       = 0x05,
    VERNIE_OP_SET_MODE  = 0x06,
    VERNIE_OP_MACRO_OP  = 0x07,
    VERNIE_OP_TELEMETRY = 0x80,
} vernie_opcode_t;

typedef enum {
    VERNIE_DART_DISARM = 0,
    VERNIE_DART_ARM    = 1,
    VERNIE_DART_FIRE   = 2,
} vernie_dart_subcmd_t;

typedef enum {
    VERNIE_LED_TARGET_HUB_RGB      = 0,
    VERNIE_LED_TARGET_CHEST_4STATE = 1,
} vernie_led_target_t;

typedef enum {
    VERNIE_CHEST_LED_OFF   = 0,
    VERNIE_CHEST_LED_BLUE  = 3,
    VERNIE_CHEST_LED_GREEN = 5,
    VERNIE_CHEST_LED_RED   = 9,
} vernie_chest_led_state_t;

typedef enum {
    VERNIE_MODE_PET         = 0,
    VERNIE_MODE_EXPLORER    = 1,
    VERNIE_MODE_SENTRY      = 2,
    VERNIE_MODE_COLOR_CARDS = 3,
    VERNIE_MODE_REMOTE      = 4,
} vernie_mode_t;

typedef enum {
    VERNIE_FLAG_PICKED_UP    = (1u << 0),
    VERNIE_FLAG_BUMP         = (1u << 1),
    VERNIE_FLAG_TAP          = (1u << 2),
    VERNIE_FLAG_DART_ARMED   = (1u << 3),
    VERNIE_FLAG_HEAD_HOMED   = (1u << 4),
    VERNIE_FLAG_SENSOR_OK    = (1u << 5),
    VERNIE_FLAG_SAFE_MODE    = (1u << 6),
    VERNIE_FLAG_SYNTH_ACTIVE = (1u << 7),
} vernie_telemetry_flag_t;

typedef enum {
    VERNIE_PARSE_OK             = 0,
    VERNIE_PARSE_ERR_LENGTH     = -1,
    VERNIE_PARSE_ERR_OPCODE     = -2,
    VERNIE_PARSE_ERR_VALUE      = -3,
    VERNIE_PARSE_ERR_INTERLOCK  = -4,
} vernie_parse_result_t;

typedef struct {
    vernie_opcode_t opcode;
    union {
        struct {
            int8_t left;
            int8_t right;
            uint16_t timeout_ms;
        } drive;
        struct {
            int8_t angle_deg;
            uint8_t speed;
            bool is_home;
        } head;
        struct {
            uint8_t subcmd;
            uint8_t magic;
        } dart;
        struct {
            uint8_t voice;
            uint8_t preset_or_note;
            uint16_t dur_ms;
        } synth;
        struct {
            uint8_t target;
            uint8_t a;
            uint8_t b;
            uint8_t c;
        } led;
        struct {
            uint8_t mode_id;
        } set_mode;
        struct {
            uint8_t subcmd;
            uint8_t offset;
            uint8_t data_len;
            uint8_t data[VERNIE_MACRO_CHUNK_MAX];
        } macro_op;
    } u;
} vernie_cmd_t;

typedef struct {
    uint16_t battery_mv;
    uint8_t distance_pct;
    uint8_t color_id;
    int8_t pitch_deg;
    int8_t roll_deg;
    uint8_t flags;
    uint8_t mode_id;
    int16_t enc_a;
    int16_t enc_b;
    int16_t head_deg;
    int8_t speed_a;
    int8_t speed_b;
    uint8_t seq;
} vernie_telemetry_t;

/**
 * Pure control/safety state tracked across BLE packets & clock ticks.
 */
typedef struct {
    bool safe_mode;
    bool dart_armed;
    bool drive_active;
    bool manual_drive_received;
    int8_t drive_left;
    int8_t drive_right;
    uint32_t drive_deadline_ms;
    bool led_override;
    uint8_t hub_r;
    uint8_t hub_g;
    uint8_t hub_b;
    uint8_t chest_led;
    bool chest_led_dirty;
    uint8_t mode_id;
    bool dart_fire_requested;
    bool head_home_requested;
    bool head_cmd_pending;
    int8_t head_target_deg;
    uint8_t head_speed;
    bool synth_cmd_pending;
    uint8_t synth_voice;
    uint8_t synth_preset_or_note;
    uint16_t synth_dur_ms;
    uint8_t synth_q_count;
    uint8_t synth_q_voice[2];
    uint8_t synth_q_note[2];
    uint16_t synth_q_dur[2];
    bool macro_cmd_pending;
    uint8_t macro_subcmd;
    uint8_t macro_offset;
    uint8_t macro_data_len;
    uint8_t macro_data[VERNIE_MACRO_CHUNK_MAX];
} vernie_control_state_t;

void vernie_control_init(vernie_control_state_t *st, bool safe_mode);

/**
 * Decodes an incoming AppData command payload (1..17 bytes).
 */
vernie_parse_result_t vernie_cmd_decode(const uint8_t *buf, size_t len, vernie_cmd_t *out);

/**
 * Applies a decoded command to control state with safety interlocks enforced.
 */
vernie_parse_result_t vernie_control_apply(vernie_control_state_t *st, const vernie_cmd_t *cmd, uint32_t now_ms);

/**
 * Enforces dead-man drive failsafe timeout. Returns true if drive timed out and stopped.
 */
bool vernie_control_tick(vernie_control_state_t *st, uint32_t now_ms);

/**
 * Resets transient remote-control state on BLE disconnect (coasts drive, disarms dart).
 */
void vernie_control_on_disconnect(vernie_control_state_t *st);

/**
 * Encodes a 18-byte little-endian TELEMETRY frame (<= 19B TX MTU ceiling).
 */
size_t vernie_telemetry_encode(const vernie_telemetry_t *t, uint8_t out[VERNIE_TELEMETRY_BYTES]);

#endif // _VERNIE_PROTOCOL_H_
