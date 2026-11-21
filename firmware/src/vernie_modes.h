// SPDX-License-Identifier: MIT
// Vernie OS Autonomous Brain State Machines (Modes 0..3 + Remote Mode 4).
//
// Modes:
//   0: Living Desk Pet      — idle curiosity, hand-near playful backup, pickup alarm reflex
//   1: Room Explorer        — forward cruise + fused (88007 proximity OR IMU/stall bump) scan & pivot
//   2: Desk Sentry          — red chest blink interleaved w/ SPEC1 sensing, 1.5s lock, armed-only dart
//   3: Color-Card Commander — 250 ms close-range (<=25%) debounced card commands (G/R/B/Y)
//   4: Remote Cockpit       — yields cleanly to Web Bluetooth commands

#ifndef VERNIE_MODES_H
#define VERNIE_MODES_H

#include <stdbool.h>
#include <stdint.h>

#include "vernie_protocol.h"
#include "vernie_synth.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VERNIE_COLOR_CARD_DIST_MAX_PCT  (25u)
#define VERNIE_COLOR_CARD_DEBOUNCE_MS   (250u)
#define VERNIE_SENTRY_LOCK_MS           (1500u)
#define VERNIE_SENTRY_TARGET_DIST_PCT   (45u)
#define VERNIE_EXPLORER_OBSTACLE_PCT    (40u)

// LEGO 88007 SPEC1 color IDs
#define VERNIE_LEGO_COLOR_BLUE          (3u)
#define VERNIE_LEGO_COLOR_GREEN         (5u)
#define VERNIE_LEGO_COLOR_YELLOW        (7u)
#define VERNIE_LEGO_COLOR_RED           (9u)

typedef enum {
    VERNIE_SUB_IDLE = 0,
    // Pet
    VERNIE_PET_BACKING,
    // Explorer
    VERNIE_EXP_CRUISE,
    VERNIE_EXP_BACKING,
    VERNIE_EXP_SCAN_LEFT,
    VERNIE_EXP_SCAN_RIGHT,
    VERNIE_EXP_PIVOT,
    // Sentry
    VERNIE_SEN_SCAN,
    VERNIE_SEN_ALERT,
    VERNIE_SEN_ENGAGE,
    VERNIE_SEN_COOLDOWN,
    // Color Cards
    VERNIE_CARD_WATCH,
    VERNIE_CARD_GREEN_GO,
    VERNIE_CARD_RED_SPIN,
    VERNIE_CARD_BLUE_DANCE,
    VERNIE_CARD_COOLDOWN,
} vernie_mode_substate_t;

typedef struct {
    uint8_t active_mode;
    vernie_mode_substate_t sub;
    uint32_t sub_enter_ms;
    uint32_t last_idle_act_ms;
    uint32_t last_alarm_ms;
    uint8_t idle_step;
    // Explorer scan memory
    uint8_t scan_dist_left;
    uint8_t scan_dist_right;
    bool pivot_left;
    bool tie_flip;
    // Sentry tracking & interleaved chest blink
    uint32_t target_seen_since_ms;
    bool target_present;
    bool sentry_led_on;
    bool sentry_fired_dart;
    uint32_t sentry_blink_ms;
    // Color-card 250 ms close-range debounce & dance beat edge
    uint8_t candidate_color;
    uint32_t candidate_since_ms;
    uint8_t last_dance_beat;
    // Pickup transition edge tracking
    bool was_picked_up;
} vernie_modes_t;

typedef struct {
    bool active;
    bool drive_active;
    int8_t drive_left;
    int8_t drive_right;
    bool head_cmd;
    int8_t head_angle_deg;
    uint8_t head_speed;
    bool want_dart_fire;
    bool synth_cmd;
    uint8_t synth_voice;
    uint8_t synth_preset_or_note;
    uint16_t synth_dur_ms;
    bool chest_led_cmd;
    uint8_t chest_led;
    bool hub_led_alert;
    uint8_t alert_r;
    uint8_t alert_g;
    uint8_t alert_b;
    bool want_macro_play;
} vernie_mode_output_t;

typedef struct {
    uint8_t mode_id;
    bool safe_mode;
    bool picked_up;
    bool bump;
    bool head_homed;
    bool dart_armed;
    bool sensor_ok;
    uint8_t distance_pct;
    uint8_t color_id;
    bool has_saved_macro;
} vernie_mode_input_t;

void vernie_modes_init(vernie_modes_t *m);

/**
 * Mark autonomous brain preempted (e.g., while a Flash Macro runs) so the active
 * mode cleanly re-enters its initial substate once control returns.
 */
void vernie_modes_notify_preempted(vernie_modes_t *m);

/**
 * Advance the active autonomous brain state machine by one cooperative 50 Hz tick.
 */
void vernie_modes_tick(
    vernie_modes_t *m,
    const vernie_mode_input_t *in,
    uint32_t now_ms,
    vernie_mode_output_t *out
);

#ifdef __cplusplus
}
#endif

#endif // VERNIE_MODES_H
