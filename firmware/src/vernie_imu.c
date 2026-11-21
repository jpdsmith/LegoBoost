// SPDX-License-Identifier: MIT
// Vernie OS Native SPI1 LIS3DH 3-Axis Accelerometer Driver & Gesture/Safety Processor.

#include "vernie_imu.h"

#include <string.h>

#ifndef VERNIE_HOST_TEST
#include <stm32f0xx.h>
#include <pbdrv/gpio.h>
#endif

static int32_t iabs32(int32_t v) {
    return v < 0 ? -v : v;
}

static int8_t clamp_i8(int32_t v, int8_t lo, int8_t hi) {
    if (v < (int32_t)lo) return lo;
    if (v > (int32_t)hi) return hi;
    return (int8_t)v;
}

int16_t vernie_imu_atan2_deg(int32_t y, int32_t x) {
    if (x == 0 && y == 0) {
        return 0;
    }
    int32_t ax = iabs32(x);
    int32_t ay = iabs32(y);

    // First-octant minimax approximation: atan(r) ~= 45*r + 15.6*r*(1-r) in degrees (max error < 0.3 deg).
    int32_t num = ax < ay ? ax : ay;
    int32_t den = ax < ay ? ay : ax;
    // Scale r in Q10 (0..1024).
    int32_t r = (num * 1024) / den;
    int32_t deg = (45 * r + ((16 * r * (1024 - r)) >> 10)) >> 10;

    if (ay > ax) {
        deg = 90 - deg;
    }
    if (x < 0) {
        deg = 180 - deg;
    }
    if (y < 0) {
        deg = -deg;
    }
    return (int16_t)deg;
}

bool vernie_imu_init(
    vernie_imu_t *imu,
    const vernie_imu_bus_t *bus,
    int16_t pitch_zero_deg,
    int16_t roll_zero_deg
) {
    memset(imu, 0, sizeof(*imu));
    imu->pitch_zero_deg = pitch_zero_deg;
    imu->roll_zero_deg = roll_zero_deg;
    if (!bus || !bus->reg_read || !bus->reg_write) {
        return false;
    }
    imu->bus = *bus;

    uint8_t who = 0u;
    if (!imu->bus.reg_read(LIS3DH_REG_WHO_AM_I, &who, 1u, imu->bus.ctx)) {
        return false;
    }
    if (who != LIS3DH_WHO_AM_I_VAL) {
        return false;
    }

    // CTRL_REG1: 200 Hz ODR (0x60) + XYZ enable (0x07) = 0x67
    // CTRL_REG2: HPCLICK = 1 (bit 2 = 0x04) so gravity doesn't saturate tap detector
    // CTRL_REG4: BDU = 1 (0x80) | ±2g (0x00) | High-Resolution 12-bit (0x08) = 0x88
    // CLICK_CFG: ZD (Z-axis double-click, bit 5 = 0x20)
    // CLICK_THS: LIR_CLICK = 1 (0x80) | threshold 28 (~0.44g)
    // TIME_LIMIT: 10 (50 ms @ 200 Hz), TIME_LATENCY: 20 (100 ms), TIME_WINDOW: 60 (300 ms)
    bool ok = true;
    ok = ok && imu->bus.reg_write(LIS3DH_REG_CTRL_REG1, 0x67u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_CTRL_REG2, 0x04u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_CTRL_REG4, 0x88u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_CLICK_CFG, 0x20u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_CLICK_THS, 0x80u | 28u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_TIME_LIMIT, 10u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_TIME_LATENCY, 20u, imu->bus.ctx);
    ok = ok && imu->bus.reg_write(LIS3DH_REG_TIME_WINDOW, 60u, imu->bus.ctx);

    imu->ready = ok;
    return ok;
}

void vernie_imu_process_sample(
    vernie_imu_t *imu,
    int16_t raw_x_mg,
    int16_t raw_y_mg,
    int16_t raw_z_mg,
    uint8_t click_src,
    bool tracks_moving,
    bool tracks_stalled,
    uint32_t now_ms
) {
    if (!imu) {
        return;
    }

    // Transform Move Hub PCB axes into Vernie's upright torso frame:
    //   up_mg   = raw_y_mg (~+1000 mg when Vernie stands upright on tracks)
    //   fwd_mg  = raw_z_mg (forward/backward through green button)
    //   side_mg = raw_x_mg (left/right across tracks)
    int32_t up_mg = (int32_t)raw_y_mg;
    int32_t fwd_mg = (int32_t)raw_z_mg;
    int32_t side_mg = (int32_t)raw_x_mg;

    int16_t pitch = (int16_t)(vernie_imu_atan2_deg(fwd_mg, up_mg) - imu->pitch_zero_deg);
    int16_t roll = (int16_t)(vernie_imu_atan2_deg(side_mg, up_mg) - imu->roll_zero_deg);
    imu->pitch_deg = clamp_i8(pitch, -127, 127);
    imu->roll_deg = clamp_i8(roll, -127, 127);

    // 1. Pickup detection: torso tilt > 35 deg OR sustained vertical lift delta > 450 mg for >= 120 ms.
    bool tilted = (iabs32(imu->pitch_deg) > VERNIE_IMU_PICKUP_TILT_DEG) ||
                  (iabs32(imu->roll_deg) > VERNIE_IMU_PICKUP_TILT_DEG);

    bool lift_now = iabs32(up_mg - 1000) > VERNIE_IMU_LIFT_DELTA_MG;
    bool sustained_lift = false;
    if (lift_now) {
        if (!imu->lift_active) {
            imu->lift_active = true;
            imu->lift_start_ms = now_ms;
        }
        if ((uint32_t)(now_ms - imu->lift_start_ms) >= VERNIE_IMU_LIFT_SUSTAIN_MS) {
            sustained_lift = true;
        }
    } else {
        imu->lift_active = false;
    }

    if (tilted || sustained_lift) {
        imu->picked_up = true;
        imu->upright_since_ms = now_ms;
    } else if (imu->picked_up) {
        // Release pickup flag once calm & upright for >= 300 ms.
        if ((uint32_t)(now_ms - imu->upright_since_ms) >= 300u) {
            imu->picked_up = false;
        }
    } else {
        imu->upright_since_ms = now_ms;
    }

    // 2. Bump + motor-stall fusion.
    bool accel_bump = false;
    if (imu->has_prev_sample) {
        int32_t df = iabs32(fwd_mg - (int32_t)imu->prev_fwd_mg);
        int32_t ds = iabs32(side_mg - (int32_t)imu->prev_side_mg);
        if (tracks_moving && (df + ds) > VERNIE_IMU_BUMP_DELTA_MG) {
            accel_bump = true;
        }
    }
    imu->prev_fwd_mg = (int16_t)fwd_mg;
    imu->prev_side_mg = (int16_t)side_mg;
    imu->has_prev_sample = true;

    if (accel_bump || tracks_stalled) {
        imu->bump_detected = true;
        imu->bump_clear_ms = now_ms + 300u;
    } else if (imu->bump_detected && (int32_t)(now_ms - imu->bump_clear_ms) >= 0) {
        imu->bump_detected = false;
    }

    // 3. Stationary-gated double-tap detection (suppresses track vibration false triggers).
    if (tracks_moving) {
        imu->last_motion_ms = now_ms;
    }
    bool stationary_long_enough = !tracks_moving &&
                                  ((uint32_t)(now_ms - imu->last_motion_ms) >= VERNIE_IMU_TAP_STATIONARY_MIN_MS);
    if ((click_src & LIS3DH_CLICK_SRC_DCLICK) != 0u && stationary_long_enough && !imu->picked_up) {
        imu->tap_event = true;
        imu->tap_hold_until_ms = now_ms + 300u;
    } else if (imu->tap_hold_until_ms != 0u && (int32_t)(now_ms - imu->tap_hold_until_ms) >= 0) {
        imu->tap_hold_until_ms = 0u;
    }
}

bool vernie_imu_poll(
    vernie_imu_t *imu,
    bool tracks_moving,
    bool tracks_stalled,
    uint32_t now_ms
) {
    if (!imu || !imu->ready || !imu->bus.reg_read) {
        return false;
    }

    uint8_t raw[6];
    if (!imu->bus.reg_read(LIS3DH_REG_OUT_X_L, raw, sizeof(raw), imu->bus.ctx)) {
        return false;
    }
    uint8_t click_src = 0u;
    if (!imu->bus.reg_read(LIS3DH_REG_CLICK_SRC, &click_src, 1u, imu->bus.ctx)) {
        return false;
    }

    // In ±2g High-Resolution 12-bit left-justified mode: 1 LSB (top 12 bits) = 1 mg -> raw_i16 >> 4.
    int16_t rx = (int16_t)((uint16_t)raw[0] | ((uint16_t)raw[1] << 8));
    int16_t ry = (int16_t)((uint16_t)raw[2] | ((uint16_t)raw[3] << 8));
    int16_t rz = (int16_t)((uint16_t)raw[4] | ((uint16_t)raw[5] << 8));

    int16_t x_mg = (int16_t)(rx / 16);
    int16_t y_mg = (int16_t)(ry / 16);
    int16_t z_mg = (int16_t)(rz / 16);

    vernie_imu_process_sample(imu, x_mg, y_mg, z_mg, click_src, tracks_moving, tracks_stalled, now_ms);
    return true;
}

bool vernie_imu_consume_tap_event(vernie_imu_t *imu) {
    if (!imu || !imu->tap_event) {
        return false;
    }
    imu->tap_event = false;
    return true;
}

// ============================================================================
// STM32F070RB SPI1 Low-Level Bus Backend (PA4 CS, PA5-PA7 AF0, 8-bit DR)
// ============================================================================
#ifndef VERNIE_HOST_TEST

#define VERNIE_SPI_TIMEOUT_ITERS (4000u)

static const pbdrv_gpio_t k_spi1_cs   = { .bank = GPIOA, .pin = 4 };
static const pbdrv_gpio_t k_spi1_sck  = { .bank = GPIOA, .pin = 5 };
static const pbdrv_gpio_t k_spi1_miso = { .bank = GPIOA, .pin = 6 };
static const pbdrv_gpio_t k_spi1_mosi = { .bank = GPIOA, .pin = 7 };

static bool g_spi1_initialized = false;

static void stm32_spi1_ensure_init(void) {
    if (g_spi1_initialized) {
        return;
    }
    RCC->AHBENR |= RCC_AHBENR_GPIOAEN;
    RCC->APB2ENR |= RCC_APB2ENR_SPI1EN;

    // Configure PA4-PA7 high-speed OSPEEDR (0b11 per pin) for clean 3 MHz SCK edges.
    GPIOA->OSPEEDR |= (3u << (4u * 2u)) | (3u << (5u * 2u)) |
                      (3u << (6u * 2u)) | (3u << (7u * 2u));

    pbdrv_gpio_out_high(&k_spi1_cs);
    pbdrv_gpio_alt(&k_spi1_sck, 0);
    pbdrv_gpio_alt(&k_spi1_miso, 0);
    pbdrv_gpio_alt(&k_spi1_mosi, 0);

    SPI1->CR1 = 0u;
    // 8-bit data size (DS=0b0111) + FRXTH=1 (8-bit RXNE threshold) mandatory on STM32F0!
    SPI1->CR2 = SPI_CR2_DS_0 | SPI_CR2_DS_1 | SPI_CR2_DS_2 | SPI_CR2_FRXTH;
    // Master, Software NSS + SSI=1 (prevents MODF), Mode 3 (CPOL=1, CPHA=1), /16 = 3 MHz
    SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI |
                SPI_CR1_CPOL | SPI_CR1_CPHA | SPI_CR1_BR_1 | SPI_CR1_BR_0;
    SPI1->CR1 |= SPI_CR1_SPE;
    g_spi1_initialized = true;
}

static void stm32_spi1_drain_rx(void) {
    for (uint8_t i = 0u; i < 8u && (SPI1->SR & SPI_SR_RXNE) != 0u; i++) {
        (void)*(__IO uint8_t *)&SPI1->DR;
    }
}

static bool stm32_spi1_xfer_byte(uint8_t tx, uint8_t *rx_out) {
    uint32_t tries = VERNIE_SPI_TIMEOUT_ITERS;
    while ((SPI1->SR & SPI_SR_TXE) == 0u) {
        if (--tries == 0u) {
            return false;
        }
    }
    // Strict 8-bit DR access! (16-bit write on STM32F0 clocks out 2 bytes!)
    *(__IO uint8_t *)&SPI1->DR = tx;

    tries = VERNIE_SPI_TIMEOUT_ITERS;
    while ((SPI1->SR & SPI_SR_RXNE) == 0u) {
        if (--tries == 0u) {
            return false;
        }
    }
    uint8_t rx = *(__IO uint8_t *)&SPI1->DR;
    if (rx_out) {
        *rx_out = rx;
    }
    return true;
}

static bool stm32_spi1_wait_not_busy(void) {
    uint32_t tries = VERNIE_SPI_TIMEOUT_ITERS;
    while ((SPI1->SR & SPI_SR_BSY) != 0u) {
        if (--tries == 0u) {
            return false;
        }
    }
    return true;
}

static bool stm32_lis3dh_write(uint8_t reg, uint8_t val, void *ctx) {
    (void)ctx;
    stm32_spi1_ensure_init();
    stm32_spi1_drain_rx();
    pbdrv_gpio_out_low(&k_spi1_cs);
    bool ok = stm32_spi1_xfer_byte((uint8_t)(reg & 0x3Fu), NULL) &&
              stm32_spi1_xfer_byte(val, NULL) &&
              stm32_spi1_wait_not_busy();
    pbdrv_gpio_out_high(&k_spi1_cs);
    return ok;
}

static bool stm32_lis3dh_read(uint8_t reg, uint8_t *buf, size_t len, void *ctx) {
    (void)ctx;
    stm32_spi1_ensure_init();
    stm32_spi1_drain_rx();
    uint8_t cmd = (uint8_t)(LIS3DH_SPI_READ | (len > 1u ? LIS3DH_SPI_AUTOINC : 0u) | (reg & 0x3Fu));
    pbdrv_gpio_out_low(&k_spi1_cs);
    bool ok = stm32_spi1_xfer_byte(cmd, NULL);
    for (size_t i = 0u; ok && i < len; i++) {
        ok = stm32_spi1_xfer_byte(0xFFu, &buf[i]);
    }
    ok = ok && stm32_spi1_wait_not_busy();
    pbdrv_gpio_out_high(&k_spi1_cs);
    return ok;
}

vernie_imu_bus_t vernie_imu_stm32_spi1_bus(void) {
    vernie_imu_bus_t bus = {
        .reg_write = stm32_lis3dh_write,
        .reg_read = stm32_lis3dh_read,
        .ctx = NULL,
    };
    return bus;
}
#endif // !VERNIE_HOST_TEST
