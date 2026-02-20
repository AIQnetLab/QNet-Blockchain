/**
 * dilithium_jni.c
 * JNI bridge between Java/Kotlin DilithiumModule and the pqclean Dilithium3
 * C reference implementation.  This is the EXACT same code used by the QNet
 * server's pqcrypto-dilithium 0.5 crate — byte-perfect compatibility.
 *
 * Signature size: 3309 bytes (FIPS 204 / pqclean dilithium3)
 * Public key size: 1952 bytes
 * Secret key size: 4032 bytes
 */
#include <jni.h>
#include <string.h>
#include <stdlib.h>
#include <android/log.h>

#include "dilithium3/api.h"
#include "dilithium3/sign.h"
#include "common/fips202.h"
#include "randombytes_custom.h"

#define TAG "DILITHIUM_JNI"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

/* ---- hex helpers ---- */
static void bytes_to_hex(const uint8_t *bytes, size_t len, char *out) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2*i]   = hex[(bytes[i] >> 4) & 0xF];
        out[2*i+1] = hex[ bytes[i]       & 0xF];
    }
    out[2*len] = '\0';
}

static int hex_to_bytes(const char *hex, size_t hex_len, uint8_t *out) {
    if (hex_len % 2 != 0) return -1;
    for (size_t i = 0; i < hex_len / 2; i++) {
        char hi = hex[2*i],   lo = hex[2*i+1];
        int h = (hi >= '0' && hi <= '9') ? hi-'0' :
                (hi >= 'a' && hi <= 'f') ? hi-'a'+10 :
                (hi >= 'A' && hi <= 'F') ? hi-'A'+10 : -1;
        int l = (lo >= '0' && lo <= '9') ? lo-'0' :
                (lo >= 'a' && lo <= 'f') ? lo-'a'+10 :
                (lo >= 'A' && lo <= 'F') ? lo-'A'+10 : -1;
        if (h < 0 || l < 0) return -1;
        out[i] = (uint8_t)((h << 4) | l);
    }
    return 0;
}

/**
 * Derive a deterministic 32-byte seed from a string using SHAKE-256.
 * Same approach regardless of input length.
 */
static void derive_seed_from_string(const char *str, size_t str_len, uint8_t out[32]) {
    shake256(out, 32, (const uint8_t *)str, str_len);
}

/* ================================================================
 * JNI: nativeGenerateKeypair(seedStr: String): ByteArray
 *   Returns pk (1952 bytes) || sk (4032 bytes) = 5984 bytes total
 * ================================================================ */
JNIEXPORT jbyteArray JNICALL
Java_com_qnetmobile_DilithiumModule_nativeGenerateKeypair(
        JNIEnv *env, jobject thiz, jstring seed_str) {
    const char *seed = (*env)->GetStringUTFChars(env, seed_str, NULL);
    size_t seed_len  = strlen(seed);

    uint8_t seed32[32];
    derive_seed_from_string(seed, seed_len, seed32);
    dilithium_set_keygen_seed(seed32);

    uint8_t pk[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES];
    uint8_t sk[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_SECRETKEYBYTES];
    int ret = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_keypair(pk, sk);

    dilithium_clear_keygen_seed();
    (*env)->ReleaseStringUTFChars(env, seed_str, seed);

    if (ret != 0) {
        LOGE("nativeGenerateKeypair failed: %d", ret);
        return NULL;
    }

    /* Return pk || sk */
    jsize total = (jsize)(sizeof(pk) + sizeof(sk));
    jbyteArray result = (*env)->NewByteArray(env, total);
    (*env)->SetByteArrayRegion(env, result, 0,         sizeof(pk), (jbyte*)pk);
    (*env)->SetByteArrayRegion(env, result, sizeof(pk), sizeof(sk), (jbyte*)sk);
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

    if (sk_len != PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_SECRETKEYBYTES) {
        LOGE("nativeSign: bad sk_len=%d (expected %d)", sk_len,
             PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_SECRETKEYBYTES);
        return NULL;
    }

    uint8_t sk[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_SECRETKEYBYTES];
    uint8_t *msg = (uint8_t*)malloc((size_t)msg_len);
    if (!msg) return NULL;

    (*env)->GetByteArrayRegion(env, sk_arr,  0, sk_len,  (jbyte*)sk);
    (*env)->GetByteArrayRegion(env, msg_arr, 0, msg_len, (jbyte*)msg);

    uint8_t sig[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_BYTES];
    size_t  siglen = 0;
    int ret = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature(
                  sig, &siglen, msg, (size_t)msg_len, sk);

    /* Zero secret key immediately after use — prevent key material in stack residue */
    memset(sk, 0, sizeof(sk));
    free(msg);

    if (ret != 0 || siglen != PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_BYTES) {
        LOGE("nativeSign failed: ret=%d siglen=%zu", ret, siglen);
        return NULL;
    }

    jbyteArray result = (*env)->NewByteArray(env, (jsize)siglen);
    (*env)->SetByteArrayRegion(env, result, 0, (jsize)siglen, (jbyte*)sig);
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

    uint8_t pk[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES];
    uint8_t *sig = (uint8_t*)malloc((size_t)sig_len);
    uint8_t *msg = (uint8_t*)malloc((size_t)msg_len);
    if (!sig || !msg) { free(sig); free(msg); return JNI_FALSE; }

    (*env)->GetByteArrayRegion(env, pk_arr,  0, pk_len,  (jbyte*)pk);
    (*env)->GetByteArrayRegion(env, sig_arr, 0, sig_len, (jbyte*)sig);
    (*env)->GetByteArrayRegion(env, msg_arr, 0, msg_len, (jbyte*)msg);

    int ret = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify(
                  sig, (size_t)sig_len, msg, (size_t)msg_len, pk);
    free(sig);
    free(msg);

    return (ret == 0) ? JNI_TRUE : JNI_FALSE;
}

/* ================================================================
 * JNI: nativeCompatTest(): String
 *   Generates test keypair, signs fixed message, returns hex results
 *   for cross-verification with pqcrypto-dilithium 0.5
 * ================================================================ */
JNIEXPORT jstring JNICALL
Java_com_qnetmobile_DilithiumModule_nativeCompatTest(
        JNIEnv *env, jobject thiz) {

    const char *test_seed = "QNET_COMPAT_TEST_SEED_v1";
    const char *test_msg  = "compatibility_test_message";
    size_t      msg_len   = strlen(test_msg);

    uint8_t seed32[32];
    derive_seed_from_string(test_seed, strlen(test_seed), seed32);
    dilithium_set_keygen_seed(seed32);

    uint8_t pk[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES];
    uint8_t sk[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_SECRETKEYBYTES];
    PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_keypair(pk, sk);
    dilithium_clear_keygen_seed();

    uint8_t sig[PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_BYTES];
    size_t  siglen = 0;
    PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_signature(
        sig, &siglen, (const uint8_t*)test_msg, msg_len, sk);

    /* Verify locally */
    int ok = PQCLEAN_DILITHIUM3_CLEAN_crypto_sign_verify(
                 sig, siglen, (const uint8_t*)test_msg, msg_len, pk);

    LOGE("=== PQCLEAN COMPAT TEST ===");
    LOGE("PK_LEN=%d SIG_LEN=%zu SELF_VERIFY=%s",
         PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES, siglen, ok==0?"true":"false");

    /* Chunk PK hex */
    char *pk_hex = (char*)malloc(PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES * 2 + 1);
    bytes_to_hex(pk, PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES, pk_hex);
    for (int i = 0; i * 1000 < (int)(PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES * 2); i++) {
        int start = i * 1000;
        int end   = start + 1000;
        if (end > (int)(PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES * 2))
            end = (int)(PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES * 2);
        char chunk[1001];
        memcpy(chunk, pk_hex + start, end - start);
        chunk[end - start] = '\0';
        LOGE("PQCLEAN_PK[%d]%s", i, chunk);
    }

    /* Chunk SIG hex */
    char *sig_hex = (char*)malloc(siglen * 2 + 1);
    bytes_to_hex(sig, siglen, sig_hex);
    for (int i = 0; i * 1000 < (int)(siglen * 2); i++) {
        int start = i * 1000;
        int end   = start + 1000;
        if (end > (int)(siglen * 2)) end = (int)(siglen * 2);
        char chunk[1001];
        memcpy(chunk, sig_hex + start, end - start);
        chunk[end - start] = '\0';
        LOGE("PQCLEAN_SIG[%d]%s", i, chunk);
    }

    /* Build result JSON-like string */
    size_t result_len = 64 + 1952*2 + siglen*2;
    char *result_buf  = (char*)malloc(result_len);
    snprintf(result_buf, result_len,
             "OK:PK_LEN=%d:SIG_LEN=%zu:SELF=%s",
             PQCLEAN_DILITHIUM3_CLEAN_CRYPTO_PUBLICKEYBYTES,
             siglen, ok==0?"OK":"FAIL");

    jstring ret = (*env)->NewStringUTF(env, result_buf);
    free(pk_hex);
    free(sig_hex);
    free(result_buf);
    return ret;
}

