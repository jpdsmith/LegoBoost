// SPDX-License-Identifier: MIT
// Layer 3 Host Unit Tests (ASan + UBSan) for freestanding string_minimal.c primitives.
// Symbols are prefixed to avoid colliding with ASan libc interceptors while compiling
// the exact implementation from ../src/string_minimal.c.

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define memcpy  vernie_memcpy
#define memmove vernie_memmove
#define memset  vernie_memset
#define memcmp  vernie_memcmp
#define strlen  vernie_strlen
#define strcpy  vernie_strcpy
#define strncpy vernie_strncpy
#define strcat  vernie_strcat
#define strcmp  vernie_strcmp

#include "../src/string_minimal.c"

#undef memcpy
#undef memmove
#undef memset
#undef memcmp
#undef strlen
#undef strcpy
#undef strncpy
#undef strcat
#undef strcmp

static void test_memcpy_and_memset(void) {
    uint8_t src[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
    uint8_t dst[8] = { 0 };
    assert(vernie_memcpy(dst, src, 0) == dst);
    assert(dst[0] == 0);
    assert(vernie_memcpy(dst, src, 8) == dst);
    assert(vernie_memcmp(dst, src, 8) == 0);

    // memset with n=0 and c > 255 (must mask to uint8_t)
    assert(vernie_memset(dst, 0x1AB, 0) == dst);
    assert(dst[0] == 1);
    assert(vernie_memset(dst, 0x1AB, 5) == dst);
    for (size_t i = 0; i < 5; i++) {
        assert(dst[i] == 0xAB);
    }
    assert(dst[5] == 6);
}

static void test_memmove_overlapping(void) {
    char buf1[16] = "abcdefghij";
    // Overlap forward (dst > src)
    assert(vernie_memmove(buf1 + 2, buf1, 8) == buf1 + 2);
    assert(vernie_strcmp(buf1, "ababcdefgh") == 0);

    // Overlap backward (dst < src)
    char buf2[16] = "abcdefghij";
    assert(vernie_memmove(buf2, buf2 + 2, 8) == buf2);
    assert(vernie_memcmp(buf2, "cdefghijij", 10) == 0);

    // Equal pointers and n=0
    assert(vernie_memmove(buf2, buf2, 5) == buf2);
    assert(vernie_memmove(buf2, buf2 + 1, 0) == buf2);
}

static void test_memcmp_and_strcmp_unsigned(void) {
    // Unsigned byte ordering: 0x80 > 0x7F (must be > 0, never negative!)
    const uint8_t hi[2] = { 0x01, 0x80 };
    const uint8_t lo[2] = { 0x01, 0x7F };
    assert(vernie_memcmp(hi, lo, 2) > 0);
    assert(vernie_memcmp(lo, hi, 2) < 0);
    assert(vernie_memcmp(hi, lo, 1) == 0);
    assert(vernie_memcmp(hi, lo, 0) == 0);

    const char s_hi[3] = { 'A', (char)0x80, '\0' };
    const char s_lo[3] = { 'A', (char)0x7F, '\0' };
    assert(vernie_strcmp(s_hi, s_lo) > 0);
    assert(vernie_strcmp(s_lo, s_hi) < 0);
    assert(vernie_strcmp("VernieOS", "VernieOS") == 0);
    assert(vernie_strcmp("Vernie", "VernieOS") < 0);
}

static void test_string_ops(void) {
    assert(vernie_strlen("") == 0);
    assert(vernie_strlen("VernieOS") == 8);

    char buf[16];
    assert(vernie_strcpy(buf, "Vernie") == buf);
    assert(vernie_strcmp(buf, "Vernie") == 0);

    assert(vernie_strcat(buf, "OS") == buf);
    assert(vernie_strcmp(buf, "VernieOS") == 0);

    // strncpy padding with trailing NULs
    vernie_memset(buf, 'X', sizeof(buf));
    assert(vernie_strncpy(buf, "Hi", 6) == buf);
    assert(buf[0] == 'H' && buf[1] == 'i' && buf[2] == '\0' && buf[3] == '\0' && buf[4] == '\0' && buf[5] == '\0');
    assert(buf[6] == 'X');

    // strncpy truncation (no NUL written past n)
    vernie_memset(buf, 'Z', sizeof(buf));
    assert(vernie_strncpy(buf, "VernieOS", 4) == buf);
    assert(vernie_memcmp(buf, "VernZ", 5) == 0);
}

int main(void) {
    test_memcpy_and_memset();
    test_memmove_overlapping();
    test_memcmp_and_strcmp_unsigned();
    test_string_ops();
    printf("ALL STRING MINIMAL C UNIT TESTS PASSED.\n");
    return 0;
}
