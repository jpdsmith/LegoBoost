// SPDX-License-Identifier: MIT
// Vernie OS Autonomous Brain State Machines (Modes 0..3 + Remote Mode 4).

#include "vernie_modes.h"

#include <string.h>

static void enter_sub(vernie_modes_t *m, vernie_mode_substate_t next, uint32_t now_ms) {
    m->sub = next;
    m->sub_enter_ms = now_ms;
}

static bool is_valid_card_color(uint8_t col) {
    return col == VERNIE_LEGO_COLOR_BLUE ||
           col == VERNIE_LEGO_COLOR_GREEN ||
           col == VERNIE_LEGO_COLOR_YELLOW ||
           col == VERNIE_LEGO_COLOR_RED;
}

void vernie_modes_init(vernie_modes_t *m) {
    memset(m, 0, sizeof(*m));
    m->active_mode = 0xFFu; // Forces clean mode entry on first tick.
}

void vernie_modes_notify_preempted(vernie_modes_t *m) {
    if (!m) {
        return;
    }
    m->active_mode = 0xFFu;
    m->was_picked_up = false;
    m->sentry_fired_dart = false;
}

static void handle_pickup_reflex(vernie_modes_t *m, uint32_t now_ms, vernie_mode_output_t *out) {
    // Coasts tracks immediately, flashes red LED, shakes head, and squawks every 1200 ms.
    out->drive_active = false;
    out->drive_left = 0;
    out->drive_right = 0;

    out->hub_led_alert = true;
    bool flash_on = ((now_ms / 200u) & 1u) != 0u;
    out->alert_r = flash_on ? 255u : 20u;
    out->alert_g = 0u;
    out->alert_b = 0u;

    if (!m->was_picked_up || (uint32_t)(now_ms - m->last_alarm_ms) >= 1200u) {
        m->last_alarm_ms = now_ms;
        out->synth_cmd = true;
        // C4: tracks are coasted during pickup -> route alarm to TIM1 so head shake (TIM3) never kills it!
        out->synth_voice = VERNIE_SYNTH_VOICE_TRACKS;
        out->synth_preset_or_note = VERNIE_SFX_ALARM_SQUAWK;
    }

    // Frantic head shake every 250 ms while held in the air.
    if (!m->was_picked_up || (uint32_t)(now_ms - m->last_idle_act_ms) >= 250u) {
        m->last_idle_act_ms = now_ms;
        m->idle_step = (uint8_t)(m->idle_step ^ 1u);
        out->head_cmd = true;
        out->head_angle_deg = m->idle_step ? -25 : 25;
        out->head_speed = 80u;
    }
    m->was_picked_up = true;
}

static void tick_mode_pet(vernie_modes_t *m, const vernie_mode_input_t *in, uint32_t now_ms, vernie_mode_output_t *out) {
    if (m->sub == VERNIE_PET_BACKING) {
        if ((uint32_t)(now_ms - m->sub_enter_ms) < 400u) {
            out->drive_active = true;
            out->drive_left = -35;
            out->drive_right = -35;
            return;
        }
        enter_sub(m, VERNIE_SUB_IDLE, now_ms);
        out->head_cmd = true;
        out->head_angle_deg = 0;
        out->head_speed = 45u;
        return;
    }

    // Hand close to chest (<= 50%): playful backup + curious beep on free Head voice (no colliding head_cmd!).
    if (in->sensor_ok && in->distance_pct <= 50u && (uint32_t)(now_ms - m->sub_enter_ms) >= 1200u) {
        enter_sub(m, VERNIE_PET_BACKING, now_ms);
        out->drive_active = true;
        out->drive_left = -35;
        out->drive_right = -35;
        out->synth_cmd = true;
        out->synth_voice = VERNIE_SYNTH_VOICE_HEAD;
        out->synth_preset_or_note = VERNIE_SFX_CURIOUS_BEEP;
        return;
    }

    // Periodic curious head look & chirp every 4.5 seconds (tracks idle -> chirp on TIM1 while head looks!).
    if ((uint32_t)(now_ms - m->last_idle_act_ms) >= 4500u) {
        static const int8_t k_looks[4] = { -25, 0, 25, 0 };
        m->last_idle_act_ms = now_ms;
        int8_t angle = k_looks[m->idle_step & 3u];
        m->idle_step++;
        out->head_cmd = true;
        out->head_angle_deg = angle;
        out->head_speed = 40u;
        if ((m->idle_step & 1u) != 0u) {
            out->synth_cmd = true;
            out->synth_voice = VERNIE_SYNTH_VOICE_TRACKS;
            out->synth_preset_or_note = VERNIE_SFX_HAPPY_CHIRP;
        }
    }
}

static void tick_mode_explorer(vernie_modes_t *m, const vernie_mode_input_t *in, uint32_t now_ms, vernie_mode_output_t *out) {
    uint32_t elapsed = now_ms - m->sub_enter_ms;

    switch (m->sub) {
        case VERNIE_EXP_CRUISE: {
            bool obstacle = (in->sensor_ok && in->distance_pct <= VERNIE_EXPLORER_OBSTACLE_PCT) || in->bump;
            if (obstacle) {
                enter_sub(m, VERNIE_EXP_BACKING, now_ms);
                out->drive_active = true;
                out->drive_left = -40;
                out->drive_right = -40;
                out->synth_cmd = true;
                out->synth_voice = VERNIE_SYNTH_VOICE_HEAD;
                out->synth_preset_or_note = VERNIE_SFX_CURIOUS_BEEP;
                return;
            }
            out->drive_active = true;
            out->drive_left = 45;
            out->drive_right = 45;
            return;
        }

        case VERNIE_EXP_BACKING:
            if (elapsed < 450u) {
                out->drive_active = true;
                out->drive_left = -40;
                out->drive_right = -40;
                return;
            }
            // Initialize to 0 (blocked/unknown) so a missing reading never outscores a valid clear distance!
            m->scan_dist_left = 0u;
            m->scan_dist_right = 0u;
            enter_sub(m, VERNIE_EXP_SCAN_LEFT, now_ms);
            out->head_cmd = true;
            out->head_angle_deg = -35;
            out->head_speed = 60u;
            return;

        case VERNIE_EXP_SCAN_LEFT:
            if (elapsed >= 200u && in->sensor_ok && in->distance_pct <= 100u) {
                m->scan_dist_left = in->distance_pct;
            }
            if (elapsed >= 450u) {
                enter_sub(m, VERNIE_EXP_SCAN_RIGHT, now_ms);
                out->head_cmd = true;
                out->head_angle_deg = 35;
                out->head_speed = 60u;
            }
            return;

        case VERNIE_EXP_SCAN_RIGHT:
            if (elapsed >= 200u && in->sensor_ok && in->distance_pct <= 100u) {
                m->scan_dist_right = in->distance_pct;
            }
            if (elapsed >= 450u) {
                if (m->scan_dist_left == m->scan_dist_right) {
                    m->tie_flip = !m->tie_flip;
                    m->pivot_left = m->tie_flip;
                } else {
                    m->pivot_left = (m->scan_dist_left > m->scan_dist_right);
                }
                enter_sub(m, VERNIE_EXP_PIVOT, now_ms);
                out->head_cmd = true;
                out->head_angle_deg = 0;
                out->head_speed = 60u;
            }
            return;

        case VERNIE_EXP_PIVOT:
            if (elapsed < 650u) {
                out->drive_active = true;
                out->drive_left = m->pivot_left ? -45 : 45;
                out->drive_right = m->pivot_left ? 45 : -45;
                return;
            }
            enter_sub(m, VERNIE_EXP_CRUISE, now_ms);
            return;

        default:
            enter_sub(m, VERNIE_EXP_CRUISE, now_ms);
            return;
    }
}

static void tick_mode_sentry(vernie_modes_t *m, const vernie_mode_input_t *in, uint32_t now_ms, vernie_mode_output_t *out) {
    uint32_t elapsed = now_ms - m->sub_enter_ms;

    // Interleave 200 ms red chest LED pulse with 800 ms SPEC1 sensing window so sentry both glows & detects.
    if (m->sub == VERNIE_SEN_SCAN || m->sub == VERNIE_SEN_ALERT) {
        uint32_t blink_dt = now_ms - m->sentry_blink_ms;
        if (!m->sentry_led_on && blink_dt >= 800u && !m->target_present) {
            m->sentry_led_on = true;
            m->sentry_blink_ms = now_ms;
            out->chest_led_cmd = true;
            out->chest_led = VERNIE_CHEST_LED_RED;
        } else if (m->sentry_led_on && (blink_dt >= 200u || m->target_present)) {
            m->sentry_led_on = false;
            m->sentry_blink_ms = now_ms;
            out->chest_led_cmd = true;
            out->chest_led = VERNIE_CHEST_LED_OFF;
        }
    }

    bool target_close = in->sensor_ok && in->distance_pct <= VERNIE_SENTRY_TARGET_DIST_PCT;

    switch (m->sub) {
        case VERNIE_SEN_SCAN:
            if (target_close) {
                m->target_present = true;
                m->target_seen_since_ms = now_ms;
                enter_sub(m, VERNIE_SEN_ALERT, now_ms);
                out->synth_cmd = true;
                out->synth_voice = VERNIE_SYNTH_VOICE_TRACKS;
                out->synth_preset_or_note = VERNIE_SFX_WARNING_SIREN;
                return;
            }
            m->target_present = false;
            if ((uint32_t)(now_ms - m->last_idle_act_ms) >= 1200u) {
                m->last_idle_act_ms = now_ms;
                m->idle_step = (uint8_t)(m->idle_step ^ 1u);
                out->head_cmd = true;
                out->head_angle_deg = m->idle_step ? -30 : 30;
                out->head_speed = 35u;
            }
            return;

        case VERNIE_SEN_ALERT:
            if (!target_close) {
                m->target_present = false;
                enter_sub(m, VERNIE_SEN_SCAN, now_ms);
                return;
            }
            if ((uint32_t)(now_ms - m->target_seen_since_ms) >= VERNIE_SENTRY_LOCK_MS) {
                enter_sub(m, VERNIE_SEN_ENGAGE, now_ms);
                if (in->dart_armed && in->head_homed) {
                    m->sentry_fired_dart = true;
                    out->want_dart_fire = true;
                    out->synth_cmd = true;
                    out->synth_voice = VERNIE_SYNTH_VOICE_TRACKS;
                    out->synth_preset_or_note = VERNIE_SFX_LASER_ZAP;
                } else {
                    // Disarmed default: dramatic track wiggle + laser SFX on Head voice (no colliding head_cmd!).
                    m->sentry_fired_dart = false;
                    out->synth_cmd = true;
                    out->synth_voice = VERNIE_SYNTH_VOICE_HEAD;
                    out->synth_preset_or_note = VERNIE_SFX_LASER_ZAP;
                }
            }
            return;

        case VERNIE_SEN_ENGAGE:
            if (!m->sentry_fired_dart && elapsed < 400u) {
                out->drive_active = true;
                bool flip = ((elapsed / 100u) & 1u) != 0u;
                out->drive_left = flip ? 35 : -35;
                out->drive_right = flip ? -35 : 35;
                return;
            }
            if (elapsed >= 500u) {
                m->target_present = false;
                m->sentry_fired_dart = false;
                enter_sub(m, VERNIE_SEN_COOLDOWN, now_ms);
                out->head_cmd = true;
                out->head_angle_deg = 0;
                out->head_speed = 50u;
            }
            return;

        case VERNIE_SEN_COOLDOWN:
            if (elapsed >= 2000u) {
                enter_sub(m, VERNIE_SEN_SCAN, now_ms);
            }
            return;

        default:
            enter_sub(m, VERNIE_SEN_SCAN, now_ms);
            return;
    }
}

static void tick_mode_color_cards(vernie_modes_t *m, const vernie_mode_input_t *in, uint32_t now_ms, vernie_mode_output_t *out) {
    uint32_t elapsed = now_ms - m->sub_enter_ms;

    switch (m->sub) {
        case VERNIE_CARD_WATCH: {
            bool close_valid = in->sensor_ok &&
                               in->distance_pct <= VERNIE_COLOR_CARD_DIST_MAX_PCT &&
                               is_valid_card_color(in->color_id);
            if (!close_valid) {
                m->candidate_color = 0u;
                return;
            }
            if (in->color_id != m->candidate_color) {
                m->candidate_color = in->color_id;
                m->candidate_since_ms = now_ms;
                return;
            }
            if ((uint32_t)(now_ms - m->candidate_since_ms) < VERNIE_COLOR_CARD_DEBOUNCE_MS) {
                return;
            }

            // Confirmed debounced color card held close for >= 250 ms!
            uint8_t confirmed = m->candidate_color;
            m->candidate_color = 0u;
            if (confirmed == VERNIE_LEGO_COLOR_GREEN) {
                enter_sub(m, VERNIE_CARD_GREEN_GO, now_ms);
                out->synth_cmd = true;
                out->synth_voice = VERNIE_SYNTH_VOICE_HEAD;
                out->synth_preset_or_note = VERNIE_SFX_HAPPY_CHIRP;
            } else if (confirmed == VERNIE_LEGO_COLOR_RED) {
                enter_sub(m, VERNIE_CARD_RED_SPIN, now_ms);
                out->synth_cmd = true;
                out->synth_voice = VERNIE_SYNTH_VOICE_HEAD;
                out->synth_preset_or_note = VERNIE_SFX_ALARM_SQUAWK;
            } else if (confirmed == VERNIE_LEGO_COLOR_BLUE) {
                m->last_dance_beat = 0xFFu;
                enter_sub(m, VERNIE_CARD_BLUE_DANCE, now_ms);
                out->synth_cmd = true;
                out->synth_voice = VERNIE_SYNTH_VOICE_HEAD;
                out->synth_preset_or_note = VERNIE_SFX_VICTORY;
            } else if (confirmed == VERNIE_LEGO_COLOR_YELLOW) {
                enter_sub(m, VERNIE_CARD_COOLDOWN, now_ms);
                if (in->has_saved_macro) {
                    out->want_macro_play = true;
                } else {
                    out->synth_cmd = true;
                    out->synth_voice = VERNIE_SYNTH_VOICE_BOTH;
                    out->synth_preset_or_note = VERNIE_SFX_CURIOUS_BEEP;
                }
            }
            return;
        }

        case VERNIE_CARD_GREEN_GO:
            if (elapsed < 800u && !in->bump) {
                out->drive_active = true;
                out->drive_left = 50;
                out->drive_right = 50;
                return;
            }
            enter_sub(m, VERNIE_CARD_COOLDOWN, now_ms);
            return;

        case VERNIE_CARD_RED_SPIN:
            if (elapsed < 700u) {
                out->drive_active = true;
                out->drive_left = 55;
                out->drive_right = -55;
                return;
            }
            enter_sub(m, VERNIE_CARD_COOLDOWN, now_ms);
            return;

        case VERNIE_CARD_BLUE_DANCE:
            if (elapsed < 1600u) {
                uint8_t beat = (uint8_t)((elapsed / 400u) & 1u);
                out->drive_active = true;
                out->drive_left = beat ? 45 : -45;
                out->drive_right = beat ? -45 : 45;
                // Wait >= 650 ms so 620 ms Victory chiptune finishes on TIM3 before head nods on beat transitions!
                if (elapsed >= 650u && beat != m->last_dance_beat) {
                    m->last_dance_beat = beat;
                    out->head_cmd = true;
                    out->head_angle_deg = beat ? 30 : -30;
                    out->head_speed = 70u;
                }
                return;
            }
            out->head_cmd = true;
            out->head_angle_deg = 0;
            out->head_speed = 50u;
            enter_sub(m, VERNIE_CARD_COOLDOWN, now_ms);
            return;

        case VERNIE_CARD_COOLDOWN:
            if (elapsed >= 1500u) {
                enter_sub(m, VERNIE_CARD_WATCH, now_ms);
            }
            return;

        default:
            enter_sub(m, VERNIE_CARD_WATCH, now_ms);
            return;
    }
}

void vernie_modes_tick(
    vernie_modes_t *m,
    const vernie_mode_input_t *in,
    uint32_t now_ms,
    vernie_mode_output_t *out
) {
    memset(out, 0, sizeof(*out));
    if (!m || !in || in->safe_mode || in->mode_id >= VERNIE_MODE_REMOTE) {
        if (m) {
            if (m->sentry_led_on) {
                m->sentry_led_on = false;
                out->chest_led_cmd = true;
                out->chest_led = VERNIE_CHEST_LED_OFF;
            }
            m->active_mode = (in && !in->safe_mode) ? in->mode_id : 0xFFu;
            m->was_picked_up = false;
            m->sentry_fired_dart = false;
        }
        return;
    }

    out->active = true;

    // Detect mode transition -> reset substate cleanly & ensure 88007 is back in SPEC1 sensing mode.
    if (in->mode_id != m->active_mode) {
        m->active_mode = in->mode_id;
        m->last_idle_act_ms = now_ms;
        m->sentry_blink_ms = now_ms;
        m->sentry_led_on = false;
        m->sentry_fired_dart = false;
        m->target_present = false;
        m->candidate_color = 0u;
        m->was_picked_up = false;
        out->chest_led_cmd = true;
        out->chest_led = VERNIE_CHEST_LED_OFF;
        if (in->mode_id == VERNIE_MODE_EXPLORER) {
            enter_sub(m, VERNIE_EXP_CRUISE, now_ms);
        } else if (in->mode_id == VERNIE_MODE_SENTRY) {
            enter_sub(m, VERNIE_SEN_SCAN, now_ms);
        } else if (in->mode_id == VERNIE_MODE_COLOR_CARDS) {
            enter_sub(m, VERNIE_CARD_WATCH, now_ms);
        } else {
            enter_sub(m, VERNIE_SUB_IDLE, now_ms);
        }
    }

    // Universal safety reflex across ALL autonomous modes: picked up -> coast + alarm!
    if (in->picked_up) {
        handle_pickup_reflex(m, now_ms, out);
        return;
    }
    m->was_picked_up = false;

    switch (in->mode_id) {
        case VERNIE_MODE_PET:
            tick_mode_pet(m, in, now_ms, out);
            break;
        case VERNIE_MODE_EXPLORER:
            tick_mode_explorer(m, in, now_ms, out);
            break;
        case VERNIE_MODE_SENTRY:
            tick_mode_sentry(m, in, now_ms, out);
            break;
        case VERNIE_MODE_COLOR_CARDS:
            tick_mode_color_cards(m, in, now_ms, out);
            break;
        default:
            break;
    }
}
