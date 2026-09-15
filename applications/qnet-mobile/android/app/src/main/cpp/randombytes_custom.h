#ifndef DILITHIUM_RANDOMBYTES_CUSTOM_H
#define DILITHIUM_RANDOMBYTES_CUSTOM_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Set a 32-byte seed for deterministic key generation (consumed once). */
void dilithium_set_keygen_seed(const uint8_t *seed32);
void dilithium_clear_keygen_seed(void);

#ifdef __cplusplus
}
#endif

#endif /* DILITHIUM_RANDOMBYTES_CUSTOM_H */
