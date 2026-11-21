// SPDX-License-Identifier: MIT
// Vernie OS Native SPI1 LIS3DH 3-Axis Accelerometer Driver & Gesture/Safety Processor.
//
// Hardware (LEGO BOOST Move Hub STM32F070RB):
//   - SPI1: PA4 (CS), PA5 (SCK AF0), PA6 (MISO AF0), PA7 (MOSI AF0), Mode 3, 3 MHz
//   - 8-bit SPI1->DR access + FRXTH=1 + bounded spin timeouts (never risks 3 s IWDG reset)
//   - 200 Hz ODR, ±2g HR mode, HPCLICK=1, LIR_CLICK=1
//   - Upright Vernie torso frame + stationary-gated (>= 250 ms) double-tap + pickup/bump fusion

#ifndef VERNIE_IMU_H
#define VERNIE_IMU_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// LIS3DH register map constants
#define LIS3DH_REG_WHO_AM_I     (0x0Fu)
#define LIS3DH_WHO_AM_I_VAL     (0x33u)
#define LIS3DH_REG_CTRL_REG1    (0x20u)
#define LIS3DH_REG_CTRL_REG2    (0x21u)
#define LIS3DH_REG_CTRL_REG4    (0x23u)
#define LIS3DH_REG_OUT_X_L      (0x28u)
#define LIS3DH_REG_CLICK_CFG    (0x38u)
#define LIS3DH_REG_CLICK_SRC    (0x39u)
#define LIS3DH_REG_CLICK_THS    (0x3Au)
#define LIS3DH_REG_TIME_LIMIT   (0x3Bu)
#define LIS3DH_REG_TIME_LATENCY (0x3Cu)
#define LIS3DH_REG_TIME_WINDOW  (0x3Du)

#define LIS3DH_SPI_READ         (0x80u)
#define LIS3DH_SPI_AUTOINC      (0x40u)

#define LIS3DH_CLICK_SRC_DCLICK (0x20u)

#define VERNIE_IMU_PICKUP_TILT_DEG       (35)
#define VERNIE_IMU_LIFT_DELTA_MG         (450)
#define VERNIE_IMU_LIFT_SUSTAIN_MS       (120u)
#define VERNIE_IMU_BUMP_DELTA_MG         (600)
#define VERNIE_IMU_TAP_STATIONARY_MIN_MS (250u)

typedef struct {
    bool (*reg_write)(uint8_t reg, uint8_t val, void *ctx);
    bool (*reg_read)(uint8_t reg, uint8_t *buf, size_t len, void *ctx);
    void *ctx;
} vernie_imu_bus_t;

typedef struct {
    bool ready;
    int8_t pitch_deg;
    int8_t roll_deg;
    int16_t pitch_zero_deg;
    int16_t roll_zero_deg;
    int16_t prev_fwd_mg;
    int16_t prev_side_mg;
    bool has_prev_sample;
    bool picked_up;
    uint32_t lift_start_ms;
    bool lift_active;
    uint32_t upright_since_ms;
    bool bump_detected;
    uint32_t bump_clear_ms;
    bool tap_event;
    uint32_t tap_hold_until_ms;
    uint32_t last_motion_ms;
    vernie_imu_bus_t bus;
} vernie_imu_t;

/**
 * Initialize LIS3DH over SPI bus: verifies WHO_AM_I == 0x33 and configures 200 Hz ODR,
 * HPCLICK, LIR_CLICK, and double-click timing registers. Returns true on success.
 */
bool vernie_imu_init(
    vernie_imu_t *imu,
    const vernie_imu_bus_t *bus,
    int16_t pitch_zero_deg,
    int16_t roll_zero_deg
);

/**
 * Pure sample processor (directly unit-testable with synthetic raw mg samples):
 * Raw LIS3DH axes in mg are transformed to Vernie's upright torso frame.
 */
void vernie_imu_process_sample(
    vernie_imu_t *imu,
    int16_t raw_x_mg,
    int16_t raw_y_mg,
    int16_t raw_z_mg,
    uint8_t click_src,
    bool tracks_moving,
    bool tracks_stalled,
    uint32_t now_ms
);

/**
 * Poll LIS3DH over SPI1 (reads 6-byte accel burst + CLICK_SRC) and run safety/gesture fusion.
 * Returns false if IMU is absent or SPI timed out.
 */
bool vernie_imu_poll(
    vernie_imu_t *imu,
    bool tracks_moving,
    bool tracks_stalled,
    uint32_t now_ms
);

/**
 * Consume & clear a latched double-tap event (returns true once per valid stationary double-tap).
 */
bool vernie_imu_consume_tap_event(vernie_imu_t *imu);

/**
 * Integer atan2 approximation in degrees [-180, 180] (accurate within +/-1 deg, zero libm float).
 */
int16_t vernie_imu_atan2_deg(int32_t y, int32_t x);

#ifndef VERNIE_HOST_TEST
vernie_imu_bus_t vernie_imu_stm32_spi1_bus(void);
#endif

#ifdef __cplusplus
}
#endif

#endif // VERNIE_IMU_H
