// SPDX-License-Identifier: MIT
// Vernie OS 2-Voice Symmetrical Bipolar Singing-Motor Synthesizer (TIM1 & TIM3).

#include "vernie_synth.h"

#include <string.h>

#ifndef VERNIE_HOST_TEST
#include <stm32f0xx.h>
#include <pbdrv/gpio.h>
#endif

// Exact integer Hz lookup for MIDI notes 45 (A2 = 110 Hz) through 108 (C8 = 4186 Hz).
static const uint16_t k_midi_hz[64] = {
     110,  117,  123,  131,  139,  147,  156,  165,  175,  185,  196,  208, // 45..56 (A2..G#3)
     220,  233,  247,  262,  277,  294,  311,  330,  349,  370,  392,  415, // 57..68 (A3..G#4)
     440,  466,  494,  523,  554,  587,  622,  659,  698,  740,  784,  831, // 69..80 (A4..G#5)
     880,  932,  988, 1047, 1109, 1175, 1245, 1319, 1397, 1480, 1568, 1661, // 81..92 (A5..G#6)
    1760, 1865, 1976, 2093, 2217, 2349, 2489, 2637, 2794, 2960, 3136, 3322, // 93..104 (A6..G#7)
    3520, 3729, 3951, 4186,                                                 // 105..108 (A7..C8)
};

typedef struct {
    uint16_t freq_hz; // 0 = rest (silence without releasing lock)
    uint16_t dur_ms;
    uint8_t vol_pct;
} vernie_sfx_step_t;

typedef struct {
    const vernie_sfx_step_t *steps;
    uint8_t count;
} vernie_sfx_seq_t;

static const vernie_sfx_step_t k_sfx_boot[] = {
    { 523, 80, 75 }, { 659, 80, 75 }, { 784, 80, 75 }, { 1047, 160, 80 },
};
static const vernie_sfx_step_t k_sfx_happy[] = {
    { 880, 60, 80 }, { 1319, 60, 80 }, { 1760, 80, 85 }, { 1397, 60, 75 }, { 2093, 120, 85 },
};
static const vernie_sfx_step_t k_sfx_curious[] = {
    { 660, 80, 70 }, { 880, 80, 75 }, { 1175, 140, 80 },
};
static const vernie_sfx_step_t k_sfx_alarm[] = {
    { 1480, 80, 90 }, { 932, 80, 90 }, { 1480, 80, 90 }, { 932, 120, 90 },
};
static const vernie_sfx_step_t k_sfx_siren[] = {
    { 784, 120, 90 }, { 1175, 120, 90 }, { 784, 120, 90 }, { 1175, 120, 90 },
};
static const vernie_sfx_step_t k_sfx_laser[] = {
    { 2637, 40, 90 }, { 1976, 40, 85 }, { 1319, 40, 80 }, { 880, 60, 75 }, { 440, 80, 70 },
};
static const vernie_sfx_step_t k_sfx_victory[] = {
    { 523, 80, 80 }, { 659, 80, 80 }, { 784, 80, 80 }, { 1047, 100, 85 },
    { 784, 60, 75 }, { 1047, 220, 90 },
};
static const vernie_sfx_step_t k_sfx_tick[] = {
    { 1319, 40, 65 },
};

static const vernie_sfx_seq_t k_sfx_bank[VERNIE_SFX_COUNT] = {
    [VERNIE_SFX_STOP]          = { NULL, 0 },
    [VERNIE_SFX_BOOT_CHIME]    = { k_sfx_boot,    (uint8_t)(sizeof(k_sfx_boot) / sizeof(k_sfx_boot[0])) },
    [VERNIE_SFX_HAPPY_CHIRP]   = { k_sfx_happy,   (uint8_t)(sizeof(k_sfx_happy) / sizeof(k_sfx_happy[0])) },
    [VERNIE_SFX_CURIOUS_BEEP]  = { k_sfx_curious, (uint8_t)(sizeof(k_sfx_curious) / sizeof(k_sfx_curious[0])) },
    [VERNIE_SFX_ALARM_SQUAWK]  = { k_sfx_alarm,   (uint8_t)(sizeof(k_sfx_alarm) / sizeof(k_sfx_alarm[0])) },
    [VERNIE_SFX_WARNING_SIREN] = { k_sfx_siren,   (uint8_t)(sizeof(k_sfx_siren) / sizeof(k_sfx_siren[0])) },
    [VERNIE_SFX_LASER_ZAP]     = { k_sfx_laser,   (uint8_t)(sizeof(k_sfx_laser) / sizeof(k_sfx_laser[0])) },
    [VERNIE_SFX_VICTORY]       = { k_sfx_victory, (uint8_t)(sizeof(k_sfx_victory) / sizeof(k_sfx_victory[0])) },
    [VERNIE_SFX_MODE_TICK]     = { k_sfx_tick,    (uint8_t)(sizeof(k_sfx_tick) / sizeof(k_sfx_tick[0])) },
};

uint16_t vernie_midi_to_hz(uint8_t midi_note) {
    if (midi_note < 45u || midi_note > 107u) {
        return 0u;
    }
    return k_midi_hz[midi_note - 45u];
}

bool vernie_synth_calc_pwm(uint16_t freq_hz, uint8_t volume_pct, vernie_synth_pwm_t *out) {
    if (!out || freq_hz < VERNIE_SYNTH_FREQ_MIN_HZ || freq_hz > VERNIE_SYNTH_FREQ_MAX_HZ) {
        return false;
    }

    // Choose smallest prescaler so ARR fits 16-bit register (<= 65535) with maximum resolution.
    // total_ticks = round(48,000,000 / freq_hz)
    uint32_t total_ticks = (VERNIE_SYNTH_CLK_HZ + (freq_hz / 2u)) / freq_hz;
    uint32_t psc = 0u;
    if (total_ticks > 65536u) {
        psc = (total_ticks - 1u) / 65536u;
    }
    if (psc > 65535u) {
        return false;
    }

    uint32_t denom = (psc + 1u) * (uint32_t)freq_hz;
    uint32_t period = (VERNIE_SYNTH_CLK_HZ + (denom / 2u)) / denom;
    if (period < 21u) {
        period = 21u;
    }
    if (period > 65536u) {
        period = 65536u;
    }
    uint16_t arr = (uint16_t)(period - 1u);

    // Symmetrical 3-level bipolar duty capped strictly <= 15% ARR -> dead-band >= 70% ARR.
    uint8_t vol = volume_pct;
    if (vol == 0u) {
        vol = 1u;
    }
    if (vol > 100u) {
        vol = 100u;
    }
    uint32_t max_d = ((uint32_t)arr * VERNIE_SYNTH_MAX_DUTY_PCT) / 100u;
    uint32_t d = ((uint32_t)arr * (uint32_t)vol * VERNIE_SYNTH_MAX_DUTY_PCT) / 10000u;
    if (d < 1u) {
        d = 1u;
    }
    if (d > max_d) {
        d = max_d;
    }

    uint32_t actual_denom = (psc + 1u) * ((uint32_t)arr + 1u);
    uint32_t actual_hz_x10 = ((VERNIE_SYNTH_CLK_HZ * 10u) + (actual_denom / 2u)) / actual_denom;

    out->psc = (uint16_t)psc;
    out->arr = arr;
    out->ccr1 = (uint16_t)d;
    out->ccr2 = (uint16_t)(arr - d);
    out->actual_hz_x10 = actual_hz_x10;
    return true;
}

void vernie_synth_init(vernie_synth_t *s, const vernie_synth_hal_t *hal, uint8_t default_volume_pct) {
    memset(s, 0, sizeof(*s));
    if (hal) {
        s->hal = *hal;
    }
    s->default_volume_pct = (default_volume_pct >= 10u && default_volume_pct <= 100u) ? default_volume_pct : 75u;
}

void vernie_synth_set_head_port(vernie_synth_t *s, vernie_head_port_t port, bool sibling_safe) {
    if (!s) {
        return;
    }
    if (s->head_port != port || !sibling_safe) {
        vernie_synth_yield_voice(s, VERNIE_SYNTH_VOICE_HEAD);
    }
    s->head_port = port;
    s->sibling_safe_for_tim3 = sibling_safe;
}

static void release_voice_hw(vernie_synth_t *s, uint8_t voice_id) {
    if (voice_id < 1u || voice_id > 2u) {
        return;
    }
    vernie_synth_voice_t *v = &s->voices[voice_id - 1u];
    if (v->hw_locked) {
        if (s->hal.release) {
            s->hal.release(voice_id, s->head_port, s->hal.ctx);
        }
        v->hw_locked = false;
    }
    v->active = false;
    v->in_preset = false;
    v->continuous_ms = 0u;
}

void vernie_synth_yield_voice(vernie_synth_t *s, uint8_t voice) {
    if (!s) {
        return;
    }
    if (voice == VERNIE_SYNTH_VOICE_BOTH) {
        release_voice_hw(s, VERNIE_SYNTH_VOICE_TRACKS);
        release_voice_hw(s, VERNIE_SYNTH_VOICE_HEAD);
    } else {
        release_voice_hw(s, voice);
    }
}

void vernie_synth_stop_all(vernie_synth_t *s) {
    vernie_synth_yield_voice(s, VERNIE_SYNTH_VOICE_BOTH);
}

static bool voice_start_tone(
    vernie_synth_t *s,
    uint8_t voice_id,
    uint16_t freq_hz,
    uint16_t dur_ms,
    uint8_t vol_pct,
    uint32_t now_ms
) {
    if (voice_id < 1u || voice_id > 2u || dur_ms == 0u) {
        return false;
    }
    if (voice_id == VERNIE_SYNTH_VOICE_HEAD) {
        if (s->head_port == VERNIE_HEAD_PORT_NONE || !s->sibling_safe_for_tim3) {
            return false;
        }
    }

    vernie_synth_voice_t *v = &s->voices[voice_id - 1u];
    if (v->cooldown_until_ms != 0u && (int32_t)(now_ms - v->cooldown_until_ms) < 0) {
        return false;
    }
    v->cooldown_until_ms = 0u;

    vernie_synth_pwm_t pwm;
    if (!vernie_synth_calc_pwm(freq_hz, vol_pct, &pwm)) {
        return false;
    }

    if (!v->hw_locked) {
        if (s->hal.acquire && !s->hal.acquire(voice_id, s->head_port, s->hal.ctx)) {
            return false;
        }
        v->hw_locked = true;
    }

    if (dur_ms > VERNIE_SYNTH_THERMAL_MAX_MS) {
        dur_ms = VERNIE_SYNTH_THERMAL_MAX_MS;
    }
    v->current_pwm = pwm;
    v->active = true;
    v->volume_pct = vol_pct;
    v->step_end_ms = now_ms + dur_ms;
    v->last_tick_ms = now_ms;

    if (s->hal.set_pwm) {
        s->hal.set_pwm(voice_id, s->head_port, &pwm, s->hal.ctx);
    }
    return true;
}

bool vernie_synth_command(
    vernie_synth_t *s,
    uint8_t voice,
    uint8_t preset_or_note,
    uint16_t dur_ms,
    uint32_t now_ms
) {
    if (!s || voice > 2u) {
        return false;
    }

    if (preset_or_note == VERNIE_SFX_STOP) {
        vernie_synth_yield_voice(s, voice);
        return true;
    }

    // Voice 0 selects head motor (TIM3) if confirmed & safe, else tracks (TIM1).
    uint8_t target_voice = voice;
    if (target_voice == VERNIE_SYNTH_VOICE_BOTH) {
        target_voice = (s->head_port != VERNIE_HEAD_PORT_NONE && s->sibling_safe_for_tim3)
                           ? VERNIE_SYNTH_VOICE_HEAD
                           : VERNIE_SYNTH_VOICE_TRACKS;
    }

    vernie_synth_voice_t *v = &s->voices[target_voice - 1u];

    if (preset_or_note < 32u) {
        if (preset_or_note >= VERNIE_SFX_COUNT || k_sfx_bank[preset_or_note].count == 0u) {
            return false;
        }
        const vernie_sfx_step_t *first = &k_sfx_bank[preset_or_note].steps[0];
        if (!voice_start_tone(s, target_voice, first->freq_hz, first->dur_ms, first->vol_pct, now_ms)) {
            return false;
        }
        v->in_preset = true;
        v->preset_id = preset_or_note;
        v->preset_step = 0u;
        return true;
    }

    // Direct MIDI note playback.
    uint16_t hz = vernie_midi_to_hz(preset_or_note);
    if (hz == 0u) {
        return false;
    }
    uint16_t clamped_dur = dur_ms == 0u ? 200u : dur_ms;
    v->in_preset = false;
    return voice_start_tone(s, target_voice, hz, clamped_dur, s->default_volume_pct, now_ms);
}

void vernie_synth_tick(vernie_synth_t *s, uint32_t now_ms) {
    if (!s) {
        return;
    }
    for (uint8_t idx = 0u; idx < 2u; idx++) {
        uint8_t voice_id = (uint8_t)(idx + 1u);
        vernie_synth_voice_t *v = &s->voices[idx];
        if (!v->active) {
            continue;
        }

        uint32_t dt = now_ms - v->last_tick_ms;
        v->last_tick_ms = now_ms;
        v->continuous_ms += dt;

        // Hard thermal safety cap (3000 ms continuous -> silence + 500 ms cooldown).
        if (v->continuous_ms >= VERNIE_SYNTH_THERMAL_MAX_MS) {
            release_voice_hw(s, voice_id);
            v->cooldown_until_ms = now_ms + VERNIE_SYNTH_COOLDOWN_MS;
            continue;
        }

        if ((int32_t)(now_ms - v->step_end_ms) >= 0) {
            if (v->in_preset) {
                const vernie_sfx_seq_t *seq = &k_sfx_bank[v->preset_id];
                uint8_t next_step = (uint8_t)(v->preset_step + 1u);
                if (next_step < seq->count) {
                    const vernie_sfx_step_t *st = &seq->steps[next_step];
                    vernie_synth_pwm_t pwm;
                    if (st->freq_hz > 0u && vernie_synth_calc_pwm(st->freq_hz, st->vol_pct, &pwm)) {
                        v->preset_step = next_step;
                        v->current_pwm = pwm;
                        v->step_end_ms = now_ms + st->dur_ms;
                        if (s->hal.set_pwm) {
                            s->hal.set_pwm(voice_id, s->head_port, &pwm, s->hal.ctx);
                        }
                        continue;
                    }
                }
            }
            release_voice_hw(s, voice_id);
        }
    }
}

bool vernie_synth_is_active(const vernie_synth_t *s) {
    if (!s) {
        return false;
    }
    return s->voices[0].active || s->voices[1].active;
}

// ============================================================================
// STM32F070RB Hardware Backend (TIM1 Port A / TIM3 Confirmed Head Port C or D)
// ============================================================================
#ifndef VERNIE_HOST_TEST

typedef struct {
    void (*coast_tim1)(void);
    void (*coast_tim3)(void);
} stm32_synth_ctx_t;

static stm32_synth_ctx_t g_stm32_synth_ctx;

// Move Hub H-bridge pins verified against platform/move_hub/platform.c:162-214
static const pbdrv_gpio_t k_pin_a1 = { .bank = GPIOA, .pin = 8 };  // TIM1 CH1 AF2
static const pbdrv_gpio_t k_pin_a2 = { .bank = GPIOA, .pin = 10 }; // TIM1 CH3 AF2
static const pbdrv_gpio_t k_pin_c1 = { .bank = GPIOC, .pin = 8 };  // TIM3 CH3 AF0
static const pbdrv_gpio_t k_pin_c2 = { .bank = GPIOC, .pin = 6 };  // TIM3 CH1 AF0
static const pbdrv_gpio_t k_pin_d1 = { .bank = GPIOC, .pin = 7 };  // TIM3 CH2 AF0
static const pbdrv_gpio_t k_pin_d2 = { .bank = GPIOC, .pin = 9 };  // TIM3 CH4 AF0

static bool stm32_synth_acquire(uint8_t voice, vernie_head_port_t head_port, void *ctx) {
    stm32_synth_ctx_t *c = (stm32_synth_ctx_t *)ctx;
    if (voice == VERNIE_SYNTH_VOICE_TRACKS) {
        if (c && c->coast_tim1) {
            c->coast_tim1();
        }
        // Coast Port A pins before reconfiguring TIM1 for bipolar 3-level PWM.
        pbdrv_gpio_out_low(&k_pin_a1);
        pbdrv_gpio_out_low(&k_pin_a2);

        // CH1 (PA8): PWM Mode 1 (0x68); CH3 (PA10): PWM Mode 2 (0x78), non-inverted.
        TIM1->CCER = 0u;
        TIM1->CCMR1 = (TIM1->CCMR1 & ~0x00FFu) | 0x0068u;
        TIM1->CCMR2 = (TIM1->CCMR2 & ~0x00FFu) | 0x0078u;
        TIM1->CCR1 = 0u;
        TIM1->CCR3 = 0u;
        TIM1->CCER = TIM_CCER_CC1E | TIM_CCER_CC3E;
        TIM1->BDTR |= TIM_BDTR_MOE;
        TIM1->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
        TIM1->EGR = TIM_EGR_UG;

        pbdrv_gpio_alt(&k_pin_a1, 2);
        pbdrv_gpio_alt(&k_pin_a2, 2);
        return true;
    }

    if (voice == VERNIE_SYNTH_VOICE_HEAD) {
        if (head_port == VERNIE_HEAD_PORT_NONE) {
            return false;
        }
        if (c && c->coast_tim3) {
            c->coast_tim3();
        }
        TIM3->CCER = 0u;
        if (head_port == VERNIE_HEAD_PORT_C) {
            pbdrv_gpio_out_low(&k_pin_c1);
            pbdrv_gpio_out_low(&k_pin_c2);
            // Port C: pin1 = PC8 (CH3 Mode 1), pin2 = PC6 (CH1 Mode 2)
            TIM3->CCMR2 = (TIM3->CCMR2 & ~0x00FFu) | 0x0068u;
            TIM3->CCMR1 = (TIM3->CCMR1 & ~0x00FFu) | 0x0078u;
            TIM3->CCR3 = 0u;
            TIM3->CCR1 = 0u;
            TIM3->CCER = TIM_CCER_CC1E | TIM_CCER_CC3E;
            TIM3->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
            TIM3->EGR = TIM_EGR_UG;
            pbdrv_gpio_alt(&k_pin_c1, 0);
            pbdrv_gpio_alt(&k_pin_c2, 0);
            return true;
        }
        if (head_port == VERNIE_HEAD_PORT_D) {
            pbdrv_gpio_out_low(&k_pin_d1);
            pbdrv_gpio_out_low(&k_pin_d2);
            // Port D: pin1 = PC7 (CH2 Mode 1), pin2 = PC9 (CH4 Mode 2)
            TIM3->CCMR1 = (TIM3->CCMR1 & ~0xFF00u) | 0x6800u;
            TIM3->CCMR2 = (TIM3->CCMR2 & ~0xFF00u) | 0x7800u;
            TIM3->CCR2 = 0u;
            TIM3->CCR4 = 0u;
            TIM3->CCER = TIM_CCER_CC2E | TIM_CCER_CC4E;
            TIM3->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
            TIM3->EGR = TIM_EGR_UG;
            pbdrv_gpio_alt(&k_pin_d1, 0);
            pbdrv_gpio_alt(&k_pin_d2, 0);
            return true;
        }
    }
    return false;
}

static void stm32_synth_set_pwm(
    uint8_t voice,
    vernie_head_port_t head_port,
    const vernie_synth_pwm_t *pwm,
    void *ctx
) {
    (void)ctx;
    if (voice == VERNIE_SYNTH_VOICE_TRACKS) {
        TIM1->PSC = pwm->psc;
        TIM1->ARR = pwm->arr;
        TIM1->CCR1 = pwm->ccr1;
        TIM1->CCR3 = pwm->ccr2;
        TIM1->EGR = TIM_EGR_UG;
    } else if (voice == VERNIE_SYNTH_VOICE_HEAD) {
        TIM3->PSC = pwm->psc;
        TIM3->ARR = pwm->arr;
        if (head_port == VERNIE_HEAD_PORT_C) {
            TIM3->CCR3 = pwm->ccr1;
            TIM3->CCR1 = pwm->ccr2;
        } else if (head_port == VERNIE_HEAD_PORT_D) {
            TIM3->CCR2 = pwm->ccr1;
            TIM3->CCR4 = pwm->ccr2;
        }
        TIM3->EGR = TIM_EGR_UG;
    }
}

static void restore_pbio_timer_defaults(TIM_TypeDef *tim, bool is_tim1) {
    // Exact pbio pwm_stm32_tim.c contract: 48MHz/(3+1)/1000 = 12kHz, Mode 1, inverted CCxP=1.
    tim->PSC = 3u;
    tim->ARR = 1000u;
    tim->CCR1 = 0u;
    tim->CCR2 = 0u;
    tim->CCR3 = 0u;
    tim->CCR4 = 0u;
    tim->CCMR1 = 0x6868u;
    tim->CCMR2 = 0x6868u;
    tim->CCER = 0x3333u;
    if (is_tim1) {
        tim->BDTR |= TIM_BDTR_MOE;
    }
    tim->CR1 = TIM_CR1_CEN;
    tim->EGR = TIM_EGR_UG;
}

static void stm32_synth_release(uint8_t voice, vernie_head_port_t head_port, void *ctx) {
    (void)ctx;
    if (voice == VERNIE_SYNTH_VOICE_TRACKS) {
        pbdrv_gpio_out_low(&k_pin_a1);
        pbdrv_gpio_out_low(&k_pin_a2);
        restore_pbio_timer_defaults(TIM1, true);
    } else if (voice == VERNIE_SYNTH_VOICE_HEAD) {
        if (head_port == VERNIE_HEAD_PORT_C) {
            pbdrv_gpio_out_low(&k_pin_c1);
            pbdrv_gpio_out_low(&k_pin_c2);
        } else if (head_port == VERNIE_HEAD_PORT_D) {
            pbdrv_gpio_out_low(&k_pin_d1);
            pbdrv_gpio_out_low(&k_pin_d2);
        }
        restore_pbio_timer_defaults(TIM3, false);
    }
}

vernie_synth_hal_t vernie_synth_stm32_hal(void (*coast_tim1_cb)(void), void (*coast_tim3_cb)(void)) {
    g_stm32_synth_ctx.coast_tim1 = coast_tim1_cb;
    g_stm32_synth_ctx.coast_tim3 = coast_tim3_cb;
    vernie_synth_hal_t hal = {
        .acquire = stm32_synth_acquire,
        .set_pwm = stm32_synth_set_pwm,
        .release = stm32_synth_release,
        .ctx = &g_stm32_synth_ctx,
    };
    return hal;
}
#endif // !VERNIE_HOST_TEST
