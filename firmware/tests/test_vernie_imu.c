// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for Native SPI1 LIS3DH IMU Driver (vernie_imu.c).
// Covers T3.10 (init regs & SPI timeout), T3.11 (upright Vernie torso & pickup),
// T3.12 (stationary-gated double-tap), and T3.13 (bump + stall fusion).

#include "vernie_imu.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    uint8_t regs[64];
    bool force_timeout;
    uint8_t raw_xyz[6];
    uint8_t click_src;
} mock_lis3dh_t;

static bool mock_reg_write(uint8_t reg, uint8_t val, void *ctx) {
    mock_lis3dh_t *m = (mock_lis3dh_t *)ctx;
    if (m->force_timeout) return false;
    if (reg < sizeof(m->regs)) m->regs[reg] = val;
    return true;
}

static bool mock_reg_read(uint8_t reg, uint8_t *buf, size_t len, void *ctx) {
    mock_lis3dh_t *m = (mock_lis3dh_t *)ctx;
    if (m->force_timeout) return false;
    if (reg == LIS3DH_REG_WHO_AM_I && len == 1u) {
        buf[0] = m->regs[LIS3DH_REG_WHO_AM_I];
        return true;
    }
    if (reg == LIS3DH_REG_OUT_X_L && len == 6u) {
        memcpy(buf, m->raw_xyz, 6u);
        return true;
    }
    if (reg == LIS3DH_REG_CLICK_SRC && len == 1u) {
        buf[0] = m->click_src;
        m->click_src = 0u; // LIR_CLICK clears on read
        return true;
    }
    return false;
}

static void test_init_registers_and_timeout(void) {
    mock_lis3dh_t m;
    memset(&m, 0, sizeof(m));
    vernie_imu_bus_t bus = { .reg_write = mock_reg_write, .reg_read = mock_reg_read, .ctx = &m };
    vernie_imu_t imu;

    // Wrong WHO_AM_I fails cleanly.
    m.regs[LIS3DH_REG_WHO_AM_I] = 0xFFu;
    assert(!vernie_imu_init(&imu, &bus, 0, 0));
    assert(!imu.ready);

    // Timeout fails cleanly without hanging.
    m.regs[LIS3DH_REG_WHO_AM_I] = LIS3DH_WHO_AM_I_VAL;
    m.force_timeout = true;
    assert(!vernie_imu_init(&imu, &bus, 0, 0));

    // Valid init writes 200 Hz ODR, HPCLICK, BDU+HR, and LIR_CLICK!
    m.force_timeout = false;
    assert(vernie_imu_init(&imu, &bus, 0, 0));
    assert(imu.ready);
    assert(m.regs[LIS3DH_REG_CTRL_REG1] == 0x67u);
    assert((m.regs[LIS3DH_REG_CTRL_REG2] & 0x04u) != 0u); // HPCLICK=1
    assert((m.regs[LIS3DH_REG_CLICK_THS] & 0x80u) != 0u); // LIR_CLICK=1

    // Poll returns false cleanly on SPI timeout.
    m.force_timeout = true;
    assert(!vernie_imu_poll(&imu, false, false, 100u));
}

static void test_upright_torso_frame_and_pickup(void) {
    vernie_imu_t imu;
    memset(&imu, 0, sizeof(imu));

    // Standing vertically upright inside Vernie: raw_y = +1000 mg, x=0, z=0 -> pitch == 0, roll == 0!
    vernie_imu_process_sample(&imu, 0, 1000, 0, 0u, false, false, 100u);
    assert(imu.pitch_deg == 0 && imu.roll_deg == 0);
    assert(!imu.picked_up);

    // Tilt forward 45 deg (raw_y = +707, raw_z = +707) -> pitch ~45 > 35 -> picked_up!
    vernie_imu_process_sample(&imu, 0, 707, 707, 0u, false, false, 200u);
    assert(imu.pitch_deg >= 43 && imu.pitch_deg <= 47);
    assert(imu.picked_up);

    // Set back upright: hysteresis holds picked_up until calm for 300 ms.
    vernie_imu_process_sample(&imu, 0, 1000, 0, 0u, false, false, 400u);
    assert(imu.picked_up);
    vernie_imu_process_sample(&imu, 0, 1000, 0, 0u, false, false, 500u);
    assert(!imu.picked_up);

    // Sustained vertical lift impulse (+1600 mg on Y for >= 120 ms) while upright -> picked_up!
    vernie_imu_process_sample(&imu, 0, 1600, 0, 0u, false, false, 600u);
    assert(!imu.picked_up);
    vernie_imu_process_sample(&imu, 0, 1600, 0, 0u, false, false, 720u);
    assert(imu.picked_up);
}

static void test_stationary_double_tap_and_bump_stall_fusion(void) {
    vernie_imu_t imu;
    memset(&imu, 0, sizeof(imu));

    // While tracks are moving: double-tap MUST be suppressed!
    vernie_imu_process_sample(&imu, 0, 1000, 0, LIS3DH_CLICK_SRC_DCLICK, true, false, 1000u);
    assert(!vernie_imu_consume_tap_event(&imu));

    // 100 ms after stopping (< 250 ms): STILL suppressed!
    vernie_imu_process_sample(&imu, 0, 1000, 0, LIS3DH_CLICK_SRC_DCLICK, false, false, 1100u);
    assert(!vernie_imu_consume_tap_event(&imu));

    // 260 ms after stopping (>= 250 ms): valid double-tap fires once!
    vernie_imu_process_sample(&imu, 0, 1000, 0, LIS3DH_CLICK_SRC_DCLICK, false, false, 1260u);
    assert(vernie_imu_consume_tap_event(&imu));
    assert(!vernie_imu_consume_tap_event(&imu));

    // Bump fusion: sharp deceleration spike while driving triggers bump_detected!
    vernie_imu_process_sample(&imu, 0, 1000, 0, 0u, true, false, 2000u);
    assert(!imu.bump_detected);
    vernie_imu_process_sample(&imu, 0, 1000, -750, 0u, true, false, 2020u);
    assert(imu.bump_detected);
    // Clears 300 ms later.
    vernie_imu_process_sample(&imu, 0, 1000, 0, 0u, false, false, 2320u);
    assert(!imu.bump_detected);

    // Stall fusion: motor stall triggers bump_detected even with zero accel spike!
    vernie_imu_process_sample(&imu, 0, 1000, 0, 0u, true, true, 2400u);
    assert(imu.bump_detected);
}

int main(void) {
    test_init_registers_and_timeout();
    test_upright_torso_frame_and_pickup();
    test_stationary_double_tap_and_bump_stall_fusion();
    printf("ALL VERNIE IMU C UNIT TESTS PASSED.\n");
    return 0;
}
