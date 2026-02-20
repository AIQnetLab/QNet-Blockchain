/**
 * randombytes_custom.c
 * Implements PQCLEAN_randombytes for Android with optional seeded determinism.
 * This replaces pqclean/common/randombytes.c in the build.
 */
#include "common/fips202.h"    /* shake256 — available already */
#include "randombytes_custom.h"
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>

/* -------- seed state (single-threaded from RN bridge) -------- */
static int     g_has_seed = 0;
static uint8_t g_seed[32];

void dilithium_set_keygen_seed(const uint8_t *seed32) {
    memcpy(g_seed, seed32, 32);
    g_has_seed = 1;
}

void dilithium_clear_keygen_seed(void) {
    g_has_seed = 0;
    memset(g_seed, 0, 32);
}

/* -------- PQCLEAN_randombytes -------- */
/* pqclean declares:  #define randombytes  PQCLEAN_randombytes
 * in common/randombytes.h.  We provide the implementation here. */
int PQCLEAN_randombytes(uint8_t *output, size_t n) {
    if (g_has_seed && n == 32) {
        memcpy(output, g_seed, 32);
        g_has_seed = 0;   /* consume once — only keygen calls this with n=32 */
        return 0;
    }
    /* /dev/urandom is always available on Android */
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return -1;
    size_t done = 0;
    while (done < n) {
        ssize_t r = read(fd, output + done, n - done);
        if (r <= 0) { close(fd); return -1; }
        done += (size_t)r;
    }
    close(fd);
    return 0;
}
