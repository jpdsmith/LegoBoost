// SPDX-License-Identifier: MIT
// Vernie OS Cooperative Tick Arbiter (Macro -> Autonomous Brain -> BLE Remote + Synth/Motor Lock).

#include "vernie_arbiter.h"

#include <string.h>

void vernie_arbiter_init(vernie_arbiter_t *arb) {
    memset(arb, 0, sizeof(*arb));
    arb->prev_mode_id = 0xFFu;
}

void vernie_arbiter_step(
    vernie_arbiter_t *arb,
    vernie_control_state_t *ctrl,
    vernie_macro_t *macro,
    vernie_modes_t *modes,
    vernie_synth_t *synth,
    const vernie_arbiter_env_t *env,
    uint32_t now_ms,
    vernie_arbiter_out_t *out
) {
    memset(out, 0, sizeof(*out));
    if (!arb || !ctrl || !macro || !modes || !synth || !env) {
        return;
    }

    // Any mode change (button, double-tap, or BLE 0x06 SET_MODE) stops an active macro.
    if (arb->prev_mode_id != 0xFFu && ctrl->mode_id != arb->prev_mode_id) {
        vernie_macro_stop(macro);
    }

    // C5: ANY manual BLE DRIVE command — including emergency STOP (0, 0) — immediately
    // stops a running macro AND switches autonomous Modes 0..3 into Mode 4 Remote Cockpit!
    if (ctrl->manual_drive_received) {
        ctrl->manual_drive_received = false;
        vernie_macro_stop(macro);
        if (!ctrl->safe_mode && ctrl->mode_id != VERNIE_MODE_REMOTE) {
            ctrl->mode_id = VERNIE_MODE_REMOTE;
            ctrl->led_override = false;
        }
    }
    arb->prev_mode_id = ctrl->mode_id;

    out->eff = *ctrl;

    bool pending_auto_synth = false;
    uint8_t auto_synth_voice = 0u;
    uint8_t auto_synth_note = 0u;
    uint16_t auto_synth_dur = 0u;

    if (macro->playing) {
        vernie_modes_notify_preempted(modes);
        vernie_macro_output_t mout;
        vernie_macro_tick(macro, ctrl->safe_mode, env->picked_up, now_ms, &mout);
        if (mout.active) {
            out->eff.drive_active = mout.drive_active;
            out->eff.drive_left = mout.drive_left;
            out->eff.drive_right = mout.drive_right;
            if (mout.head_cmd) {
                out->eff.head_cmd_pending = true;
                out->eff.head_target_deg = mout.head_angle_deg;
                out->eff.head_speed = mout.head_speed;
            }
            if (mout.synth_cmd) {
                pending_auto_synth = true;
                auto_synth_voice = mout.synth_voice;
                auto_synth_note = mout.synth_preset_or_note;
                auto_synth_dur = mout.synth_dur_ms;
            }
            if (mout.hub_led_cmd) {
                ctrl->led_override = true;
                ctrl->hub_r = mout.hub_r;
                ctrl->hub_g = mout.hub_g;
                ctrl->hub_b = mout.hub_b;
                arb->macro_set_led_override = true;
            }
            if (mout.chest_led_cmd) {
                ctrl->chest_led = mout.chest_led;
                ctrl->chest_led_dirty = true;
                out->eff.chest_led = mout.chest_led;
                out->eff.chest_led_dirty = true;
            }
        }
    } else {
        // I5: Restore normal mode Hub LED once a macro stops or finishes.
        if (arb->macro_set_led_override) {
            arb->macro_set_led_override = false;
            ctrl->led_override = false;
        }

        vernie_mode_input_t min = {
            .mode_id = ctrl->mode_id,
            .safe_mode = ctrl->safe_mode,
            .picked_up = env->picked_up,
            .bump = env->bump,
            .head_homed = env->head_homed,
            .dart_armed = ctrl->dart_armed,
            .sensor_ok = env->sensor_ok,
            .distance_pct = env->distance_pct,
            .color_id = env->color_id,
            .has_saved_macro = (macro->len >= VERNIE_MACRO_STEP_BYTES &&
                                (macro->len % VERNIE_MACRO_STEP_BYTES) == 0u),
        };
        vernie_mode_output_t aout;
        vernie_modes_tick(modes, &min, now_ms, &aout);

        if (aout.chest_led_cmd) {
            ctrl->chest_led = aout.chest_led;
            ctrl->chest_led_dirty = true;
            out->eff.chest_led = aout.chest_led;
            out->eff.chest_led_dirty = true;
        }

        if (aout.active) {
            out->eff.drive_active = aout.drive_active;
            out->eff.drive_left = aout.drive_left;
            out->eff.drive_right = aout.drive_right;
            if (aout.head_cmd) {
                out->eff.head_cmd_pending = true;
                out->eff.head_target_deg = aout.head_angle_deg;
                out->eff.head_speed = aout.head_speed;
            }
            if (aout.want_dart_fire) {
                out->eff.dart_fire_requested = true;
            }
            if (aout.synth_cmd) {
                pending_auto_synth = true;
                auto_synth_voice = aout.synth_voice;
                auto_synth_note = aout.synth_preset_or_note;
                auto_synth_dur = aout.synth_dur_ms;
            }
            if (aout.hub_led_alert) {
                out->alert_led_active = true;
                out->alert_led.kind = VERNIE_LED_KIND_RGB;
                out->alert_led.a = aout.alert_r;
                out->alert_led.b = aout.alert_g;
                out->alert_led.c = aout.alert_b;
            }
            if (aout.want_macro_play) {
                (void)vernie_macro_start(macro, now_ms);
            }
        }
    }

    // C4: Update synth busy locks BEFORE dispatching any BLE/macro/mode synth commands so
    // synth NEVER hijacks active drive tracks, head homing, dart sweep, or same-tick head moves!
    bool tracks_busy = out->eff.drive_active && !ctrl->safe_mode && !env->picked_up;
    bool head_busy = env->head_fsm_busy ||
                     out->eff.head_home_requested ||
                     out->eff.dart_fire_requested ||
                     (out->eff.head_cmd_pending && env->head_homed);
    vernie_synth_set_busy(synth, tracks_busy, head_busy);

    // Drain up to 2 rapid BLE synth commands (supports simultaneous 2-voice chords!).
    for (uint8_t i = 0u; i < ctrl->synth_q_count && i < 2u; i++) {
        (void)vernie_synth_command(
            synth, ctrl->synth_q_voice[i], ctrl->synth_q_note[i], ctrl->synth_q_dur[i], now_ms
        );
    }
    ctrl->synth_cmd_pending = false;
    ctrl->synth_q_count = 0u;

    if (pending_auto_synth) {
        (void)vernie_synth_command(
            synth, auto_synth_voice, auto_synth_note, auto_synth_dur, now_ms
        );
    }

    vernie_synth_tick(synth, now_ms);
}
