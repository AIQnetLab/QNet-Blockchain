/**
 * DilithiumModule.m
 * React Native native module for iOS — Dilithium3 (ML-DSA-65) post-quantum signatures.
 *
 * Mirrors Android DilithiumModule.kt. All methods, return shapes, and binary
 * formats are byte-identical so JS code (DilithiumCrypto.js) works unchanged.
 *
 * C sources included in the Xcode build target:
 *   DilithiumModule/dilithium3/*.c
 *   DilithiumModule/common/fips202.c
 *   DilithiumModule/randombytes_ios.c
 *
 * Key sizes (FIPS 204 / pqclean dilithium3):
 *   Public key : 1952 bytes
 *   Secret key : 4032 bytes
 *   Signature  : 3309 bytes
 */

#import "DilithiumModule.h"
#import <React/RCTLog.h>
#import <Foundation/Foundation.h>

/* PQClean C API */
#include "dilithium3/api.h"
#include "dilithium3/sign.h"
#include "common/fips202.h"
#include "randombytes_custom.h"

#include <string.h>
#include <stdlib.h>

#define DILITHIUM_PK_SIZE  PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES  /* 1952 */
#define DILITHIUM_SK_SIZE  PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_SECRETKEYBYTES  /* 4032 */
#define DILITHIUM_SIG_SIZE PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_BYTES           /* 3309 */

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

/** Derive deterministic 32-byte seed via SHAKE-256 (same as Android). */
static void deriveSeedFromString(const char *str, size_t len, uint8_t out[32]) {
    shake256(out, 32, (const uint8_t *)str, len);
}

/* ---- 4-byte little-endian write ---- */
static void writeU32LE(uint8_t *buf, uint32_t value) {
    buf[0] = (uint8_t)(value & 0xFF);
    buf[1] = (uint8_t)((value >> 8)  & 0xFF);
    buf[2] = (uint8_t)((value >> 16) & 0xFF);
    buf[3] = (uint8_t)((value >> 24) & 0xFF);
}

@implementation DilithiumModule

RCT_EXPORT_MODULE(DilithiumModule)

/** All methods run on a serial queue to keep single-threaded seed state safe. */
- (dispatch_queue_t)methodQueue {
    return dispatch_queue_create("com.qnetmobile.dilithium", DISPATCH_QUEUE_SERIAL);
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
    const char *seedStr = seed.UTF8String;
    size_t seedLen = strlen(seedStr);

    uint8_t seed32[32];
    deriveSeedFromString(seedStr, seedLen, seed32);
    dilithium_set_keygen_seed(seed32);

    uint8_t pk[DILITHIUM_PK_SIZE];
    uint8_t sk[DILITHIUM_SK_SIZE];
    int ret = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();

    if (ret != 0) {
        reject(@"DILITHIUM_KEYGEN_ERROR",
               [NSString stringWithFormat:@"nativeGenerateKeypair failed: %d", ret],
               nil);
        return;
    }

    resolve(@{
        @"publicKey":     bytesToHex(pk, DILITHIUM_PK_SIZE),
        @"secretKey":     bytesToHex(sk, DILITHIUM_SK_SIZE),
        @"publicKeySize": @(DILITHIUM_PK_SIZE),
        @"secretKeySize": @(DILITHIUM_SK_SIZE),
    });
}

/**
 * sign(message, secretKeySeed, publicKeyHex, nodeId) → { signature, signatureSize, totalBinarySize }
 *
 * secretKeySeed: 8064-char hex of raw secret key bytes (from generateKeypairFromSeed).
 *   If not valid hex of correct length, treats as seed string and re-derives keypair.
 *
 * Signature format (identical to Android):
 *   "dilithium_sig_{nodeId}_{base64([4LE:len(sig||msg)] [sig||msg] [4LE:len(pk)] [pk])}"
 */
RCT_EXPORT_METHOD(sign:(NSString *)message
                  secretKeySeed:(NSString *)secretKeySeed
                  publicKeyHex:(NSString *)publicKeyHex
                  nodeId:(NSString *)nodeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    /* Resolve secret key bytes */
    uint8_t sk[DILITHIUM_SK_SIZE];
    BOOL isRawHex = (secretKeySeed.length == DILITHIUM_SK_SIZE * 2) &&
                    hexToBytes(secretKeySeed, sk, DILITHIUM_SK_SIZE);

    if (!isRawHex) {
        /* Legacy / seed path: re-derive keypair from seed string */
        const char *seedStr = secretKeySeed.UTF8String;
        uint8_t seed32[32];
        deriveSeedFromString(seedStr, strlen(seedStr), seed32);
        dilithium_set_keygen_seed(seed32);

        uint8_t pk_tmp[DILITHIUM_PK_SIZE];
        if (PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_keypair(pk_tmp, sk) != 0) {
            dilithium_clear_keygen_seed();
            reject(@"DILITHIUM_SIGN_ERROR", @"Failed to re-derive keypair from seed", nil);
            return;
        }
        dilithium_clear_keygen_seed();
    }

    /* Resolve public key bytes */
    uint8_t pk[DILITHIUM_PK_SIZE];
    if (!hexToBytes(publicKeyHex, pk, DILITHIUM_PK_SIZE)) {
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
    int ret = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature(
                  sig, &sigLen, msgBytes, msgLen, sk);

    /* Zero secret key immediately after use — prevent key material in stack residue */
    memset(sk, 0, DILITHIUM_SK_SIZE);

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
    uint8_t *sig = (uint8_t *)malloc(sigLen);
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

    int ret = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify(
                  sig, sigLen, msgBytes, msgLen, pk);
    free(sig);

    resolve(@(ret == 0));
}

/**
 * compatibilityTest() → { result, sigSize, isPqclean }
 *
 * Runs the same self-test as Android: fixed seed → keygen → sign → verify.
 * Logs PK/SIG chunks to NSLog for cross-checking with Rust compat test.
 */
RCT_EXPORT_METHOD(compatibilityTest:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    const char *testSeed = "QNET_COMPAT_TEST_SEED_v1";
    const char *testMsg  = "compatibility_test_message";
    size_t msgLen = strlen(testMsg);

    uint8_t seed32[32];
    deriveSeedFromString(testSeed, strlen(testSeed), seed32);
    dilithium_set_keygen_seed(seed32);

    uint8_t pk[DILITHIUM_PK_SIZE];
    uint8_t sk[DILITHIUM_SK_SIZE];
    PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();

    uint8_t sig[DILITHIUM_SIG_SIZE];
    size_t  sigLen = 0;
    PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature(
        sig, &sigLen, (const uint8_t *)testMsg, msgLen, sk);

    int ok = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify(
                 sig, sigLen, (const uint8_t *)testMsg, msgLen, pk);

    NSLog(@"=== PQCLEAN COMPAT TEST (iOS) ===");
    NSLog(@"PK_LEN=%d SIG_LEN=%zu SELF_VERIFY=%@",
          DILITHIUM_PK_SIZE, sigLen, ok == 0 ? @"true" : @"false");

    /* Log PK in 1000-char hex chunks (matches Android logcat format) */
    NSString *pkHex = bytesToHex(pk, DILITHIUM_PK_SIZE);
    for (int i = 0; i * 1000 < (int)pkHex.length; i++) {
        NSInteger start = i * 1000;
        NSInteger end   = MIN(start + 1000, (NSInteger)pkHex.length);
        NSLog(@"PQCLEAN_PK[%d]%@", i,
              [pkHex substringWithRange:NSMakeRange(start, end - start)]);
    }

    /* Log SIG in 1000-char hex chunks */
    NSString *sigHex = bytesToHex(sig, sigLen);
    for (int i = 0; i * 1000 < (int)sigHex.length; i++) {
        NSInteger start = i * 1000;
        NSInteger end   = MIN(start + 1000, (NSInteger)sigHex.length);
        NSLog(@"PQCLEAN_SIG[%d]%@", i,
              [sigHex substringWithRange:NSMakeRange(start, end - start)]);
    }

    NSString *result = [NSString stringWithFormat:
        @"OK:PK_LEN=%d:SIG_LEN=%zu:SELF=%@",
        DILITHIUM_PK_SIZE, sigLen, ok == 0 ? @"OK" : @"FAIL"];

    resolve(@{
        @"result":    result,
        @"sigSize":   @(DILITHIUM_SIG_SIZE),
        @"isPqclean": @YES,
    });
}

@end
