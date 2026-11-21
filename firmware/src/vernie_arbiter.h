// SPDX-License-Identifier: MIT
// Vernie OS Cooperative Tick Arbiter (Macro -> Autonomous Brain -> BLE Remote + Synth/Motor Lock).
// Pure C module shared directly by STM32 main.c and Layer 3 host integration tests.

#ifndef VERNIE_ARBITER_H
#define VERNIE_ARBITER_H

#include <stdbool.h>
#include <stdint.h>

#include "vernie_macro.h"
#include "vernie_modes.h"
#include "vernie_protocol.h"
#include "vernie_runtime.h"
#include "vernie_synth.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t prev_mode_id;
    bool macro_set_led_override;
} vernie_arbiter_t;

typedef struct {
    bool picked_up;
    bool bump;
    bool head_homed;
    bool head_fsm_busy;
    bool sensor_ok;
    uint8_t distance_pct;
    uint8_t color_id;
} vernie_arbiter_env_t;

typedef struct {
    vernie_control_state_t eff;
    bool alert_led_active;
    vernie_led_cmd_t alert_led;
} vernie_arbiter_out_t;

void vernie_arbiter_init(vernie_arbiter_t *arb);

/**
 * Execute one cooperative 50 Hz arbitration tick:
 *   - C5: Manual BLE DRIVE (including (0,0) STOP) stops running macros & takes over into Mode 4 Remote.
 *   - I5: Clears macro-installed Hub LED overrides when macro ends/stops; validates aligned saved macro.
 *   - C4: Updates synth busy flags from active drive/head/homing/dart state before dispatching synth
 *         commands (including 2-voice BLE chords) and advancing vernie_synth_tick().
 */
void vernie_arbiter_step(
    vernie_arbiter_t *arb,
    vernie_control_state_t *ctrl,
    vernie_macro_t *macro,
    vernie_modes_t *modes,
    vernie_synth_t *synth,
    const vernie_arbiter_env_t *env,
    uint32_t now_ms,
    vernie_arbiter_out_t *out
);

#ifdef __cplusplus
}
#endif

#endif // VERNIE_ARBITER_H
