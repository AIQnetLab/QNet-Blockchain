/**
 * randombytes_custom.c
 * Implements PQCLEAN_randombytes for Android with optional seeded determinism.
 * This replaces pqclean/common/randombytes.c in the build.
 *
 * Deterministic keygen arms a one-shot seed that the next 32-byte randombytes call consumes. Signing draws
 * its 32-byte rnd from the same function, so every keygen (arm, keygen, clear) and every signature runs under
 * one lock: nothing else can consume or overwrite the seed in between.
 */
#include "common/fips202.h"    /* shake256 — available already */
#include "randombytes_custom.h"
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <pthread.h>

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int     g_has_seed = 0;
static uint8_t g_seed[32];

void dilithium_lock(void)   { pthread_mutex_lock(&g_lock); }
void dilithium_unlock(void) { pthread_mutex_unlock(&g_lock); }

/* A zeroing the compiler may not drop as a dead store. */
void dilithium_secure_zero(void *p, size_t n) {
    volatile uint8_t *v = (volatile uint8_t *)p;
    while (n--) *v++ = 0;
}

/* ML-DSA-65 signing keeps about 80 KiB of locals (the expanded matrix, s1, s2, t0, y, z, w0, w1, h). */
#define DILITHIUM_BURN_BYTES (128 * 1024)

__attribute__((noinline)) void dilithium_burn_stack(void) {
    volatile uint8_t burn[DILITHIUM_BURN_BYTES];
    for (size_t i = 0; i < sizeof(burn); i++) burn[i] = 0;
}

void dilithium_set_keygen_seed(const uint8_t *seed32) {
    memcpy(g_seed, seed32, 32);
    g_has_seed = 1;
}

void dilithium_clear_keygen_seed(void) {
    g_has_seed = 0;
    dilithium_secure_zero(g_seed, sizeof(g_seed));
}

/* -------- PQCLEAN_randombytes -------- */
/* pqclean declares:  #define randombytes  PQCLEAN_randombytes
 * in common/randombytes.h.  We provide the implementation here. */
int PQCLEAN_randombytes(uint8_t *output, size_t n) {
    if (g_has_seed && n == 32) {
        memcpy(output, g_seed, 32);
        g_has_seed = 0;   /* one-shot: armed only right before keygen (set_keygen_seed);
                             signing's rnd (also n=32) runs after this clears, so it
                             always draws fresh randomness, never the keygen seed. */
        dilithium_secure_zero(g_seed, sizeof(g_seed));
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
