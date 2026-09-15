/**
 * Ambient type declarations for modules used by dilithium-manager.ts.
 *
 * @noble/post-quantum is a proper npm package with its own .d.ts files,
 * so it does NOT need a declaration here — the types come from the package itself.
 *
 * Node.js built-ins used in the Node.js (non-browser) code path:
 */

declare module 'fs/promises' {
  export function mkdir(path: string, opts?: {recursive?: boolean}): Promise<void>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare module 'path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare module 'os' {
  export function homedir(): string;
}

/**
 * window.QNetDilithiumLib — set by dist/lib/noble-pq-ml-dsa.js (IIFE bundle).
 * Used by dist/src/crypto/DilithiumManager.js in the browser extension context.
 * In TypeScript source (dilithium-manager.ts), ml_dsa65 is imported directly
 * from @noble/post-quantum/ml-dsa.js, so this global is not needed there.
 */
interface QNetDilithiumAPI {
  keygen(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;    // 3309-byte detached sig
  verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
  readonly PK_SIZE:  1952;
  readonly SK_SIZE:  4032;
  readonly SIG_SIZE: 3309;
}

interface Window {
  QNetDilithiumLib?: { QNetDilithium: QNetDilithiumAPI };
}
