// SPDX-License-Identifier: MIT
// Vernie OS Hardware Abstraction: Port C/D Auto-Detection, Non-Trigger Single-Direction
// Head Homing, Armed-Only Dart Launcher Trigger, Differential Drive & 88007 Sensor.

#include "vernie_hw.h"

#include <string.h>

#ifndef VERNIE_HOST_TEST
#include <lego/device.h>
#include <pbdrv/battery.h>
#include <pbio/battery.h>
#include <pbio/control.h>
#include <pbio/error.h>
#include <pbio/observer.h>
#include <pbio/port.h>
#include <pbio/port_lump.h>
#include <pbio/servo.h>
#endif

static int8_t clamp_i8(int32_t v, int8_t lo, int8_t hi) {
    if (v < (int32_t)lo) return lo;
    if (v > (int32_t)hi) return hi;
    return (int8_t)v;
}

void vernie_hw_resolve_ports(
    vernie_ext_dev_kind_t port_c,
    vernie_ext_dev_kind_t port_d,
    vernie_port_map_t *out
) {
    memset(out, 0, sizeof(*out));
    if (port_c == VERNIE_EXT_DEV_HEAD) {
        out->head_port = VERNIE_HEAD_PORT_C;
    } else if (port_d == VERNIE_EXT_DEV_HEAD) {
        out->head_port = VERNIE_HEAD_PORT_D;
    }

    if (port_c == VERNIE_EXT_DEV_SENSOR) {
        out->sensor_port = VERNIE_HEAD_PORT_C;
    } else if (port_d == VERNIE_EXT_DEV_SENSOR) {
        out->sensor_port = VERNIE_HEAD_PORT_D;
    }

    // TIM3 Voice 2 is safe ONLY when a head motor is confirmed and the sibling port is NOT
    // a second motor (88007 sensor uses PBIO_PORT_POWER_REQUIREMENTS_NONE on P1/P2).
    if (out->head_port == VERNIE_HEAD_PORT_C) {
        out->sibling_safe_for_tim3 = (port_d != VERNIE_EXT_DEV_HEAD);
    } else if (out->head_port == VERNIE_HEAD_PORT_D) {
        out->sibling_safe_for_tim3 = (port_c != VERNIE_EXT_DEV_HEAD);
    } else {
        out->sibling_safe_for_tim3 = false;
    }
}

void vernie_head_fsm_init(vernie_head_fsm_t *fsm, int16_t home_offset_deg) {
    memset(fsm, 0, sizeof(*fsm));
    fsm->state = VERNIE_HEAD_STATE_UNHOMED;
    fsm->home_offset_deg = home_offset_deg;
}

void vernie_head_fsm_step(
    vernie_head_fsm_t *fsm,
    bool head_present,
    bool safe_mode,
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
) {
    memset(act, 0, sizeof(*act));

    if (!head_present || safe_mode) {
        if (fsm->state != VERNIE_HEAD_STATE_UNHOMED && fsm->state != VERNIE_HEAD_STATE_READY) {
            fsm->state = fsm->homed ? VERNIE_HEAD_STATE_READY : VERNIE_HEAD_STATE_UNHOMED;
            act->kind = VERNIE_HEAD_ACT_COAST;
        }
        if (safe_mode) {
            act->clear_head_home_req = home_requested;
            act->clear_head_cmd_pending = angle_cmd_pending;
            act->clear_dart_fire_req = dart_fire_requested;
        }
        return;
    }

    int32_t move_speed = ((int32_t)(speed_pct < 10u ? 10u : (speed_pct > 100u ? 100u : speed_pct)) * 600) / 100;

    // Handle active multi-step states first.
    switch (fsm->state) {
        case VERNIE_HEAD_STATE_HOMING_SEEK: {
            bool timed_out = (uint32_t)(now_ms - fsm->state_enter_ms) >= VERNIE_HEAD_HOME_TIMEOUT_MS;
            if (motor_done || motor_stalled || timed_out) {
                fsm->state = VERNIE_HEAD_STATE_HOMING_BACKOFF;
                fsm->state_enter_ms = now_ms;
                act->kind = VERNIE_HEAD_ACT_RESET_AND_CENTER;
                act->target_deg = -fsm->home_offset_deg;
                act->speed_deg_s = 240;
            }
            return;
        }

        case VERNIE_HEAD_STATE_HOMING_BACKOFF: {
            bool timed_out = (uint32_t)(now_ms - fsm->state_enter_ms) >= VERNIE_HEAD_BACKOFF_TIMEOUT_MS;
            if (motor_done || timed_out) {
                fsm->state = VERNIE_HEAD_STATE_READY;
                fsm->homed = true;
                fsm->last_cmd_deg = 0;
            }
            return;
        }

        case VERNIE_HEAD_STATE_DART_FIRING: {
            bool timed_out = (uint32_t)(now_ms - fsm->state_enter_ms) >= 1200u;
            if (motor_done || motor_stalled || timed_out) {
                fsm->state = VERNIE_HEAD_STATE_DART_HOLD;
                fsm->state_enter_ms = now_ms;
            }
            return;
        }

        case VERNIE_HEAD_STATE_DART_HOLD: {
            if ((uint32_t)(now_ms - fsm->state_enter_ms) >= VERNIE_DART_HOLD_MS) {
                fsm->state = VERNIE_HEAD_STATE_DART_RETURNING;
                fsm->state_enter_ms = now_ms;
                act->kind = VERNIE_HEAD_ACT_RETURN_CENTER;
                act->target_deg = 0;
                act->speed_deg_s = 360;
            }
            return;
        }

        case VERNIE_HEAD_STATE_DART_RETURNING: {
            bool timed_out = (uint32_t)(now_ms - fsm->state_enter_ms) >= 1200u;
            if (motor_done || timed_out) {
                fsm->state = VERNIE_HEAD_STATE_READY;
                fsm->last_cmd_deg = 0;
                // Auto-disarm after firing so a second shot always requires explicit re-arm!
                act->clear_dart_armed = true;
                act->clear_dart_fire_req = true;
            }
            return;
        }

        case VERNIE_HEAD_STATE_UNHOMED:
        case VERNIE_HEAD_STATE_READY:
            break;
    }

    // Idle (UNHOMED or READY): check new requests.
    if (home_requested) {
        fsm->state = VERNIE_HEAD_STATE_HOMING_SEEK;
        fsm->homed = false;
        fsm->state_enter_ms = now_ms;
        act->kind = VERNIE_HEAD_ACT_SEEK_NON_TRIGGER;
        act->speed_deg_s = VERNIE_HEAD_HOME_SPEED_DEG_S; // Strictly negative (non-trigger)!
        act->duty_limit_pct = VERNIE_HEAD_HOME_DUTY_PCT; // <= 30% duty!
        act->clear_head_home_req = true;
        return;
    }

    if (dart_fire_requested) {
        if (dart_armed && fsm->homed) {
            fsm->state = VERNIE_HEAD_STATE_DART_FIRING;
            fsm->state_enter_ms = now_ms;
            act->kind = VERNIE_HEAD_ACT_FIRE_SWEEP;
            act->target_deg = VERNIE_DART_TRIGGER_DEG;
            act->speed_deg_s = VERNIE_DART_FIRE_SPEED_DEG_S;
            act->clear_dart_fire_req = true;
            return;
        }
        // Reject fire if disarmed or head is not yet homed!
        act->clear_dart_fire_req = true;
        return;
    }

    if (angle_cmd_pending) {
        act->clear_head_cmd_pending = true;
        int8_t clamped = clamp_i8(target_deg, VERNIE_HEAD_MIN_DEG, VERNIE_HEAD_MAX_DEG);
        fsm->last_cmd_deg = clamped;
        act->kind = VERNIE_HEAD_ACT_MOVE_TARGET;
        act->target_deg = clamped;
        act->speed_deg_s = move_speed;
    }
}

void vernie_sensor_decode_spec1(const int8_t raw[4], uint8_t *color_id_out, uint8_t *distance_pct_out) {
    // 88007 SPEC1 (mode 8): raw[0] = LEGO color ID (0..10 or -1=none), raw[1] = proximity 0..10
    uint8_t col = (raw[0] >= 0 && raw[0] <= 10) ? (uint8_t)raw[0] : 0u;
    int32_t prox = (int32_t)raw[1];
    if (prox < 0) prox = 0;
    if (prox > 10) prox = 10;
    uint8_t dist_pct = (uint8_t)(prox * 10);

    if (color_id_out) {
        *color_id_out = col;
    }
    if (distance_pct_out) {
        *distance_pct_out = dist_pct;
    }
}

// ============================================================================
// STM32F070RB + Pybricks lib/pbio Hardware Adapter
// ============================================================================
#ifndef VERNIE_HOST_TEST

static int16_t clamp_i16(int32_t v) {
    if (v < -32768) return -32768;
    if (v > 32767) return 32767;
    return (int16_t)v;
}

static pbio_servo_t *g_srv_a = NULL;
static pbio_servo_t *g_srv_b = NULL;
static pbio_servo_t *g_srv_head = NULL;
static pbio_port_lump_dev_t *g_lump_sensor = NULL;

void vernie_hw_coast_tracks(void) {
    if (g_srv_a) {
        (void)pbio_servo_stop(g_srv_a, PBIO_CONTROL_ON_COMPLETION_COAST);
    }
    if (g_srv_b) {
        (void)pbio_servo_stop(g_srv_b, PBIO_CONTROL_ON_COMPLETION_COAST);
    }
}

void vernie_hw_coast_external(void) {
    if (g_srv_head) {
        (void)pbio_servo_stop(g_srv_head, PBIO_CONTROL_ON_COMPLETION_COAST);
    }
}

void vernie_hw_coast_all(vernie_hw_t *hw) {
    vernie_hw_coast_tracks();
    vernie_hw_coast_external();
    if (hw) {
        hw->tracks_active = false;
        hw->last_drive_active = false;
        hw->last_drive_left = 0;
        hw->last_drive_right = 0;
    }
}

static vernie_ext_dev_kind_t probe_external_port(
    pbio_port_id_t port_id,
    pbio_servo_t **srv_out,
    pbio_port_lump_dev_t **lump_out
) {
    pbio_port_t *port = NULL;
    if (pbio_port_get_port(port_id, &port) != PBIO_SUCCESS) {
        return VERNIE_EXT_DEV_NONE;
    }

    lego_device_type_id_t motor_type = LEGO_DEVICE_TYPE_ID_INTERACTIVE_MOTOR;
    pbio_servo_t *srv = NULL;
    if (pbio_port_get_servo(port, &motor_type, &srv) == PBIO_SUCCESS) {
        if (srv_out) *srv_out = srv;
        return VERNIE_EXT_DEV_HEAD;
    }

    lego_device_type_id_t sensor_type = LEGO_DEVICE_TYPE_ID_COLOR_DIST_SENSOR;
    pbio_port_lump_dev_t *lump = NULL;
    if (pbio_port_get_lump_device(port, &sensor_type, &lump) == PBIO_SUCCESS) {
        if (lump_out) *lump_out = lump;
        return VERNIE_EXT_DEV_SENSOR;
    }

    return VERNIE_EXT_DEV_NONE;
}

static void probe_all_ports(vernie_hw_t *hw, vernie_synth_t *synth) {
    // Internal track motors A (CCW) & B (CW), 1:1 gear_ratio = 1000 millidegrees/deg, precision_profile = 0!
    if (!hw->drive_a_ready) {
        pbio_port_t *pa = NULL;
        lego_device_type_id_t tid = LEGO_DEVICE_TYPE_ID_MOVE_HUB_MOTOR;
        if (pbio_port_get_port(PBIO_PORT_ID_A, &pa) == PBIO_SUCCESS &&
            pbio_port_get_servo(pa, &tid, &g_srv_a) == PBIO_SUCCESS &&
            pbio_servo_setup(g_srv_a, tid, PBIO_DIRECTION_COUNTERCLOCKWISE, 1000, true, 0) == PBIO_SUCCESS) {
            hw->drive_a_ready = true;
        }
    }
    if (!hw->drive_b_ready) {
        pbio_port_t *pb = NULL;
        lego_device_type_id_t tid = LEGO_DEVICE_TYPE_ID_MOVE_HUB_MOTOR;
        if (pbio_port_get_port(PBIO_PORT_ID_B, &pb) == PBIO_SUCCESS &&
            pbio_port_get_servo(pb, &tid, &g_srv_b) == PBIO_SUCCESS &&
            pbio_servo_setup(g_srv_b, tid, PBIO_DIRECTION_CLOCKWISE, 1000, true, 0) == PBIO_SUCCESS) {
            hw->drive_b_ready = true;
        }
    }

    // External Ports C & D auto-detection.
    pbio_servo_t *srv_c = NULL, *srv_d = NULL;
    pbio_port_lump_dev_t *lump_c = NULL, *lump_d = NULL;
    vernie_ext_dev_kind_t kc = probe_external_port(PBIO_PORT_ID_C, &srv_c, &lump_c);
    vernie_ext_dev_kind_t kd = probe_external_port(PBIO_PORT_ID_D, &srv_d, &lump_d);

    vernie_port_map_t next_map;
    vernie_hw_resolve_ports(kc, kd, &next_map);

    if (next_map.head_port != hw->ports.head_port) {
        hw->head_ready = false;
        g_srv_head = (next_map.head_port == VERNIE_HEAD_PORT_C) ? srv_c :
                     (next_map.head_port == VERNIE_HEAD_PORT_D) ? srv_d : NULL;
        if (g_srv_head &&
            pbio_servo_setup(g_srv_head, LEGO_DEVICE_TYPE_ID_INTERACTIVE_MOTOR,
                             PBIO_DIRECTION_CLOCKWISE, 1000, true, 0) == PBIO_SUCCESS) {
            hw->head_ready = true;
        }
        vernie_head_fsm_init(&hw->head_fsm, hw->head_fsm.home_offset_deg);
    }

    if (next_map.sensor_port != hw->ports.sensor_port) {
        g_lump_sensor = (next_map.sensor_port == VERNIE_HEAD_PORT_C) ? lump_c :
                        (next_map.sensor_port == VERNIE_HEAD_PORT_D) ? lump_d : NULL;
        hw->sensor_mode_selected = false;
        hw->sensor.sensor_ok = (g_lump_sensor != NULL);
        hw->sensor.distance_pct = 0xFFu;
        hw->sensor.color_id = 0u;
    }

    hw->ports = next_map;
    if (synth) {
        vernie_synth_set_head_port(synth, hw->ports.head_port, hw->ports.sibling_safe_for_tim3);
    }
}

void vernie_hw_init(vernie_hw_t *hw, int16_t head_home_offset_deg) {
    memset(hw, 0, sizeof(*hw));
    g_srv_a = NULL;
    g_srv_b = NULL;
    g_srv_head = NULL;
    g_lump_sensor = NULL;
    hw->sensor.distance_pct = 0xFFu;
    vernie_head_fsm_init(&hw->head_fsm, head_home_offset_deg);
}

void vernie_hw_step(
    vernie_hw_t *hw,
    vernie_control_state_t *ctrl,
    vernie_synth_t *synth,
    bool picked_up,
    uint32_t now_ms,
    vernie_hw_snapshot_t *snap
) {
    memset(snap, 0, sizeof(*snap));
    snap->distance_pct = 0xFFu;

    (void)pbdrv_battery_get_voltage_now(&snap->battery_mv);

    // Probe ports every 250 ms (catches hot-plugging 88008/88007 or LUMP sync settling).
    if (!hw->drive_a_ready || !hw->drive_b_ready || (uint32_t)(now_ms - hw->last_probe_ms) >= 250u) {
        hw->last_probe_ms = now_ms;
        probe_all_ports(hw, synth);
    }

    // 1. Differential Drive (Ports A & B) with Safe Mode & Pickup safety cutout.
    bool want_drive = ctrl->drive_active && !ctrl->safe_mode && !picked_up;
    if (want_drive) {
        if (synth) {
            vernie_synth_yield_voice(synth, VERNIE_SYNTH_VOICE_TRACKS);
        }
        if (!hw->last_drive_active ||
            ctrl->drive_left != hw->last_drive_left ||
            ctrl->drive_right != hw->last_drive_right) {
            int32_t spd_a = ((int32_t)ctrl->drive_left * VERNIE_DRIVE_MAX_SPEED_DEG_S) / 100;
            int32_t spd_b = ((int32_t)ctrl->drive_right * VERNIE_DRIVE_MAX_SPEED_DEG_S) / 100;
            if (hw->drive_a_ready && g_srv_a) {
                (void)pbio_servo_run_forever(g_srv_a, spd_a);
            }
            if (hw->drive_b_ready && g_srv_b) {
                (void)pbio_servo_run_forever(g_srv_b, spd_b);
            }
            hw->last_drive_left = ctrl->drive_left;
            hw->last_drive_right = ctrl->drive_right;
            hw->last_drive_active = true;
        }
        hw->tracks_active = true;
    } else if (hw->last_drive_active) {
        vernie_hw_coast_tracks();
        hw->last_drive_active = false;
        hw->last_drive_left = 0;
        hw->last_drive_right = 0;
        hw->tracks_active = false;
    }

    // 2. Head Motor Homing, Positioning & Armed-Only Dart Launcher FSM.
    bool head_done = true;
    bool head_stalled = false;
    if (hw->head_ready && g_srv_head) {
        head_done = pbio_control_is_done(&g_srv_head->control);
        uint32_t stall_dur = 0u;
        (void)pbio_servo_is_stalled(g_srv_head, &head_stalled, &stall_dur);
    }

    vernie_head_action_t hact;
    vernie_head_fsm_step(
        &hw->head_fsm,
        hw->head_ready && g_srv_head != NULL,
        ctrl->safe_mode,
        head_done,
        head_stalled,
        ctrl->head_home_requested,
        ctrl->head_cmd_pending,
        ctrl->head_target_deg,
        ctrl->head_speed,
        ctrl->dart_armed,
        ctrl->dart_fire_requested,
        now_ms,
        &hact
    );

    if (hact.clear_head_home_req) ctrl->head_home_requested = false;
    if (hact.clear_head_cmd_pending) ctrl->head_cmd_pending = false;
    if (hact.clear_dart_fire_req) ctrl->dart_fire_requested = false;
    if (hact.clear_dart_armed) ctrl->dart_armed = false;

    if (hact.kind != VERNIE_HEAD_ACT_NONE && hw->head_ready && g_srv_head) {
        if (synth) {
            vernie_synth_yield_voice(synth, VERNIE_SYNTH_VOICE_HEAD);
        }
        switch (hact.kind) {
            case VERNIE_HEAD_ACT_COAST:
                (void)pbio_servo_stop(g_srv_head, PBIO_CONTROL_ON_COMPLETION_COAST);
                break;
            case VERNIE_HEAD_ACT_SEEK_NON_TRIGGER: {
                int32_t v_lim = pbio_battery_get_voltage_from_duty_pct(hact.duty_limit_pct);
                int32_t t_lim = pbio_observer_voltage_to_torque(g_srv_head->observer.model, v_lim);
                (void)pbio_servo_run_until_stalled(
                    g_srv_head, hact.speed_deg_s, t_lim, PBIO_CONTROL_ON_COMPLETION_COAST
                );
                break;
            }
            case VERNIE_HEAD_ACT_RESET_AND_CENTER:
                // Relative encoder: reset_to_abs MUST be false!
                (void)pbio_servo_reset_angle(g_srv_head, hact.target_deg, false);
                (void)pbio_servo_run_target(
                    g_srv_head, hact.speed_deg_s, 0, PBIO_CONTROL_ON_COMPLETION_HOLD
                );
                break;
            case VERNIE_HEAD_ACT_MOVE_TARGET:
            case VERNIE_HEAD_ACT_FIRE_SWEEP:
            case VERNIE_HEAD_ACT_RETURN_CENTER:
                (void)pbio_servo_run_target(
                    g_srv_head, hact.speed_deg_s, hact.target_deg, PBIO_CONTROL_ON_COMPLETION_HOLD
                );
                break;
            case VERNIE_HEAD_ACT_NONE:
                break;
        }
    }

    // 3. 88007 Color & Distance Sensor (SPEC1 mode 8 sensing <-> COL_O mode 5 chest LED).
    if (g_lump_sensor) {
        if (ctrl->chest_led_dirty) {
            if (ctrl->chest_led == VERNIE_CHEST_LED_OFF) {
                // Return to SPEC1 sensing mode when chest LED override is turned OFF.
                if (pbio_port_lump_set_mode(
                        g_lump_sensor, LEGO_DEVICE_MODE_PUP_COLOR_DISTANCE_SENSOR__SPEC1) == PBIO_SUCCESS) {
                    hw->sensor.chest_led_mode = false;
                    hw->sensor.active_chest_led = VERNIE_CHEST_LED_OFF;
                    hw->sensor_mode_selected = true;
                    ctrl->chest_led_dirty = false;
                }
            } else {
                int8_t col_byte = (int8_t)ctrl->chest_led;
                if (pbio_port_lump_set_mode_with_data(
                        g_lump_sensor,
                        LEGO_DEVICE_MODE_PUP_COLOR_DISTANCE_SENSOR__COL_O,
                        &col_byte,
                        1u) == PBIO_SUCCESS) {
                    hw->sensor.chest_led_mode = true;
                    hw->sensor.active_chest_led = ctrl->chest_led;
                    hw->sensor.distance_pct = 0xFFu;
                    hw->sensor.color_id = 0u;
                    hw->sensor_mode_selected = true;
                    ctrl->chest_led_dirty = false;
                }
            }
        } else if (!hw->sensor_mode_selected) {
            if (pbio_port_lump_set_mode(
                    g_lump_sensor, LEGO_DEVICE_MODE_PUP_COLOR_DISTANCE_SENSOR__SPEC1) == PBIO_SUCCESS) {
                hw->sensor_mode_selected = true;
                hw->sensor.chest_led_mode = false;
            }
        } else if (!hw->sensor.chest_led_mode) {
            void *lump_data = NULL;
            if (pbio_port_lump_get_data(
                    g_lump_sensor, LEGO_DEVICE_MODE_PUP_COLOR_DISTANCE_SENSOR__SPEC1, &lump_data) == PBIO_SUCCESS &&
                lump_data != NULL) {
                vernie_sensor_decode_spec1(
                    (const int8_t *)lump_data, &hw->sensor.color_id, &hw->sensor.distance_pct
                );
                hw->sensor.sensor_ok = true;
            }
        }
    }

    // 4. Populate live snapshot for IMU fusion & 10 Hz BLE telemetry.
    int32_t ang_a = 0, spd_a_deg = 0, ang_b = 0, spd_b_deg = 0, ang_h = 0, spd_h_deg = 0;
    bool stalled_a = false, stalled_b = false;
    uint32_t stall_dur = 0u;

    if (hw->drive_a_ready && g_srv_a) {
        (void)pbio_servo_get_state_user(g_srv_a, &ang_a, &spd_a_deg);
        (void)pbio_servo_is_stalled(g_srv_a, &stalled_a, &stall_dur);
    }
    if (hw->drive_b_ready && g_srv_b) {
        (void)pbio_servo_get_state_user(g_srv_b, &ang_b, &spd_b_deg);
        (void)pbio_servo_is_stalled(g_srv_b, &stalled_b, &stall_dur);
    }
    if (hw->head_ready && g_srv_head) {
        (void)pbio_servo_get_state_user(g_srv_head, &ang_h, &spd_h_deg);
    }

    snap->enc_a = clamp_i16(ang_a);
    snap->enc_b = clamp_i16(ang_b);
    snap->head_deg = clamp_i16(ang_h);
    snap->speed_a = clamp_i8((spd_a_deg * 100) / VERNIE_DRIVE_MAX_SPEED_DEG_S, -100, 100);
    snap->speed_b = clamp_i8((spd_b_deg * 100) / VERNIE_DRIVE_MAX_SPEED_DEG_S, -100, 100);
    snap->distance_pct = hw->sensor.distance_pct;
    snap->color_id = hw->sensor.color_id;
    snap->sensor_ok = hw->sensor.sensor_ok;
    snap->head_homed = hw->head_fsm.homed;
    snap->tracks_moving = hw->tracks_active || (spd_a_deg > 30 || spd_a_deg < -30 || spd_b_deg > 30 || spd_b_deg < -30);
    snap->tracks_stalled = hw->tracks_active && (stalled_a || stalled_b);
    snap->motors_active = hw->tracks_active ||
                          (hw->head_fsm.state != VERNIE_HEAD_STATE_UNHOMED &&
                           hw->head_fsm.state != VERNIE_HEAD_STATE_READY);
}
#endif // !VERNIE_HOST_TEST
