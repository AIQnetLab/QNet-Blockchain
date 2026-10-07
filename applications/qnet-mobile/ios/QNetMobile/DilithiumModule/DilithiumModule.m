/**
 * DilithiumModule.m
 * React Native native module for iOS — Dilithium3 (ML-DSA-65) post-quantum signatures.
 *
 * Mirrors Android DilithiumModule.kt. All methods, return shapes, and binary
 * formats are byte-identical so JS code (DilithiumCrypto.js) works unchanged.
 *
 * C sources included in the Xcode build target:
 *   DilithiumModule/mldsa65/*.c
 *   DilithiumModule/common/fips202.c
 *   DilithiumModule/randombytes_ios.c
 *
 * Key sizes (ML-DSA-65 / FIPS-204 final):
 *   Public key : 1952 bytes
 *   Secret key : 4032 bytes
 *   Signature  : 3309 bytes
 *
 * Keygen and signing run under one lock (randombytes_ios.c). Native buffers that held a seed or a secret key
 * are zeroed before they go out of scope, PQClean wipes its own secret locals (sign.c), and the stack a keypair
 * or signature used is overwritten before the lock is released. The NSString the key arrives in (hex, from JS)
 * is immutable and cannot be wiped here. The self-test runs in debug builds only.
 */

#import "DilithiumModule.h"
#import <React/RCTLog.h>
#import <Foundation/Foundation.h>

/* PQClean ML-DSA-65 C API (byte-identical to the node's pqcrypto-mldsa) */
#include "mldsa65/api.h"
#include "mldsa65/sign.h"
#include "common/fips202.h"
#include "randombytes_custom.h"

#include <string.h>
#include <stdlib.h>

#define DILITHIUM_PK_SIZE  PQCLEAN_MLDSA65_CLEAN_CRYPTO_PUBLICKEYBYTES  /* 1952 */
#define DILITHIUM_SK_SIZE  PQCLEAN_MLDSA65_CLEAN_CRYPTO_SECRETKEYBYTES  /* 4032 */
#define DILITHIUM_SIG_SIZE PQCLEAN_MLDSA65_CLEAN_CRYPTO_BYTES           /* 3309 */

/* ---- Hex helpers ---- */

static NSString *bytesToHex(const uint8_t *bytes, size_t len) {
    NSMutableString *hex = [NSMutableString stringWithCapacity:len * 2];
    for (size_t i = 0; i < len; i++) {
        [hex appendFormat:@"%02x", bytes[i]];
    }
    return hex;
}

static BOOL hexToBytes(NSString *hex, uint8_t *out, size_t expected_len) {
    if (hex.length != expected_len * 2) return NO;
    const char *str = hex.UTF8String;
    for (size_t i = 0; i < expected_len; i++) {
        char hi = str[2*i], lo = str[2*i+1];
        int h = (hi >= '0' && hi <= '9') ? hi-'0' :
                (hi >= 'a' && hi <= 'f') ? hi-'a'+10 :
                (hi >= 'A' && hi <= 'F') ? hi-'A'+10 : -1;
        int l = (lo >= '0' && lo <= '9') ? lo-'0' :
                (lo >= 'a' && lo <= 'f') ? lo-'a'+10 :
                (lo >= 'A' && lo <= 'F') ? lo-'A'+10 : -1;
        if (h < 0 || l < 0) return NO;
        out[i] = (uint8_t)((h << 4) | l);
    }
    return YES;
}

/* ---- 4-byte little-endian write ---- */
static void writeU32LE(uint8_t *buf, uint32_t value) {
    buf[0] = (uint8_t)(value & 0xFF);
    buf[1] = (uint8_t)((value >> 8)  & 0xFF);
    buf[2] = (uint8_t)((value >> 16) & 0xFF);
    buf[3] = (uint8_t)((value >> 24) & 0xFF);
}

/** The 4032-byte secret key from its hex; anything else is refused (no re-derivation from a string). */
static BOOL secretKeyFromHex(NSString *secretKeyHex, uint8_t sk[DILITHIUM_SK_SIZE]) {
    if (secretKeyHex.length != DILITHIUM_SK_SIZE * 2 || !hexToBytes(secretKeyHex, sk, DILITHIUM_SK_SIZE)) {
        dilithium_secure_zero(sk, DILITHIUM_SK_SIZE);
        return NO;
    }
    return YES;
}

@implementation DilithiumModule

RCT_EXPORT_MODULE(DilithiumModule)

/** All methods run on one serial queue; the C lock covers anything else that reaches the library. */
- (dispatch_queue_t)methodQueue {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("com.qnetmobile.dilithium", DISPATCH_QUEUE_SERIAL); });
    return queue;
}

/** SHAKE-256 of the seed string's UTF-8, copied into a buffer of our own that is wiped (no NSData copy). */
static BOOL seed32FromString(NSString *seed, uint8_t seed32[32]) {
    NSUInteger max = [seed lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if (max == 0) return NO;
    uint8_t *buf = (uint8_t *)malloc(max);
    if (!buf) return NO;
    NSUInteger used = 0;
    BOOL ok = [seed getBytes:buf maxLength:max usedLength:&used encoding:NSUTF8StringEncoding
                     options:0 range:NSMakeRange(0, seed.length) remainingRange:NULL];
    if (ok && used > 0) shake256(seed32, 32, buf, used);
    dilithium_secure_zero(buf, max);
    free(buf);
    return ok && used > 0;
}

/** One deterministic keypair for a seed, under the lock; the stack it used is overwritten before release. */
static int keypairFromSeed(NSString *seed, uint8_t pk[DILITHIUM_PK_SIZE], uint8_t sk[DILITHIUM_SK_SIZE]) {
    uint8_t seed32[32];
    if (!seed32FromString(seed, seed32)) return -2;
    dilithium_lock();
    dilithium_set_keygen_seed(seed32);
    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();
    dilithium_burn_stack();
    dilithium_unlock();
    dilithium_secure_zero(seed32, sizeof(seed32));
    return ret;
}

/**
 * generateKeypairFromSeed(seed: string) → { publicKey, secretKey, publicKeySize, secretKeySize }
 *
 * Deterministically generates a Dilithium3 keypair from the given seed string.
 * Seed is hashed with SHAKE-256 to produce a 32-byte entropy input for keygen.
 */
RCT_EXPORT_METHOD(generateKeypairFromSeed:(NSString *)seed
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    uint8_t pk[DILITHIUM_PK_SIZE];
    uint8_t sk[DILITHIUM_SK_SIZE];
    int ret = keypairFromSeed(seed, pk, sk);
    if (ret == -2) {
        reject(@"DILITHIUM_KEYGEN_ERROR", @"Empty seed", nil);
        return;
    }

    if (ret != 0) {
        dilithium_secure_zero(sk, sizeof(sk));
        reject(@"DILITHIUM_KEYGEN_ERROR",
               [NSString stringWithFormat:@"nativeGenerateKeypair failed: %d", ret],
               nil);
        return;
    }

    NSString *skHex = bytesToHex(sk, DILITHIUM_SK_SIZE);
    dilithium_secure_zero(sk, sizeof(sk));
    resolve(@{
        @"publicKey":     bytesToHex(pk, DILITHIUM_PK_SIZE),
        @"secretKey":     skHex,
        @"publicKeySize": @(DILITHIUM_PK_SIZE),
        @"secretKeySize": @(DILITHIUM_SK_SIZE),
    });
}

/**
 * publicKeyFromSeed(seed: string) → { publicKey, publicKeySize }
 *
 * The public key alone: the wallet's determinism check derives the key a second time, and the secret half of
 * that keypair never leaves this function (MPLAT-R2-05).
 */
RCT_EXPORT_METHOD(publicKeyFromSeed:(NSString *)seed
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    uint8_t pk[DILITHIUM_PK_SIZE];
    uint8_t sk[DILITHIUM_SK_SIZE];
    int ret = keypairFromSeed(seed, pk, sk);
    dilithium_secure_zero(sk, sizeof(sk));
    if (ret != 0) {
        reject(@"DILITHIUM_KEYGEN_ERROR", [NSString stringWithFormat:@"publicKeyFromSeed failed: %d", ret], nil);
        return;
    }
    resolve(@{ @"publicKey": bytesToHex(pk, DILITHIUM_PK_SIZE), @"publicKeySize": @(DILITHIUM_PK_SIZE) });
}

/**
 * sign(message, secretKeyHex, publicKeyHex, nodeId) → { signature, signatureSize, totalBinarySize }
 *
 * secretKeyHex: 8064-char hex of raw secret key bytes (from generateKeypairFromSeed).
 *
 * Signature format (identical to Android):
 *   "dilithium_sig_{nodeId}_{base64([4LE:len(sig||msg)] [sig||msg] [4LE:len(pk)] [pk])}"
 */
RCT_EXPORT_METHOD(sign:(NSString *)message
                  secretKeySeed:(NSString *)secretKeyHex
                  publicKeyHex:(NSString *)publicKeyHex
                  nodeId:(NSString *)nodeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    uint8_t sk[DILITHIUM_SK_SIZE];
    if (!secretKeyFromHex(secretKeyHex, sk)) {
        reject(@"DILITHIUM_SIGN_ERROR", @"Secret key must be 4032 bytes of hex", nil);
        return;
    }

    /* Resolve public key bytes */
    uint8_t pk[DILITHIUM_PK_SIZE];
    if (!hexToBytes(publicKeyHex, pk, DILITHIUM_PK_SIZE)) {
        dilithium_secure_zero(sk, sizeof(sk));
        reject(@"DILITHIUM_SIGN_ERROR",
               [NSString stringWithFormat:@"Invalid public key hex (expected %d bytes)", DILITHIUM_PK_SIZE],
               nil);
        return;
    }

    /* Sign */
    const uint8_t *msgBytes = (const uint8_t *)message.UTF8String;
    size_t msgLen = strlen(message.UTF8String);

    uint8_t sig[DILITHIUM_SIG_SIZE];
    size_t  sigLen = 0;
    dilithium_lock();
    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature(
                  sig, &sigLen, msgBytes, msgLen, sk);
    dilithium_burn_stack();
    dilithium_unlock();
    dilithium_secure_zero(sk, sizeof(sk));

    if (ret != 0 || sigLen != DILITHIUM_SIG_SIZE) {
        reject(@"DILITHIUM_SIGN_ERROR",
               [NSString stringWithFormat:@"nativeSign failed: ret=%d sigLen=%zu", ret, sigLen],
               nil);
        return;
    }

    /* Build binary payload:
     *   [4 LE: len(sig||msg)] [sig||msg] [4 LE: len(pk)] [pk]
     * Identical to Android DilithiumModule.kt */
    size_t signedMsgLen = sigLen + msgLen;
    size_t totalLen     = 4 + signedMsgLen + 4 + DILITHIUM_PK_SIZE;
    uint8_t *buf = (uint8_t *)malloc(totalLen);
    if (!buf) {
        reject(@"DILITHIUM_SIGN_ERROR", @"Memory allocation failed", nil);
        return;
    }

    size_t offset = 0;
    writeU32LE(buf + offset, (uint32_t)signedMsgLen); offset += 4;
    memcpy(buf + offset, sig, sigLen);                offset += sigLen;
    memcpy(buf + offset, msgBytes, msgLen);            offset += msgLen;
    writeU32LE(buf + offset, (uint32_t)DILITHIUM_PK_SIZE); offset += 4;
    memcpy(buf + offset, pk, DILITHIUM_PK_SIZE);

    NSData *binaryData = [NSData dataWithBytes:buf length:totalLen];
    free(buf);

    NSString *base64Sig = [binaryData base64EncodedStringWithOptions:0];
    NSString *formattedSignature = [NSString stringWithFormat:@"dilithium_sig_%@_%@",
                                    nodeId, base64Sig];

    resolve(@{
        @"signature":        formattedSignature,
        @"signatureSize":    @(sigLen),
        @"totalBinarySize":  @(totalLen),
    });
}

/**
 * FIX-5: signDetached(message, secretKeyHex) → { signature }
 * Returns ONLY the RAW detached ML-DSA-65 signature (3309 bytes) as hex — no "dilithium_sig_" envelope,
 * no base64, no embedded message, no pubkey trailer. Matches the node's raw-detached value-TX verifier.
 */
RCT_EXPORT_METHOD(signDetached:(NSString *)message
                  secretKeySeed:(NSString *)secretKeyHex
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    uint8_t sk[DILITHIUM_SK_SIZE];
    if (!secretKeyFromHex(secretKeyHex, sk)) {
        reject(@"DILITHIUM_SIGN_ERROR", @"Secret key must be 4032 bytes of hex", nil);
        return;
    }

    const uint8_t *msgBytes = (const uint8_t *)message.UTF8String;
    size_t msgLen = strlen(message.UTF8String);
    uint8_t sig[DILITHIUM_SIG_SIZE];
    size_t  sigLen = 0;
    dilithium_lock();
    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature(sig, &sigLen, msgBytes, msgLen, sk);
    dilithium_burn_stack();
    dilithium_unlock();
    dilithium_secure_zero(sk, sizeof(sk));

    if (ret != 0 || sigLen != DILITHIUM_SIG_SIZE) {
        reject(@"DILITHIUM_SIGN_ERROR",
               [NSString stringWithFormat:@"signDetached failed: ret=%d sigLen=%zu", ret, sigLen], nil);
        return;
    }
    resolve(@{ @"signature": bytesToHex(sig, sigLen) }); // hex of the raw 3309-byte detached sig
}

/**
 * verify(message, signatureHex, publicKeyHex) → boolean
 *
 * signatureHex: hex-encoded raw 3309-byte signature (not the formatted string).
 */
RCT_EXPORT_METHOD(verify:(NSString *)message
                  signatureHex:(NSString *)signatureHex
                  publicKeyHex:(NSString *)publicKeyHex
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    size_t sigLen = signatureHex.length / 2;
    uint8_t *sig = (uint8_t *)malloc(sigLen > 0 ? sigLen : 1);
    uint8_t pk[DILITHIUM_PK_SIZE];

    if (!sig) {
        reject(@"DILITHIUM_VERIFY_ERROR", @"Memory allocation failed", nil);
        return;
    }

    BOOL sigOk = hexToBytes(signatureHex, sig, sigLen);
    BOOL pkOk  = hexToBytes(publicKeyHex, pk, DILITHIUM_PK_SIZE);

    if (!sigOk || !pkOk) {
        free(sig);
        reject(@"DILITHIUM_VERIFY_ERROR", @"Invalid hex input for verify", nil);
        return;
    }

    const uint8_t *msgBytes = (const uint8_t *)message.UTF8String;
    size_t msgLen = strlen(message.UTF8String);

    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_verify(
                  sig, sigLen, msgBytes, msgLen, pk);
    free(sig);

    resolve(@(ret == 0));
}

/**
 * compatibilityTest() → { result, sigSize, isPqclean }
 *
 * Fixed seed → keygen → sign → verify, in debug builds only; a release build answers "skipped".
 */
RCT_EXPORT_METHOD(compatibilityTest:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
#if DEBUG
    const char *testSeed = "QNET_COMPAT_TEST_SEED_v1";
    const char *testMsg  = "compatibility_test_message";
    size_t msgLen = strlen(testMsg);

    uint8_t seed32[32];
    uint8_t pk[DILITHIUM_PK_SIZE];
    uint8_t sk[DILITHIUM_SK_SIZE];
    uint8_t sig[DILITHIUM_SIG_SIZE];
    size_t  sigLen = 0;

    shake256(seed32, 32, (const uint8_t *)testSeed, strlen(testSeed));
    dilithium_lock();
    dilithium_set_keygen_seed(seed32);
    PQCLEAN_MLDSA65_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();
    PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature(
        sig, &sigLen, (const uint8_t *)testMsg, msgLen, sk);
    dilithium_unlock();
    dilithium_secure_zero(sk, sizeof(sk));

    int ok = PQCLEAN_MLDSA65_CLEAN_crypto_sign_verify(
                 sig, sigLen, (const uint8_t *)testMsg, msgLen, pk);

    NSString *result = [NSString stringWithFormat:
        @"OK:PK_LEN=%d:SIG_LEN=%zu:SELF=%@",
        DILITHIUM_PK_SIZE, sigLen, ok == 0 ? @"OK" : @"FAIL"];
#else
    NSString *result = @"skipped";
#endif

    resolve(@{
        @"result":    result,
        @"sigSize":   @(DILITHIUM_SIG_SIZE),
        @"isPqclean": @YES,
    });
}

@end
