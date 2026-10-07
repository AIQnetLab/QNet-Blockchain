import { utf8ToBytes } from '@noble/hashes/utils.js';
import { generateActivationCode } from './activation.js';
import { equalBytes, zeroize } from './bytes.js';
import { CoreError } from './errors.js';
import { entropyToSeed, mnemonicToEntropy, mnemonicToSeed } from './mnemonic.js';
import { lightNodeId } from './node.js';
import { deriveSolanaKeypair, signSolanaMessage, verifySolanaSignature } from './solana.js';
import { deriveQnetKeypair, signTransfer, verifyTransferSignature } from './wallet.js';

// Public 12-word recovery-phrase test vector and the values mobile and the node derive from it.
export const KAT = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  qnetAddress: 'd9fa370374e24333242eon847d1d354dcd87fe873823e',
  solanaAddress: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
  // the light node id the app and the node derive from qnetAddress (docs/protocols/light-node.vectors.json)
  nodeId: 'light_mobile_6526ab8fd00ff8ca',
  activation: {
    nodeType: 'light',
    solanaAddress: 'FVaaBjaHMKv2yneekLf7UtF7TAi4NpYHyDMrCfDtwBsR',
    burnTx: 'nqh74heddHDKQbzTqJAmu6o8VZEyBbdsfJcDJTtfPCYgTmGagX2xsrdZhkKFKBGFHyEq6tyNFrgZWrbTatq8Ywx',
    burnAmount: 1500,
    code: 'QNET-LFEFD9-706058-537636',
  },
};

/**
 * Derivation, signing and activation known-answer checks. Returns true or throws CoreError
 * SELF_TEST_FAILED; a caller that sees the throw must not sign anything.
 */
export function selfTest() {
  let seed;
  let entropy;
  let walletSeed;
  let qnet;
  let solana;
  let ok = false;
  try {
    seed = mnemonicToSeed(KAT.mnemonic);
    // The worker derives from the stored entropy, never from a phrase string: both paths must agree.
    entropy = mnemonicToEntropy(KAT.mnemonic);
    walletSeed = entropyToSeed(entropy);
    qnet = deriveQnetKeypair(walletSeed);
    solana = deriveSolanaKeypair(seed);
    const tx = { from: qnet.address, to: KAT.qnetAddress, amountNano: 1, nonce: 1, gasPrice: 10, gasLimit: 10000 };
    const { signature } = signTransfer(tx, qnet.secretKey, qnet.publicKey);
    const message = utf8ToBytes('qnet-core self-test');
    const a = KAT.activation;
    ok = equalBytes(walletSeed, seed)
      && qnet.address === KAT.qnetAddress
      && lightNodeId(qnet.address) === KAT.nodeId
      && solana.address === KAT.solanaAddress
      && verifyTransferSignature(tx, signature, qnet.publicKey)
      && !verifyTransferSignature({ ...tx, amountNano: 2 }, signature, qnet.publicKey)
      && verifySolanaSignature(signSolanaMessage(message, solana.privateKey), message, solana.publicKey)
      && generateActivationCode(a.nodeType, a.solanaAddress, a.burnTx, a.burnAmount) === a.code;
  } catch {
    ok = false;
  } finally {
    zeroize(seed, entropy, walletSeed, qnet?.secretKey, solana?.privateKey);
  }
  if (!ok) throw new CoreError('SELF_TEST_FAILED');
  return true;
}
