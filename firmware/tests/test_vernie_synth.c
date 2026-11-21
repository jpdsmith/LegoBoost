// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for 2-Voice Bipolar Singing-Motor Synth (vernie_synth.c).
// Covers T3.6 (frequency accuracy <= 0.5%), T3.7 (0 V DC bipolar symmetry & >= 70% dead-band),
// T3.8 (TIM1/TIM3 arbitration & motor yield), and T3.9 (3000 ms thermal cap + 500 ms cooldown).

#include "vernie_synth.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    int acquire_count[3];
    int set_pwm_count[3];
    int release_count[3];
    bool locked[3];
    vernie_synth_pwm_t last_pwm[3];
} mock_synth_hal_t;

static bool mock_acquire(uint8_t voice, vernie_head_port_t head_port, void *ctx) {
    (void)head_port;
    mock_synth_hal_t *m = (mock_synth_hal_t *)ctx;
    m->acquire_count[voice]++;
    m->locked[voice] = true;
    return true;
}

static void mock_set_pwm(uint8_t voice, vernie_head_port_t head_port, const vernie_synth_pwm_t *pwm, void *ctx) {
    (void)head_port;
    mock_synth_hal_t *m = (mock_synth_hal_t *)ctx;
    m->set_pwm_count[voice]++;
    m->last_pwm[voice] = *pwm;
}

static void mock_release(uint8_t voice, vernie_head_port_t head_port, void *ctx) {
    (void)head_port;
    mock_synth_hal_t *m = (mock_synth_hal_t *)ctx;
    m->release_count[voice]++;
    m->locked[voice] = false;
}

static void test_frequency_accuracy_and_bipolar_symmetry(void) {
    // T3.6 & T3.7: Every MIDI note from A3 (57 = 220 Hz) through A7 (105 = 3520 Hz)
    for (uint8_t midi = 57u; midi <= 105u; midi++) {
        uint16_t hz = vernie_midi_to_hz(midi);
        assert(hz >= 220u && hz <= 3520u);

        for (uint8_t vol = 10u; vol <= 100u; vol = (uint8_t)(vol + 30u)) {
            vernie_synth_pwm_t pwm;
            assert(vernie_synth_calc_pwm(hz, vol, &pwm));

            // Actual frequency within +/- 0.5% of target
            double actual_hz = 48000000.0 / (((double)pwm.psc + 1.0) * ((double)pwm.arr + 1.0));
            double err_pct = fabs(actual_hz - (double)hz) * 100.0 / (double)hz;
            assert(err_pct < 0.5);

            // Symmetrical 0.0 V DC creep-free invariant:
            //   period = ARR + 1 ticks; pin1 HIGH on [0, ccr1) = d ticks;
            //   pin2 HIGH on [ccr2, ARR] = period - ccr2 = d ticks => ccr2 == period - ccr1.
            uint32_t period = (uint32_t)pwm.arr + 1u;
            assert(pwm.ccr1 >= 1u);
            assert(pwm.ccr2 == (uint16_t)(period - pwm.ccr1));
            assert((uint32_t)pwm.ccr1 * 100u <= period * VERNIE_SYNTH_MAX_DUTY_PCT);
            // Dead-band >= 70% of period (both pins LOW)
            uint32_t deadband = (uint32_t)pwm.ccr2 - (uint32_t)pwm.ccr1;
            assert(deadband * 100u >= period * 70u);
        }
    }

    // Out-of-range frequencies rejected cleanly.
    vernie_synth_pwm_t bad;
    assert(!vernie_synth_calc_pwm(50u, 80u, &bad));
    assert(!vernie_synth_calc_pwm(5000u, 80u, &bad));
    assert(vernie_midi_to_hz(20u) == 0u);
    assert(vernie_midi_to_hz(108u) == 0u);
}

static void test_timer_arbitration_and_tim3_safety(void) {
    mock_synth_hal_t m;
    memset(&m, 0, sizeof(m));
    vernie_synth_hal_t hal = {
        .acquire = mock_acquire,
        .set_pwm = mock_set_pwm,
        .release = mock_release,
        .ctx = &m,
    };
    vernie_synth_t s;
    vernie_synth_init(&s, &hal, 80u);

    // Voice 2 (TIM3) MUST refuse when head port is not yet confirmed!
    assert(!vernie_synth_command(&s, VERNIE_SYNTH_VOICE_HEAD, 69u, 200u, 100u));
    assert(!m.locked[VERNIE_SYNTH_VOICE_HEAD]);

    // Voice 2 MUST also refuse if sibling port is NOT safe!
    vernie_synth_set_head_port(&s, VERNIE_HEAD_PORT_C, false);
    assert(!vernie_synth_command(&s, VERNIE_SYNTH_VOICE_HEAD, 69u, 200u, 100u));

    // Confirm Port C head + safe sibling (88007 sensor) -> Voice 2 plays cleanly!
    vernie_synth_set_head_port(&s, VERNIE_HEAD_PORT_C, true);
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_HEAD, 69u, 200u, 100u));
    assert(m.locked[VERNIE_SYNTH_VOICE_HEAD] && vernie_synth_is_active(&s));

    // Simultaneous 2-voice chord (TIM1 bass + TIM3 melody)!
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 57u, 200u, 100u));
    assert(m.locked[VERNIE_SYNTH_VOICE_TRACKS] && m.locked[VERNIE_SYNTH_VOICE_HEAD]);

    // Motor drive yields ONLY TIM1; TIM3 continues playing undisturbed!
    vernie_synth_yield_voice(&s, VERNIE_SYNTH_VOICE_TRACKS);
    assert(!m.locked[VERNIE_SYNTH_VOICE_TRACKS]);
    assert(m.release_count[VERNIE_SYNTH_VOICE_TRACKS] == 1);
    assert(m.locked[VERNIE_SYNTH_VOICE_HEAD]);

    // Voice 2 ends naturally at t = 300 ms and restores TIM3 registers.
    vernie_synth_tick(&s, 299u);
    assert(m.locked[VERNIE_SYNTH_VOICE_HEAD]);
    vernie_synth_tick(&s, 300u);
    assert(!m.locked[VERNIE_SYNTH_VOICE_HEAD]);
    assert(!vernie_synth_is_active(&s));
    assert(m.release_count[VERNIE_SYNTH_VOICE_HEAD] == 1);

    // C4 regression: busy head blocks VOICE_HEAD and redirects VOICE_BOTH (Auto) to VOICE_TRACKS!
    vernie_synth_set_busy(&s, false, true);
    assert(!vernie_synth_command(&s, VERNIE_SYNTH_VOICE_HEAD, 69u, 200u, 500u));
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_BOTH, VERNIE_SFX_HAPPY_CHIRP, 0u, 500u));
    assert(m.locked[VERNIE_SYNTH_VOICE_TRACKS] && !m.locked[VERNIE_SYNTH_VOICE_HEAD]);
    vernie_synth_stop_all(&s);

    // Both tracks and head busy -> Auto voice refuses safely!
    vernie_synth_set_busy(&s, true, true);
    assert(!vernie_synth_command(&s, VERNIE_SYNTH_VOICE_BOTH, VERNIE_SFX_HAPPY_CHIRP, 0u, 600u));
    assert(!vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 200u, 600u));
}

static void test_preset_sequencer_and_thermal_watchdog(void) {
    mock_synth_hal_t m;
    memset(&m, 0, sizeof(m));
    vernie_synth_hal_t hal = {
        .acquire = mock_acquire,
        .set_pwm = mock_set_pwm,
        .release = mock_release,
        .ctx = &m,
    };
    vernie_synth_t s;
    vernie_synth_init(&s, &hal, 80u);

    // Boot chime has 4 notes (80 + 80 + 80 + 160 = 400 ms).
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, VERNIE_SFX_BOOT_CHIME, 0u, 0u));
    assert(m.set_pwm_count[1] == 1);
    vernie_synth_tick(&s, 80u);
    assert(m.set_pwm_count[1] == 2);
    vernie_synth_tick(&s, 160u);
    assert(m.set_pwm_count[1] == 3);
    vernie_synth_tick(&s, 240u);
    assert(m.set_pwm_count[1] == 4);
    vernie_synth_tick(&s, 400u);
    assert(!vernie_synth_is_active(&s));

    // T3.9 Thermal safety watchdog: chained long tones MUST cut off at 3000 ms and enforce 500 ms cooldown!
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 2000u, 1000u));
    vernie_synth_tick(&s, 2500u); // 1500 ms elapsed
    // Re-trigger another 2000 ms before silence -> continuous_ms accumulates!
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 72u, 2000u, 2500u));
    vernie_synth_tick(&s, 3980u); // 2980 ms continuous -> still active
    assert(vernie_synth_is_active(&s));
    vernie_synth_tick(&s, 4000u); // 3000 ms continuous -> MUST cut off!
    assert(!vernie_synth_is_active(&s));
    assert(!m.locked[VERNIE_SYNTH_VOICE_TRACKS]);

    // During 500 ms thermal cooldown (4000..4499 ms), restarts MUST be rejected!
    assert(!vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 200u, 4200u));
    // At 4500 ms cooldown expires -> plays normally again!
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 200u, 4500u));
    vernie_synth_stop_all(&s);

    // I1 regression 1: rapid 20 ms re-triggers BEFORE vernie_synth_tick MUST NOT bypass 3000 ms cap!
    vernie_synth_init(&s, &hal, 80u);
    uint32_t t = 10000u;
    bool tripped = false;
    for (int i = 0; i <= 160; i++) {
        bool ok = vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 100u, t);
        if (!ok) {
            assert(t == 13000u);
            tripped = true;
            break;
        }
        vernie_synth_tick(&s, t); // tick at same timestamp (dt=0), replicating BLE-before-tick loop!
        t += 20u;
    }
    assert(tripped);
    assert(!vernie_synth_is_active(&s));

    // I1 regression 2: back-to-back 2900 ms tone + 20 ms silence MUST trip after 120 ms (leaky bucket)!
    vernie_synth_init(&s, &hal, 80u);
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 2900u, 20000u));
    vernie_synth_tick(&s, 22900u); // ends naturally with 2900 ms thermal credit
    assert(!vernie_synth_is_active(&s));
    assert(vernie_synth_command(&s, VERNIE_SYNTH_VOICE_TRACKS, 69u, 500u, 22920u)); // 20 ms cool -> 2880 ms
    vernie_synth_tick(&s, 23040u); // +120 ms = 3000 ms -> MUST cut off!
    assert(!vernie_synth_is_active(&s));
}

int main(void) {
    test_frequency_accuracy_and_bipolar_symmetry();
    test_timer_arbitration_and_tim3_safety();
    test_preset_sequencer_and_thermal_watchdog();
    printf("ALL VERNIE SYNTH C UNIT TESTS PASSED.\n");
    return 0;
}
