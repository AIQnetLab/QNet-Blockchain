// Types of applications/qnet-wallet/tools/crypto-bundle/src/wallet.js (the extension's key derivation), which
// build.mjs compiles into the SDK.
export function deriveQnetKeypair(seed: Uint8Array): { address: string; publicKey: Uint8Array; secretKey: Uint8Array };
