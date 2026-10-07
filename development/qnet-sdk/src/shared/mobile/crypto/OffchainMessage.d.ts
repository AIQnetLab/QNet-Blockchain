// Types of applications/qnet-mobile/src/crypto/OffchainMessage.js, which build.mjs compiles into the SDK.
export const OFFCHAIN_MESSAGE_HEADER: string;
export const OFFCHAIN_MESSAGE_CONTEXT: string;
export const OFFCHAIN_MESSAGE_MAX_BYTES: number;
export function hasHiddenCharacter(message: string): boolean;
export function hasProtocolPrefix(message: string): boolean;
export function buildOffchainMessage(origin: string, message: string): Uint8Array;
export function verifyOffchainMessage(origin: string, message: string, signature: Uint8Array, publicKey: Uint8Array): boolean;
