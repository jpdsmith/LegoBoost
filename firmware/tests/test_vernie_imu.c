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

    // Valid init writes 200 Hz ODR, HPCLICK, BDU+HR, 3-axis CLICK_CFG (0x2A), and LIR_CLICK!
    m.force_timeout = false;
    assert(vernie_imu_init(&imu, &bus, 0, 0));
    assert(imu.ready);
    assert(imu.up_axis == VERNIE_IMU_UP_NEG_Y);
    assert(m.regs[LIS3DH_REG_CTRL_REG1] == 0x67u);
    assert((m.regs[LIS3DH_REG_CTRL_REG2] & 0x04u) != 0u); // HPCLICK=1
    assert(m.regs[LIS3DH_REG_CLICK_CFG] == 0x2Au);        // XD | YD | ZD
    assert((m.regs[LIS3DH_REG_CLICK_THS] & 0x80u) != 0u); // LIR_CLICK=1

    // Poll returns false cleanly on SPI timeout.
    m.force_timeout = true;
    assert(!vernie_imu_poll(&imu, false, false, 100u));
}

static void test_upright_torso_frame_and_pickup(void) {
    vernie_imu_t imu;
    memset(&imu, 0, sizeof(imu));

    // Official Vernie upright (A/B bottom, C/D top): raw_y = -1000 mg -> pitch == 0, roll == 0!
    // Feed 8 calm samples at boot so orient_locked latches VERNIE_IMU_UP_NEG_Y.
    for (uint32_t i = 0u; i < VERNIE_IMU_ORIENT_CALM_SAMPLES; i++) {
        vernie_imu_process_sample(&imu, 0, -1000, 0, 0u, false, false, 20u * (i + 1u));
    }
    assert(imu.orient_locked && imu.up_axis == VERNIE_IMU_UP_NEG_Y);
    assert(imu.pitch_deg == 0 && imu.roll_deg == 0);
    assert(!imu.picked_up);

    // Tilt forward 45 deg (raw_y = -707, raw_z = +707) -> pitch ~45 > 35 -> picked_up!
    vernie_imu_process_sample(&imu, 0, -707, 707, 0u, false, false, 300u);
    assert(imu.pitch_deg >= 43 && imu.pitch_deg <= 47);
    assert(imu.picked_up);

    // Set back upright: hysteresis holds picked_up until calm for 300 ms.
    vernie_imu_process_sample(&imu, 0, -1000, 0, 0u, false, false, 500u);
    assert(imu.picked_up);
    vernie_imu_process_sample(&imu, 0, -1000, 0, 0u, false, false, 600u);
    assert(!imu.picked_up);

    // Sustained vertical lift impulse (-1600 mg on Y for >= 120 ms) while upright -> picked_up!
    vernie_imu_process_sample(&imu, 0, -1600, 0, 0u, false, false, 700u);
    assert(!imu.picked_up);
    vernie_imu_process_sample(&imu, 0, -1600, 0, 0u, false, false, 820u);
    assert(imu.picked_up);
}

static void test_boot_auto_orientation_for_flat_rover_and_inverted_vertical(void) {
    // 1. Flat horizontal 4-wheel rover resting on carpet (raw_z = +1000 mg):
    //    NEVER triggers spurious pickup while settling, locks VERNIE_IMU_UP_POS_Z at sample 8!
    vernie_imu_t flat;
    memset(&flat, 0, sizeof(flat));
    for (uint32_t i = 0u; i < VERNIE_IMU_ORIENT_CALM_SAMPLES; i++) {
        vernie_imu_process_sample(&flat, 10, -15, 1000, 0u, false, false, 20u * (i + 1u));
        assert(!flat.picked_up);
    }
    assert(flat.orient_locked && flat.up_axis == VERNIE_IMU_UP_POS_Z);
    assert(flat.pitch_deg >= -2 && flat.pitch_deg <= 2);
    assert(flat.roll_deg >= -2 && flat.roll_deg <= 2);
    assert(!flat.picked_up);

    // Once locked flat, tilting the rover 45 deg triggers picked_up properly!
    vernie_imu_process_sample(&flat, 0, 707, 707, 0u, false, false, 500u);
    assert(flat.picked_up);

    // 2. Inverted vertical (A/B top, C/D bottom, raw_y = +1000 mg): locks VERNIE_IMU_UP_POS_Y!
    vernie_imu_t inv;
    memset(&inv, 0, sizeof(inv));
    for (uint32_t i = 0u; i < VERNIE_IMU_ORIENT_CALM_SAMPLES; i++) {
        vernie_imu_process_sample(&inv, 0, 1000, 0, 0u, false, false, 20u * (i + 1u));
    }
    assert(inv.orient_locked && inv.up_axis == VERNIE_IMU_UP_POS_Y);
    assert(!inv.picked_up);

    // 3. Held tilted at 45 deg in mid-air at boot: MUST NOT lock orientation, triggers picked_up!
    vernie_imu_t air;
    memset(&air, 0, sizeof(air));
    for (uint32_t i = 0u; i < 12u; i++) {
        vernie_imu_process_sample(&air, 0, 707, 707, 0u, false, false, 20u * (i + 1u));
    }
    assert(!air.orient_locked);
    assert(air.picked_up);
}

static void test_stationary_double_tap_and_bump_stall_fusion(void) {
    vernie_imu_t imu;
    memset(&imu, 0, sizeof(imu));
    imu.orient_locked = true;
    imu.up_axis = VERNIE_IMU_UP_NEG_Y;

    // While tracks are moving: double-tap MUST be suppressed!
    vernie_imu_process_sample(&imu, 0, -1000, 0, LIS3DH_CLICK_SRC_DCLICK, true, false, 1000u);
    assert(!vernie_imu_consume_tap_event(&imu));

    // 100 ms after stopping (< 250 ms): STILL suppressed!
    vernie_imu_process_sample(&imu, 0, -1000, 0, LIS3DH_CLICK_SRC_DCLICK, false, false, 1100u);
    assert(!vernie_imu_consume_tap_event(&imu));

    // 260 ms after stopping (>= 250 ms): valid double-tap fires once!
    vernie_imu_process_sample(&imu, 0, -1000, 0, LIS3DH_CLICK_SRC_DCLICK, false, false, 1260u);
    assert(vernie_imu_consume_tap_event(&imu));
    assert(!vernie_imu_consume_tap_event(&imu));

    // Bump fusion: sharp deceleration spike while driving triggers bump_detected!
    vernie_imu_process_sample(&imu, 0, -1000, 0, 0u, true, false, 2000u);
    assert(!imu.bump_detected);
    vernie_imu_process_sample(&imu, 0, -1000, -750, 0u, true, false, 2020u);
    assert(imu.bump_detected);
    // Clears 300 ms later.
    vernie_imu_process_sample(&imu, 0, -1000, 0, 0u, false, false, 2320u);
    assert(!imu.bump_detected);

    // Stall fusion: motor stall triggers bump_detected even with zero accel spike!
    vernie_imu_process_sample(&imu, 0, -1000, 0, 0u, true, true, 2400u);
    assert(imu.bump_detected);
}

int main(void) {
    test_init_registers_and_timeout();
    test_upright_torso_frame_and_pickup();
    test_boot_auto_orientation_for_flat_rover_and_inverted_vertical();
    test_stationary_double_tap_and_bump_stall_fusion();
    printf("ALL VERNIE IMU C UNIT TESTS PASSED.\n");
    return 0;
}
