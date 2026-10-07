// Key derivation never falls back: a key the seed does not make (a racing native self-test, a fault, the old
// Solana-bridge address) is refused instead of becoming the wallet.
jest.mock('../src/crypto/DilithiumCrypto', () => ({ generateRawDilithiumKeypair: jest.fn(), derivePublicKeyFromSeed: jest.fn() }));

const { generateRawDilithiumKeypair, derivePublicKeyFromSeed } = require('../src/crypto/DilithiumCrypto');
const { WalletManager } = require('../src/components/WalletManager');
const { eonFromPublicKeyBytes } = require('../src/crypto/WalletIdentity');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const kp = (hexByte) => ({ publicKey: hexByte.repeat(1952), secretKey: '0b'.repeat(4032) });

beforeEach(() => { generateRawDilithiumKeypair.mockReset(); derivePublicKeyFromSeed.mockReset(); });

it('the same seed must give the same ML-DSA key twice, or no wallet is made', async () => {
  const wm = new WalletManager();
  generateRawDilithiumKeypair.mockResolvedValueOnce(kp('aa'));
  derivePublicKeyFromSeed.mockResolvedValueOnce('aa'.repeat(1952));
  const r = await wm.generateQNetAddress(new Uint8Array(64));
  expect(r.address).toBe(eonFromPublicKeyBytes(new Uint8Array(1952).fill(0xaa)));
  // The check asks for the public key only: no second secret key comes into JavaScript (MPLAT-R2-05).
  expect(generateRawDilithiumKeypair).toHaveBeenCalledTimes(1);
  expect(derivePublicKeyFromSeed).toHaveBeenCalledWith(generateRawDilithiumKeypair.mock.calls[0][0]);

  generateRawDilithiumKeypair.mockResolvedValueOnce(kp('aa'));
  derivePublicKeyFromSeed.mockResolvedValueOnce('cc'.repeat(1952));
  await expect(wm.generateQNetAddress(new Uint8Array(64))).rejects.toThrow(/not deterministic/);

  generateRawDilithiumKeypair.mockResolvedValueOnce({ publicKey: 'zz', secretKey: '' });
  await expect(wm.generateQNetAddress(new Uint8Array(64))).rejects.toThrow(/malformed/);
});

it('a failed re-derivation throws instead of assigning an address the seed does not make', async () => {
  generateRawDilithiumKeypair.mockRejectedValue(new Error('native module unavailable'));
  const wallet = { address: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR', mnemonic: MNEMONIC };
  await expect(new WalletManager().migrateQNetAddress(wallet)).rejects.toThrow(/pure Dilithium/);
  expect(wallet.qnetAddress).toBeUndefined();
});

it('a stored ML-DSA key must be the one its address commits to', () => {
  const wm = new WalletManager();
  const pk = Array(1952).fill(0xaa);
  const address = eonFromPublicKeyBytes(new Uint8Array(pk));
  expect(() => wm._assertIdentity({ qnetAddress: address, qnetKeypair: { publicKey: pk, path: 'QNET_WALLET_MLDSA65_fips204' } })).not.toThrow();
  expect(() => wm._assertIdentity({ qnetAddress: address, qnetKeypair: { publicKey: Array(1952).fill(0xab), path: 'QNET_WALLET_MLDSA65_fips204' } }))
    .toThrow(/does not match/);
});

it('the Solana key is the Solana account path m/44\'/501\'/0\'/0\' of the seed, with no fallback to raw seed bytes', async () => {
  const bip39 = require('bip39');
  const { Keypair } = require('@solana/web3.js');
  const seed = bip39.mnemonicToSeedSync(MNEMONIC);
  const key = await new WalletManager().deriveHDKeypair(seed, 0);
  expect(Buffer.from(key).equals(Buffer.from(seed.slice(0, 32)))).toBe(false);
  expect(Keypair.fromSeed(key).publicKey.toBase58()).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
});

describe('derivePublicKeyFromSeed (MPLAT-R2-05)', () => {
  const withNative = (mod, fn) => {
    const { NativeModules } = require('react-native');
    const saved = NativeModules.DilithiumModule;
    NativeModules.DilithiumModule = mod;
    try {
      let real;
      jest.isolateModules(() => { real = jest.requireActual('../src/crypto/DilithiumCrypto'); });
      return fn(real);
    } finally {
      NativeModules.DilithiumModule = saved;
    }
  };

  it('asks the native public-key-only method when the build has it', async () => {
    const mod = { publicKeyFromSeed: jest.fn(async () => ({ publicKey: 'ab' })), generateKeypairFromSeed: jest.fn() };
    await withNative(mod, async (real) => {
      expect(await real.derivePublicKeyFromSeed('seed')).toBe('ab');
    });
    expect(mod.generateKeypairFromSeed).not.toHaveBeenCalled();
  });

  it('an older native build answers through its keypair call; only the public key is returned', async () => {
    const mod = { generateKeypairFromSeed: jest.fn(async () => ({ publicKey: 'cd', secretKey: 'ee' })) };
    await withNative(mod, async (real) => {
      expect(await real.derivePublicKeyFromSeed('seed')).toBe('cd');
    });
  });
});