/* SPDX-License-Identifier: MIT */
/* Vernie OS GNU linker script for LEGO BOOST Move Hub (STM32F070RB).
 *
 * Memory layout matches LEGO's non-erasable BLE bootloader:
 *   0x08000000 - 0x08004FFF (20 KB): Bootloader (write-protected)
 *   0x08005000 - 0x0801EFFF (104 KB): Firmware slot (covered by bootloader zero-sum check)
 *   0x0801F000 - 0x0801F7FF (2 KB): FLASH_USER_0 (covered by checksum — KEPT ERASED!)
 *   0x0801F800 - 0x0801FFFF (2 KB): FLASH_USER_1 (unchecked — Vernie OS persistent storage)
 *   0x20000000 - 0x20003FFF (16 KB): SRAM
 */

MEMORY
{
    FLASH_BOOTLOADER (rx) : ORIGIN = 0x08000000, LENGTH = 20K
    FLASH_FIRMWARE (rx)   : ORIGIN = 0x08005000, LENGTH = 104K
    FLASH_USER_0 (rx)     : ORIGIN = 0x0801F000, LENGTH = 2K
    FLASH_USER_1 (rx)     : ORIGIN = 0x0801F800, LENGTH = 2K
    RAM (xrw)             : ORIGIN = 0x20000000, LENGTH = 16K
}

"MAGIC_OFFSET" = 0x100;

/* Minimal stack size verified at link time. */
_minimal_stack_size = 3K;

/* Unchecked user flash page for Vernie OS calibration & macros (Phase 2+). */
_vernie_storage_start = ORIGIN(FLASH_USER_1);
_vernie_storage_size  = LENGTH(FLASH_USER_1);

/* Symbols expected by pbsys_storage_get_program_data() when PBSYS_CONFIG_STORAGE=0. */
pbsys_storage_heap_start = _ebss;
pbsys_storage_heap_end   = pbdrv_stack_start;
