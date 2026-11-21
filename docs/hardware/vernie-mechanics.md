---
type: Hardware Spec
title: Vernie Mechanical & Sensor Profile
description: Mechanical linkages, non-trigger head homing constraints, dart safety lock, and LEGO 88007 Color & Distance Sensor capabilities for Vernie (Set 17101).
resource: ../../firmware/src/vernie_protocol.h
tags: [hardware, vernie, mechanics, safety, sensor-88007]
status: draft
generated: { by: antigravity/1.0, at: 2026-11-21T15:00:00Z }
verified:
  - { by: process:unit-tests, at: 2026-11-21T15:05:00Z }
stale_after: 2027-05-21T00:00:00Z
sources:
  - id: pybricks-colordist
    resource: https://github.com/pybricks/pybricks-micropython/blob/822dbb483421bf0c2d9f10bd6e9c133c6772c0ed/pybricks/pupdevices/pb_type_pupdevices_colordistancesensor.c
    title: Pybricks 88007 Color & Distance Sensor driver (modes SPEC1 & COL_O)
    author: team:pybricks
  - id: lego-boost-17101
    resource: https://www.lego.com/en-us/product/boost-creative-toolbox-17101
    title: LEGO BOOST Creative Toolbox 17101 official model specifications
    author: team:lego
---

# Mechanical Subsystems

- **Tracks (Ports A & B):** Differential caterpillar drive on the [Move Hub](move-hub.md) internal encoded motors.
- **Head, Eyebrows & Shoulder Dart Shooter (External 88008 Motor on Port C or D):**
  - Turning the head mechanically pivots Vernie's eyebrows for expressive poses.[^lego-boost-17101]
  - Over-rotating past the shoulder mechanical stop trips the spring-loaded dart launcher.[^lego-boost-17101]
  - Because the 88008 motor only has a **relative encoder** (resets to `0°` at power-on), homing MUST run **strictly in the single non-trigger direction** at low torque (~25–30%), back off to calibrated center, and clamp normal poses to `[-40°, +35°]`.
  - Dart firing is **disarmed by default on boot** and requires explicit `ARM` + `FIRE` commands carrying magic byte `0xA5` (see [BLE AppData Protocol](../protocol/ble-appdata.md)).
- **Hub Orientation & Pickup Detection:** Empirically verified on Move Hub 88006 silicon: `+Y` (`raw_y_mg ≈ +1000 mg`) points from Ports C/D toward Ports A/B, so official Vernie upright (A/B tracks at bottom, C/D at top) defaults to `-Y` (`VERNIE_IMU_UP_NEG_Y`). On power-on, `vernie_imu.c` automatically locks the resting orthogonal face (`±X/±Y/±Z`) after 8 consecutive calm stationary samples (~160 ms) so both vertical Vernie builds and flat horizontal rovers calibrate to `0° / 0° (UPRIGHT)` automatically, while enabling 3-axis double-tap (`CLICK_CFG = 0x2A`). Manual Remote Cockpit driving (`Mode 4`) is never blocked by IMU orientation; pickup cutout applies only to unattended autonomous Modes 0–3, macros, and dart firing.

# 88007 Color & Distance Sensor Limits

- **Proximity range:** Short-range IR reflection (~5–10 cm effective range; reported 0–100%).[^pybricks-colordist]
- **Combined Sensing Mode:** Use LUMP `SPEC1` (mode 8) for simultaneous color + proximity reads without mode-switch LED flicker.[^pybricks-colordist]
- **Chest LED (`COL_O`, mode 5):** Supports **only 4 discrete states** — `OFF (0)`, `BLUE (3)`, `GREEN (5)`, and `RED (9)` — and is mutually exclusive with active sensing.[^pybricks-colordist]

[^pybricks-colordist]: Pybricks 88007 ColorDistanceSensor LUMP mode implementation
[^lego-boost-17101]: LEGO BOOST 17101 Vernie model hardware overview
