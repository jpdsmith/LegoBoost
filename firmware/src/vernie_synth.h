// SPDX-License-Identifier: MIT
// Vernie OS 2-Voice Symmetrical Bipolar Singing-Motor Synthesizer (TIM1 & TIM3).
//
// Physics & Safety Invariants:
//   - 3-level bipolar PWM (pin1 Mode 1, pin2 Mode 2, coast dead-band >= 70% ARR) -> 0.0 V DC net creep!
//   - Duty per half-cycle strictly capped <= 15% ARR.
//   - Thermal watchdog: continuous active tone hard-capped at 3000 ms with 500 ms mandatory cooldown.
//   - Timer arbitration: coasts paired pbio ports before touching TIM1/TIM3, and restores exact
//     pbio 12 kHz inverted PWM register state immediately on yield or stop.

#ifndef VERNIE_SYNTH_H
#define VERNIE_SYNTH_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VERNIE_SYNTH_CLK_HZ           (48000000u)
#define VERNIE_SYNTH_FREQ_MIN_HZ      (110u)
#define VERNIE_SYNTH_FREQ_MAX_HZ      (4000u)
#define VERNIE_SYNTH_MAX_DUTY_PCT     (15u)
#define VERNIE_SYNTH_THERMAL_MAX_MS   (3000u)
#define VERNIE_SYNTH_COOLDOWN_MS      (500u)

// Preset IDs (< 32 are presets when passed in 0x04 SYNTH; >= 32 are MIDI note numbers).
typedef enum {
    VERNIE_SFX_STOP          = 0,
    VERNIE_SFX_BOOT_CHIME    = 1,
    VERNIE_SFX_HAPPY_CHIRP   = 2,
    VERNIE_SFX_CURIOUS_BEEP  = 3,
    VERNIE_SFX_ALARM_SQUAWK  = 4,
    VERNIE_SFX_WARNING_SIREN = 5,
    VERNIE_SFX_LASER_ZAP     = 6,
    VERNIE_SFX_VICTORY       = 7,
    VERNIE_SFX_MODE_TICK     = 8,
    VERNIE_SFX_COUNT         = 9,
} vernie_sfx_preset_t;

typedef enum {
    VERNIE_SYNTH_VOICE_BOTH   = 0,
    VERNIE_SYNTH_VOICE_TRACKS = 1, // TIM1 (Port A coil, Ports A & B coasted)
    VERNIE_SYNTH_VOICE_HEAD   = 2, // TIM3 (confirmed Head port C or D, sibling coasted)
} vernie_synth_voice_id_t;

typedef enum {
    VERNIE_HEAD_PORT_NONE = 0,
    VERNIE_HEAD_PORT_C    = 1,
    VERNIE_HEAD_PORT_D    = 2,
} vernie_head_port_t;

typedef struct {
    uint16_t psc;
    uint16_t arr;
    uint16_t ccr1;          // PWM Mode 1 compare (pin1 HIGH on [0, ccr1))
    uint16_t ccr2;          // PWM Mode 2 compare (pin2 HIGH on [ccr2, arr])
    uint32_t actual_hz_x10; // Actual achieved frequency * 10
} vernie_synth_pwm_t;

/**
 * Hardware adapter hooks (real STM32 TIM1/TIM3 on ARM; mock recorder in ASan/UBSan host tests).
 */
typedef struct {
    bool (*acquire)(uint8_t voice, vernie_head_port_t head_port, void *ctx);
    void (*set_pwm)(uint8_t voice, vernie_head_port_t head_port, const vernie_synth_pwm_t *pwm, void *ctx);
    void (*release)(uint8_t voice, vernie_head_port_t head_port, void *ctx);
    void *ctx;
} vernie_synth_hal_t;

typedef struct {
    bool active;
    bool hw_locked;
    bool in_preset;
    uint8_t preset_id;
    uint8_t preset_step;
    uint8_t volume_pct;
    uint32_t step_end_ms;
    uint32_t last_tick_ms;
    uint32_t continuous_ms;
    uint32_t cooldown_until_ms;
    vernie_synth_pwm_t current_pwm;
} vernie_synth_voice_t;

typedef struct {
    vernie_synth_voice_t voices[2]; // [0] = TIM1 (voice 1), [1] = TIM3 (voice 2)
    vernie_head_port_t head_port;
    bool sibling_safe_for_tim3;
    uint8_t default_volume_pct;
    vernie_synth_hal_t hal;
} vernie_synth_t;

/**
 * Pure deterministic PWM divider calculation for STM32F070RB (48 MHz timer clock).
 * Guarantees:
 *   - 110..4000 Hz within +/-0.5% accuracy (typically < 0.05%)
 *   - PSC <= 65535, ARR <= 65535
 *   - ccr1 <= 0.15 * ARR, ccr2 == ARR - ccr1 (exact 0 V DC creep-free symmetry)
 *   - Dead-band (ccr2 - ccr1) >= 0.70 * ARR
 */
bool vernie_synth_calc_pwm(uint16_t freq_hz, uint8_t volume_pct, vernie_synth_pwm_t *out);

/**
 * Convert MIDI note number (45=A2 .. 108=C8) to integer Hz (0 if out of range).
 */
uint16_t vernie_midi_to_hz(uint8_t midi_note);

void vernie_synth_init(vernie_synth_t *s, const vernie_synth_hal_t *hal, uint8_t default_volume_pct);

/**
 * Inform synth which external port hosts the confirmed 88008 head motor and whether
 * the sibling external port is safe (no motor power active) for TIM3 Voice 2.
 */
void vernie_synth_set_head_port(vernie_synth_t *s, vernie_head_port_t port, bool sibling_safe);

/**
 * Handle a 0x04 SYNTH command:
 *   - voice == 0 && preset_or_note == 0: stop both voices immediately
 *   - voice == 0 && preset_or_note in 1..8: play R2-D2 preset on best available voice (TIM3 or TIM1)
 *   - voice in 1..2 && preset_or_note == 0: stop that voice
 *   - voice in 1..2 && preset_or_note in 1..31: play preset on that voice
 *   - voice in 1..2 && preset_or_note >= 32: play MIDI note for dur_ms (clamped <= 3000 ms)
 */
bool vernie_synth_command(
    vernie_synth_t *s,
    uint8_t voice,
    uint8_t preset_or_note,
    uint16_t dur_ms,
    uint32_t now_ms
);

/**
 * Immediately stop & restore timer hardware for a voice so pbio motors can run safely.
 */
void vernie_synth_yield_voice(vernie_synth_t *s, uint8_t voice);
void vernie_synth_stop_all(vernie_synth_t *s);

/**
 * Advance note durations, preset steps, and thermal safety watchdog.
 */
void vernie_synth_tick(vernie_synth_t *s, uint32_t now_ms);

bool vernie_synth_is_active(const vernie_synth_t *s);

#ifndef VERNIE_HOST_TEST
/**
 * Return the real STM32F070RB TIM1/TIM3 hardware backend (implemented in vernie_synth.c).
 */
vernie_synth_hal_t vernie_synth_stm32_hal(void (*coast_tim1_cb)(void), void (*coast_tim3_cb)(void));
#endif

#ifdef __cplusplus
}
#endif

#endif // VERNIE_SYNTH_H
