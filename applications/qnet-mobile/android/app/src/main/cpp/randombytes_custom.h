#ifndef DILITHIUM_RANDOMBYTES_CUSTOM_H
#define DILITHIUM_RANDOMBYTES_CUSTOM_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Set a 32-byte seed for deterministic key generation (consumed once). Call under dilithium_lock. */
void dilithium_set_keygen_seed(const uint8_t *seed32);
void dilithium_clear_keygen_seed(void);

/* One lock across seed/keygen/clear and every signature. */
void dilithium_lock(void);
void dilithium_unlock(void);

/* Zeroing that is never optimised away. */
void dilithium_secure_zero(void *p, size_t n);

/* Overwrites the stack region the last keypair or signature used (its frames and those of every function it
 * called), right after it returns and under the same lock. */
void dilithium_burn_stack(void);

#ifdef __cplusplus
}
#endif

#endif /* DILITHIUM_RANDOMBYTES_CUSTOM_H */
