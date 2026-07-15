/**
 * randombytes_ios.c
 * Implements PQCLEAN_randombytes for iOS with optional seeded determinism.
 * Uses SecRandomCopyBytes (Security.framework) for cryptographically secure
 * random bytes. /dev/urandom is also available on iOS but SecRandomCopyBytes
 * is the Apple-recommended API and passes App Store review.
 *
 * Mirrors randombytes_custom.c (Android) — same seed/clear contract.
 */
#include "randombytes_custom.h"
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <Security/SecRandom.h>

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
int PQCLEAN_randombytes(uint8_t *output, size_t n) {
    if (g_has_seed && n == 32) {
        memcpy(output, g_seed, 32);
        g_has_seed = 0;   /* one-shot: armed only right before keygen (set_keygen_seed);
                             signing's rnd (also n=32) runs after this clears, so it
                             always draws fresh randomness, never the keygen seed. */
        return 0;
    }
    /* SecRandomCopyBytes: Apple-approved CSPRNG, backed by /dev/random on iOS */
    int result = SecRandomCopyBytes(kSecRandomDefault, n, output);
    return (result == errSecSuccess) ? 0 : -1;
}
