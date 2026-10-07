// Types of applications/qnet-wallet/tools/crypto-bundle/src/mnemonic.js (the extension's recovery-phrase rules), which
// build.mjs compiles into the SDK.
export const MNEMONIC_WORD_COUNTS: number[];
export function validateMnemonic(input: string): boolean;
export function mnemonicToEntropy(input: string): Uint8Array;
export function entropyToSeed(entropy: Uint8Array): Uint8Array;
export function generateEntropy(wordCount?: number): Uint8Array;
