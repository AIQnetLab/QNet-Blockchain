/**
 * dilithium_jni.c
 * JNI bridge between Java/Kotlin DilithiumModule and the PQClean ML-DSA-65
 * (FIPS-204 final) C reference implementation.  This is the EXACT same code
 * the node uses via the pqcrypto-mldsa crate — byte-perfect keygen/sign/verify,
 * so app and node derive the SAME eon wallet address from the same seed.
 *
 * Signature size: 3309 bytes (ML-DSA-65)
 * Public key size: 1952 bytes
 * Secret key size: 4032 bytes
 *
 * Keygen and signing run under one lock (see randombytes_custom.c). Every native buffer that held a seed or a
 * secret key is zeroed before it goes out of scope, PQClean wipes its own secret locals (sign.c), and the stack a
 * keypair or signature used is overwritten before the lock is released. The Java byte arrays and the JS strings
 * the key crosses the bridge in are outside this file; see DilithiumModule.kt.
 */
#include <jni.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <android/log.h>

#include "mldsa65/api.h"
#include "mldsa65/sign.h"
#include "common/fips202.h"
#include "randombytes_custom.h"

#define TAG "DILITHIUM_JNI"
/* Debug builds only (CMakeLists.txt defines QNET_NATIVE_LOG for the Debug configuration): a release build
 * writes nothing to logcat. */
#ifdef QNET_NATIVE_LOG
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#else
#define LOGE(...) ((void)0)
#endif

/* ================================================================
 * JNI: nativeGenerateKeypair(seedBytes: ByteArray): ByteArray
 *   seedBytes = UTF-8 of the seed string; SHAKE-256 of it is the 32-byte KeyGen seed.
 *   Returns pk (1952 bytes) || sk (4032 bytes) = 5984 bytes total
 * ================================================================ */
JNIEXPORT jbyteArray JNICALL
Java_com_qnetmobile_DilithiumModule_nativeGenerateKeypair(
        JNIEnv *env, jobject thiz, jbyteArray seed_arr) {
    jsize seed_len = (*env)->GetArrayLength(env, seed_arr);
    if (seed_len <= 0) return NULL;
    uint8_t *seed = (uint8_t *)malloc((size_t)seed_len);
    if (!seed) return NULL;
    (*env)->GetByteArrayRegion(env, seed_arr, 0, seed_len, (jbyte *)seed);

    uint8_t seed32[32];
    uint8_t pk[PQCLEAN_MLDSA65_CLEAN_CRYPTO_PUBLICKEYBYTES];
    uint8_t sk[PQCLEAN_MLDSA65_CLEAN_CRYPTO_SECRETKEYBYTES];

    shake256(seed32, 32, seed, (size_t)seed_len);
    dilithium_secure_zero(seed, (size_t)seed_len);
    free(seed);

    dilithium_lock();
    dilithium_set_keygen_seed(seed32);
    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();
    dilithium_burn_stack();
    dilithium_unlock();
    dilithium_secure_zero(seed32, sizeof(seed32));

    jbyteArray result = NULL;
    if (ret == 0) {
        jsize total = (jsize)(sizeof(pk) + sizeof(sk));
        result = (*env)->NewByteArray(env, total);
        if (result) {
            (*env)->SetByteArrayRegion(env, result, 0, sizeof(pk), (jbyte *)pk);
            (*env)->SetByteArrayRegion(env, result, sizeof(pk), sizeof(sk), (jbyte *)sk);
        }
    } else {
        LOGE("nativeGenerateKeypair failed: %d", ret);
    }
    dilithium_secure_zero(sk, sizeof(sk));
    return result;
}

/* ================================================================
 * JNI: nativeSign(skBytes: ByteArray, msgBytes: ByteArray): ByteArray
 *   skBytes = 4032 raw bytes of the secret key
 *   Returns 3309-byte detached signature
 * ================================================================ */
JNIEXPORT jbyteArray JNICALL
Java_com_qnetmobile_DilithiumModule_nativeSign(
        JNIEnv *env, jobject thiz,
        jbyteArray sk_arr, jbyteArray msg_arr) {

    jsize sk_len  = (*env)->GetArrayLength(env, sk_arr);
    jsize msg_len = (*env)->GetArrayLength(env, msg_arr);

    if (sk_len != PQCLEAN_MLDSA65_CLEAN_CRYPTO_SECRETKEYBYTES) {
        LOGE("nativeSign: bad sk_len=%d (expected %d)", sk_len,
             PQCLEAN_MLDSA65_CLEAN_CRYPTO_SECRETKEYBYTES);
        return NULL;
    }

    uint8_t sk[PQCLEAN_MLDSA65_CLEAN_CRYPTO_SECRETKEYBYTES];
    uint8_t *msg = (uint8_t *)malloc(msg_len > 0 ? (size_t)msg_len : 1);
    if (!msg) return NULL;

    (*env)->GetByteArrayRegion(env, sk_arr,  0, sk_len,  (jbyte *)sk);
    (*env)->GetByteArrayRegion(env, msg_arr, 0, msg_len, (jbyte *)msg);

    uint8_t sig[PQCLEAN_MLDSA65_CLEAN_CRYPTO_BYTES];
    size_t  siglen = 0;
    dilithium_lock();
    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature(
                  sig, &siglen, msg, (size_t)msg_len, sk);
    dilithium_burn_stack();
    dilithium_unlock();

    dilithium_secure_zero(sk, sizeof(sk));
    free(msg);

    if (ret != 0 || siglen != PQCLEAN_MLDSA65_CLEAN_CRYPTO_BYTES) {
        LOGE("nativeSign failed: ret=%d siglen=%zu", ret, siglen);
        return NULL;
    }

    jbyteArray result = (*env)->NewByteArray(env, (jsize)siglen);
    if (result) (*env)->SetByteArrayRegion(env, result, 0, (jsize)siglen, (jbyte *)sig);
    return result;
}

/* ================================================================
 * JNI: nativeVerify(pkBytes: ByteArray, sigBytes: ByteArray, msgBytes: ByteArray): Boolean
 * ================================================================ */
JNIEXPORT jboolean JNICALL
Java_com_qnetmobile_DilithiumModule_nativeVerify(
        JNIEnv *env, jobject thiz,
        jbyteArray pk_arr, jbyteArray sig_arr, jbyteArray msg_arr) {

    jsize pk_len  = (*env)->GetArrayLength(env, pk_arr);
    jsize sig_len = (*env)->GetArrayLength(env, sig_arr);
    jsize msg_len = (*env)->GetArrayLength(env, msg_arr);

    if (pk_len != PQCLEAN_MLDSA65_CLEAN_CRYPTO_PUBLICKEYBYTES) return JNI_FALSE;

    uint8_t pk[PQCLEAN_MLDSA65_CLEAN_CRYPTO_PUBLICKEYBYTES];
    uint8_t *sig = (uint8_t *)malloc(sig_len > 0 ? (size_t)sig_len : 1);
    uint8_t *msg = (uint8_t *)malloc(msg_len > 0 ? (size_t)msg_len : 1);
    if (!sig || !msg) { free(sig); free(msg); return JNI_FALSE; }

    (*env)->GetByteArrayRegion(env, pk_arr,  0, pk_len,  (jbyte *)pk);
    (*env)->GetByteArrayRegion(env, sig_arr, 0, sig_len, (jbyte *)sig);
    (*env)->GetByteArrayRegion(env, msg_arr, 0, msg_len, (jbyte *)msg);

    int ret = PQCLEAN_MLDSA65_CLEAN_crypto_sign_verify(
                  sig, (size_t)sig_len, msg, (size_t)msg_len, pk);
    free(sig);
    free(msg);

    return (ret == 0) ? JNI_TRUE : JNI_FALSE;
}

/* ================================================================
 * JNI: nativeCompatTest(): String
 *   Fixed seed → keygen → sign → verify; debug builds only (the Kotlin side does not call it in release).
 * ================================================================ */
JNIEXPORT jstring JNICALL
Java_com_qnetmobile_DilithiumModule_nativeCompatTest(
        JNIEnv *env, jobject thiz) {

    const char *test_seed = "QNET_COMPAT_TEST_SEED_v1";
    const char *test_msg  = "compatibility_test_message";
    size_t      msg_len   = strlen(test_msg);

    uint8_t seed32[32];
    uint8_t pk[PQCLEAN_MLDSA65_CLEAN_CRYPTO_PUBLICKEYBYTES];
    uint8_t sk[PQCLEAN_MLDSA65_CLEAN_CRYPTO_SECRETKEYBYTES];
    uint8_t sig[PQCLEAN_MLDSA65_CLEAN_CRYPTO_BYTES];
    size_t  siglen = 0;

    shake256(seed32, 32, (const uint8_t *)test_seed, strlen(test_seed));

    dilithium_lock();
    dilithium_set_keygen_seed(seed32);
    PQCLEAN_MLDSA65_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();
    PQCLEAN_MLDSA65_CLEAN_crypto_sign_signature(
        sig, &siglen, (const uint8_t *)test_msg, msg_len, sk);
    dilithium_unlock();
    dilithium_secure_zero(sk, sizeof(sk));

    int ok = PQCLEAN_MLDSA65_CLEAN_crypto_sign_verify(
                 sig, siglen, (const uint8_t *)test_msg, msg_len, pk);

    char result_buf[96];
    snprintf(result_buf, sizeof(result_buf),
             "OK:PK_LEN=%d:SIG_LEN=%zu:SELF=%s",
             PQCLEAN_MLDSA65_CLEAN_CRYPTO_PUBLICKEYBYTES,
             siglen, ok == 0 ? "OK" : "FAIL");
    return (*env)->NewStringUTF(env, result_buf);
}
