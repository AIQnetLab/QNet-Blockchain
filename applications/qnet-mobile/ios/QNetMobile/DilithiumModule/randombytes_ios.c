/**
 * randombytes_ios.c
 * Implements PQCLEAN_randombytes for iOS with optional seeded determinism.
 * Uses SecRandomCopyBytes (Security.framework) for cryptographically secure
 * random bytes. /dev/urandom is also available on iOS but SecRandomCopyBytes
 * is the Apple-recommended API and passes App Store review.
 *
 * Mirrors randombytes_custom.c (Android) — same seed/clear contract, and the same single lock across
 * seed/keygen/clear and every signature.
 */
#include "randombytes_custom.h"
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <pthread.h>
#include <Security/SecRandom.h>

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int     g_has_seed = 0;
static uint8_t g_seed[32];

void dilithium_lock(void)   { pthread_mutex_lock(&g_lock); }
void dilithium_unlock(void) { pthread_mutex_unlock(&g_lock); }

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
int PQCLEAN_randombytes(uint8_t *output, size_t n) {
    if (g_has_seed && n == 32) {
        memcpy(output, g_seed, 32);
        g_has_seed = 0;   /* one-shot: armed only right before keygen (set_keygen_seed);
                             signing's rnd (also n=32) runs after this clears, so it
                             always draws fresh randomness, never the keygen seed. */
        dilithium_secure_zero(g_seed, sizeof(g_seed));
        return 0;
    }
    /* SecRandomCopyBytes: Apple-approved CSPRNG, backed by /dev/random on iOS */
    int result = SecRandomCopyBytes(kSecRandomDefault, n, output);
    return (result == errSecSuccess) ? 0 : -1;
}
