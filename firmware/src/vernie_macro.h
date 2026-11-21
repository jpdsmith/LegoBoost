// SPDX-License-Identifier: MIT
// Vernie OS Chunked Flash Macro Engine (0x07 MACRO_OP -> FLASH_USER_1 persistence).
//
// Wire Protocol (fits strictly inside BlueNRG-MS 17 B RX AppData):
//   [0x07, subcmd, offset, data[0..14]]
//
// Macro Bytecode Format (5 bytes per step, up to 46 steps in 232-byte FLASH_USER_1 buffer):
//   byte 0: op   (1=DRIVE, 2=HEAD, 3=SYNTH, 4=LED, 5=WAIT) — intentionally NO dart-fire opcode!
//   byte 1: arg0 (int8 left / angle_deg / voice / led_target)
//   byte 2: arg1 (int8 right / speed_pct / preset_or_note / color_or_state)
//   byte 3..4: uint16_le dur_ms (clamped 50..5000 ms; synth clamped <= 3000 ms)

#ifndef VERNIE_MACRO_H
#define VERNIE_MACRO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "vernie_storage.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VERNIE_MACRO_STEP_BYTES     (5u)
#define VERNIE_MACRO_MAX_BYTES      (VERNIE_STORAGE_MACRO_MAX) // 232 B = 46 steps max
#define VERNIE_MACRO_DUR_MIN_MS     (50u)
#define VERNIE_MACRO_DUR_MAX_MS     (5000u)

typedef enum {
    VERNIE_MACRO_SUB_CLEAR       = 0,
    VERNIE_MACRO_SUB_WRITE_CHUNK = 1,
    VERNIE_MACRO_SUB_PLAY        = 2,
    VERNIE_MACRO_SUB_STOP        = 3,
    VERNIE_MACRO_SUB_SAVE        = 4,
} vernie_macro_subcmd_t;

typedef enum {
    VERNIE_MSTEP_DRIVE = 1, // arg0=left(-100..100), arg1=right(-100..100), dur_ms
    VERNIE_MSTEP_HEAD  = 2, // arg0=angle(-40..+35), arg1=speed(10..100), dur_ms
    VERNIE_MSTEP_SYNTH = 3, // arg0=voice(0..2), arg1=preset_or_note, dur_ms
    VERNIE_MSTEP_LED   = 4, // arg0=target(0=hub_palette 0..5, 1=chest 0/3/5/9), arg1=val, dur_ms
    VERNIE_MSTEP_WAIT  = 5, // coast tracks for dur_ms
} vernie_macro_step_op_t;

typedef struct {
    bool active;
    bool drive_active;
    int8_t drive_left;
    int8_t drive_right;
    bool head_cmd;
    int8_t head_angle_deg;
    uint8_t head_speed;
    bool synth_cmd;
    uint8_t synth_voice;
    uint8_t synth_preset_or_note;
    uint16_t synth_dur_ms;
    bool hub_led_cmd;
    uint8_t hub_r;
    uint8_t hub_g;
    uint8_t hub_b;
    bool chest_led_cmd;
    uint8_t chest_led;
} vernie_macro_output_t;

typedef struct {
    uint8_t buf[VERNIE_MACRO_MAX_BYTES];
    uint16_t len;
    bool playing;
    uint16_t step_offset;
    uint32_t step_end_ms;
    bool step_started;
} vernie_macro_t;

void vernie_macro_init(vernie_macro_t *m, const vernie_storage_blob_t *saved_blob);

/**
 * Process a validated 0x07 MACRO_OP command.
 * If subcmd == SAVE, writes staged macro into `storage->blob` and calls vernie_storage_mark_dirty().
 * Returns true if the command was valid and accepted.
 */
bool vernie_macro_handle_cmd(
    vernie_macro_t *m,
    vernie_storage_t *storage,
    uint8_t subcmd,
    uint8_t offset,
    const uint8_t *data,
    uint8_t data_len,
    uint32_t now_ms
);

bool vernie_macro_start(vernie_macro_t *m, uint32_t now_ms);
void vernie_macro_stop(vernie_macro_t *m);

/**
 * Advance active macro playback by one cooperative tick.
 * Immediately aborts and coasts if safe_mode || picked_up.
 */
void vernie_macro_tick(
    vernie_macro_t *m,
    bool safe_mode,
    bool picked_up,
    uint32_t now_ms,
    vernie_macro_output_t *out
);

#ifdef __cplusplus
}
#endif

#endif // VERNIE_MACRO_H
