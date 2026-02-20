/**
 * randombytes_custom.h
 * Shared header for iOS and Android custom randombytes implementations.
 */
#ifndef RANDOMBYTES_CUSTOM_H
#define RANDOMBYTES_CUSTOM_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Set a 32-byte deterministic seed for the next keygen call (consumed once). */
void dilithium_set_keygen_seed(const uint8_t *seed32);

/** Clear the seed from memory after use. */
void dilithium_clear_keygen_seed(void);

/** PQCLEAN random bytes provider. */
int PQCLEAN_randombytes(uint8_t *output, size_t n);

#ifdef __cplusplus
}
#endif

#endif /* RANDOMBYTES_CUSTOM_H */
