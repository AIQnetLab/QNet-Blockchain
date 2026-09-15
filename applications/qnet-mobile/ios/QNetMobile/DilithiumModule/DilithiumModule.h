/**
 * DilithiumModule.h
 * React Native native module — iOS (Objective-C)
 *
 * Exposes the same API as the Android DilithiumModule.kt:
 *   - generateKeypairFromSeed(seed)  → { publicKey, secretKey, publicKeySize, secretKeySize }
 *   - sign(message, secretKey, publicKey, nodeId) → { signature, signatureSize, totalBinarySize }
 *   - verify(message, signatureHex, publicKeyHex) → boolean
 *   - compatibilityTest()            → { result, sigSize, isPqclean }
 *
 * Uses the same PQClean Dilithium3 C source as Android and the server's
 * pqcrypto-dilithium 0.5 — byte-perfect cross-platform compatibility.
 *
 * Signature format (identical to Android):
 *   "dilithium_sig_{nodeId}_{base64}"
 *   base64 encodes: [4-byte LE: len(sig||msg)] [sig||msg] [4-byte LE: len(pk)] [pk]
 */

#import <React/RCTBridgeModule.h>

@interface DilithiumModule : NSObject <RCTBridgeModule>
@end
