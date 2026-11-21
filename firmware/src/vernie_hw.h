// SPDX-License-Identifier: MIT
// Vernie OS Hardware Abstraction: Port C/D Auto-Detection, Non-Trigger Single-Direction
// Head Homing, Armed-Only Dart Launcher Trigger, Differential Drive & 88007 Sensor.

#ifndef VERNIE_HW_H
#define VERNIE_HW_H

#include <stdbool.h>
#include <stdint.h>

#include "vernie_protocol.h"
#include "vernie_synth.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VERNIE_HEAD_HOME_SPEED_DEG_S   (-180) // Strictly negative (non-trigger) direction!
#define VERNIE_HEAD_HOME_DUTY_PCT      (28)   // Low torque <= 30% so gears never slip
#define VERNIE_HEAD_HOME_TIMEOUT_MS    (2500u)
#define VERNIE_HEAD_BACKOFF_TIMEOUT_MS (1500u)
#define VERNIE_DART_TRIGGER_DEG        (70)   // Shoulder trigger detent (only reachable when armed!)
#define VERNIE_DART_FIRE_SPEED_DEG_S   (600)
#define VERNIE_DART_HOLD_MS            (200u)
#define VERNIE_DRIVE_MAX_SPEED_DEG_S   (1200)

typedef enum {
    VERNIE_EXT_DEV_NONE   = 0,
    VERNIE_EXT_DEV_HEAD   = 1, // LEGO 88008 Interactive Motor
    VERNIE_EXT_DEV_SENSOR = 2, // LEGO 88007 Color & Distance Sensor
} vernie_ext_dev_kind_t;

typedef enum {
    VERNIE_HEAD_STATE_UNHOMED        = 0,
    VERNIE_HEAD_STATE_HOMING_SEEK    = 1,
    VERNIE_HEAD_STATE_HOMING_BACKOFF = 2,
    VERNIE_HEAD_STATE_READY          = 3,
    VERNIE_HEAD_STATE_DART_FIRING    = 4,
    VERNIE_HEAD_STATE_DART_HOLD      = 5,
    VERNIE_HEAD_STATE_DART_RETURNING = 6,
} vernie_head_state_t;

typedef struct {
    vernie_head_port_t head_port;
    vernie_head_port_t sensor_port; // 0=none, 1=C, 2=D
    bool sibling_safe_for_tim3;
} vernie_port_map_t;

/**
 * Pure Port C/D auto-detection resolver (unit-testable across all port combinations).
 */
void vernie_hw_resolve_ports(
    vernie_ext_dev_kind_t port_c,
    vernie_ext_dev_kind_t port_d,
    vernie_port_map_t *out
);

/**
 * Pure head homing & dart safety FSM state + action output (unit-testable under ASan/UBSan).
 */
typedef struct {
    vernie_head_state_t state;
    bool homed;
    int16_t home_offset_deg;
    uint32_t state_enter_ms;
    int8_t last_cmd_deg;
} vernie_head_fsm_t;

typedef enum {
    VERNIE_HEAD_ACT_NONE = 0,
    VERNIE_HEAD_ACT_COAST,
    VERNIE_HEAD_ACT_SEEK_NON_TRIGGER, // run_until_stalled(VERNIE_HEAD_HOME_SPEED_DEG_S, <=30% duty)
    VERNIE_HEAD_ACT_RESET_AND_CENTER, // reset_angle(-home_offset_deg, false) + run_target(0)
    VERNIE_HEAD_ACT_MOVE_TARGET,      // run_target(clamped [-40, +35])
    VERNIE_HEAD_ACT_FIRE_SWEEP,       // run_target(+70) ONLY when armed!
    VERNIE_HEAD_ACT_RETURN_CENTER,    // run_target(0) after dart fire
} vernie_head_action_kind_t;

typedef struct {
    vernie_head_action_kind_t kind;
    int32_t speed_deg_s;
    int32_t target_deg;
    int32_t duty_limit_pct;
    bool clear_dart_armed;
    bool clear_dart_fire_req;
    bool clear_head_home_req;
    bool clear_head_cmd_pending;
} vernie_head_action_t;

void vernie_head_fsm_init(vernie_head_fsm_t *fsm, int16_t home_offset_deg);

static inline bool vernie_head_fsm_is_busy(const vernie_head_fsm_t *fsm) {
    return fsm && fsm->state != VERNIE_HEAD_STATE_UNHOMED && fsm->state != VERNIE_HEAD_STATE_READY;
}

/**
 * Advance head homing / target positioning / armed dart fire FSM.
 * Enforces:
 *   - MOVE_TARGET strictly gated on fsm->homed (prevents unhomed relative offset hitting dart trigger)
 *   - Premature dart/home/angle requests cleared during active multi-step sequences (no latching!)
 *   - Picked-up aborts DART_FIRING and rejects new dart fires
 */
void vernie_head_fsm_step(
    vernie_head_fsm_t *fsm,
    bool head_present,
    bool safe_mode,
    bool picked_up,
    bool motor_done,
    bool motor_stalled,
    bool home_requested,
    bool angle_cmd_pending,
    int8_t target_deg,
    uint8_t speed_pct,
    bool dart_armed,
    bool dart_fire_requested,
    uint32_t now_ms,
    vernie_head_action_t *act
);

/**
 * Pure 88007 Color & Distance sensor data decoding from SPEC1 (mode 8) 4-byte payload.
 */
typedef struct {
    bool sensor_ok;
    bool chest_led_mode;
    uint8_t active_chest_led;
    uint8_t distance_pct; // 0..100, or 255 if unavailable/LED mode
    uint8_t color_id;
} vernie_sensor_state_t;

bool vernie_hw_tracks_allowed(const vernie_control_state_t *ctrl, bool picked_up);
void vernie_sensor_decode_spec1(const int8_t raw[4], uint8_t *color_id_out, uint8_t *distance_pct_out);

/**
 * Combined hardware snapshot reported to vernie_runtime_tick() for 10 Hz BLE telemetry.
 */
typedef struct {
    uint16_t battery_mv;
    uint8_t distance_pct;
    uint8_t color_id;
    int8_t pitch_deg;
    int8_t roll_deg;
    int16_t enc_a;
    int16_t enc_b;
    int16_t head_deg;
    int8_t speed_a;
    int8_t speed_b;
    bool picked_up;
    bool bump;
    bool tap;
    bool head_homed;
    bool sensor_ok;
    bool synth_active;
    bool motors_active;
    bool tracks_moving;
    bool tracks_stalled;
} vernie_hw_snapshot_t;

#ifndef VERNIE_HOST_TEST
typedef struct {
    vernie_port_map_t ports;
    vernie_ext_dev_kind_t last_port_c;
    vernie_ext_dev_kind_t last_port_d;
    vernie_head_fsm_t head_fsm;
    vernie_sensor_state_t sensor;
    bool drive_a_ready;
    bool drive_b_ready;
    bool head_ready;
    bool sensor_mode_selected;
    bool tracks_active;
    uint32_t last_probe_ms;
    int8_t last_drive_left;
    int8_t last_drive_right;
    bool last_drive_active;
} vernie_hw_t;

void vernie_hw_init(vernie_hw_t *hw, int16_t head_home_offset_deg);
void vernie_hw_coast_tracks(void);
void vernie_hw_coast_external(void);
void vernie_hw_coast_all(vernie_hw_t *hw);

/**
 * Poll ports/encoders/88007 sensor and execute drive, head, dart, and chest LED commands.
 */
void vernie_hw_step(
    vernie_hw_t *hw,
    vernie_control_state_t *ctrl,
    vernie_synth_t *synth,
    bool picked_up,
    uint32_t now_ms,
    vernie_hw_snapshot_t *snap
);
#endif // !VERNIE_HOST_TEST

#ifdef __cplusplus
}
#endif

#endif // VERNIE_HW_H
