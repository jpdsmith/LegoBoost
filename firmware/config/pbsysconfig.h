// SPDX-License-Identifier: MIT
// Vernie OS pbsys configuration for LEGO BOOST Move Hub.
// Key overrides vs upstream Pybricks:
//   - PBSYS_CONFIG_TELEMETRY = 0 (strictly pure-MIT build; excludes non-free telemetry.c)
//   - PBSYS_CONFIG_STORAGE = 0 (keeps bootloader-checked FLASH_USER_0 untouched)
//   - PBSYS_CONFIG_HMI_NONE = 1 (auto-boots straight into Vernie OS without button wait)
//   - PBSYS_CONFIG_STATUS_LIGHT_BATTERY = 0 (Move Hub has a single RGB LED; no charger LED)
//   - PBSYS_CONFIG_STATUS_LIGHT_STATE_ANIMATIONS = 1 (restores 2s-hold shutdown blink)

#ifndef _VERNIE_PBSYSCONFIG_H_
#define _VERNIE_PBSYSCONFIG_H_

#include "pbdrvconfig.h"

#define PBSYS_CONFIG_FEATURE_BUILTIN_USER_PROGRAM_REPL             (0)
#define PBSYS_CONFIG_FEATURE_BUILTIN_USER_PROGRAM_PORT_VIEW        (0)
#define PBSYS_CONFIG_FEATURE_BUILTIN_USER_PROGRAM_IMU_CALIBRATION  (0)
#define PBSYS_CONFIG_FEATURE_PROGRAM_FORMAT_MULTI_MPY_V6           (0)
#define PBSYS_CONFIG_FEATURE_PROGRAM_FORMAT_MULTI_MPY_V6_3_NATIVE  (0)

#define PBSYS_CONFIG_BATTERY                                       (1)
#define PBSYS_CONFIG_BATTERY_CHARGER                               (0)

#define PBSYS_CONFIG_HMI                                           (1)
#define PBSYS_CONFIG_HMI_STOP_BUTTON                               (1 << 5) // PBIO_BUTTON_CENTER
#define PBSYS_CONFIG_HMI_NONE                                      (1)
#define PBSYS_CONFIG_HMI_PUP                                       (0)
#define PBSYS_CONFIG_HMI_NUM_SLOTS                                 (0)

#define PBSYS_CONFIG_HUB_LIGHT_MATRIX                              (0)

#define PBSYS_CONFIG_HOST                                          (1)
#define PBSYS_CONFIG_HOST_EVENT_OUT_SIZE                           (PBDRV_CONFIG_BLUETOOTH_MAX_MTU_SIZE - 3)
#define PBSYS_CONFIG_HUB_TYPE_STR                                  "BOOST Move Hub"

#define PBSYS_CONFIG_MAIN                                          (1)

// Disabled: Vernie OS stores calibration & macros in unchecked FLASH_USER_1 with CRC32.
#define PBSYS_CONFIG_STORAGE                                       (0)
#define PBSYS_CONFIG_STORAGE_NUM_SLOTS                             (0)
#define PBSYS_CONFIG_STORAGE_USER_DATA_SIZE                        (0)

#define PBSYS_CONFIG_STATUS_LIGHT                                  (1)
#define PBSYS_CONFIG_STATUS_LIGHT_BATTERY                          (0)
#define PBSYS_CONFIG_STATUS_LIGHT_BLUETOOTH                        (0)
#define PBSYS_CONFIG_STATUS_LIGHT_STATE_ANIMATIONS                 (1)
#define PBSYS_CONFIG_STATUS_LIGHT_STATE_ANIMATIONS_HUE             (240)

// MUST stay 0: upstream lib/pbio/sys/telemetry.c is non-free (All rights reserved).
#define PBSYS_CONFIG_TELEMETRY                                     (0)

#define PBSYS_CONFIG_USER_PROGRAM                                  (1)
#define PBSYS_CONFIG_PROGRAM_STOP                                  (1)

#endif // _VERNIE_PBSYSCONFIG_H_
