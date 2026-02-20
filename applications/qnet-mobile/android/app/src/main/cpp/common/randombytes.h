#ifndef PQCLEAN_RANDOMBYTES_H
#define PQCLEAN_RANDOMBYTES_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <stddef.h>

/*
 * Write `n` bytes of high quality random bytes to `buf`
 * Implementation is in randombytes_custom.c (deterministic for key generation,
 * /dev/urandom otherwise).
 */
#define randombytes     PQCLEAN_randombytes
int randombytes(uint8_t *output, size_t n);

#ifdef __cplusplus
}
#endif

#endif /* PQCLEAN_RANDOMBYTES_H */

