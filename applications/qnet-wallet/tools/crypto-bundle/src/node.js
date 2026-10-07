// The light node messages the extension builds and signs (docs/protocols/light-node-messages.md): the app's builders,
// one copy for both wallets. The extension never runs a node, so the device and ping-key builders stay out.
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  claimPayloadPreimage,
  claimQuotePreimage,
  consentPreimage,
  lightNodeId,
  ownerBindPreimage,
  registrationProof,
  statusPreimage,
  walletUnbindPreimage,
} from '../../../../qnet-mobile/src/crypto/NodePreimages.js';
import { eonFromPublicKeyBytes } from '../../../../qnet-mobile/src/crypto/WalletIdentity.js';
import { assertBytes } from './bytes.js';
import { fail } from './errors.js';
import { ML_DSA65, signChecked } from './signing.js';
import { signSolanaMessage, verifySolanaSignature } from './solana.js';

export {
  claimPayloadPreimage,
  claimQuotePreimage,
  consentPreimage,
  lightNodeId,
  ownerBindPreimage,
  publicKeySha3,
  registrationProof,
  statusPreimage,
  walletUnbindPreimage,
} from '../../../../qnet-mobile/src/crypto/NodePreimages.js';

// The builders refuse a malformed field with a TypeError; a signer reports it as INVALID_NODE_MESSAGE.
function built(build) {
  try {
    return build();
  } catch (error) {
    if (error instanceof TypeError) fail('INVALID_NODE_MESSAGE');
    throw error;
  }
}

// The wallet's own light node id and the proof of `burnTx` for it: never taken from a caller.
function ownNode(nodeId, wallet, burnTx) {
  const own = built(() => lightNodeId(wallet));
  if (nodeId !== own) fail('INVALID_NODE_MESSAGE');
  return burnTx === undefined ? { nodeId } : { nodeId, proof: built(() => registrationProof(burnTx, nodeId, wallet)) };
}

/**
 * The wallet's consent to register its own light node with `burnTx` at `ts` (Unix seconds): ML-DSA-65 over
 * q1337|client_node_reg:{N}:{W}:{proof}:{T}, the proof computed here from the burn. Self-verified.
 * @returns {{preimage: string, proof: string, signature: Uint8Array}}
 */
export function signNodeConsent({ nodeId, wallet, burnTx, ts }, secretKey, publicKey) {
  const { proof } = ownNode(nodeId, wallet, burnTx);
  const preimage = built(() => consentPreimage(nodeId, wallet, proof, ts));
  return { preimage, proof, signature: signChecked(wallet, preimage, secretKey, publicKey) };
}

/**
 * The burner's owner bind of the same registration: Ed25519 of the burning Solana key over
 * qnet_onchain_reg:{N}:{W}:{proof}:{T}:{sha3(K)}:{burnTx}, where K is the wallet's ML-DSA-65 key. Self-verified.
 * @returns {{preimage: string, signature: Uint8Array}}
 */
export function signOwnerBind({ nodeId, wallet, burnTx, ts }, walletPublicKey, burnerPrivateKey, burnerPublicKey) {
  assertBytes(walletPublicKey, ML_DSA65.PUBLIC_KEY_BYTES);
  if (eonFromPublicKeyBytes(walletPublicKey) !== wallet) fail('KEY_ADDRESS_MISMATCH');
  const { proof } = ownNode(nodeId, wallet, burnTx);
  const preimage = built(() => ownerBindPreimage(nodeId, wallet, proof, ts, bytesToHex(walletPublicKey), burnTx));
  const message = utf8ToBytes(preimage);
  const signature = signSolanaMessage(message, burnerPrivateKey);
  if (!verifySolanaSignature(signature, message, burnerPublicKey)) fail('SIGNATURE_SELF_CHECK_FAILED');
  return { preimage, signature };
}

/**
 * Step 1 of moving the node balance: ML-DSA-65 over q1337|claim_rewards:{N}:{W}. Self-verified.
 * @returns {{preimage: string, signature: Uint8Array}}
 */
export function signClaimQuote({ nodeId, wallet }, secretKey, publicKey) {
  ownNode(nodeId, wallet);
  const preimage = built(() => claimQuotePreimage(nodeId, wallet));
  return { preimage, signature: signChecked(wallet, preimage, secretKey, publicKey) };
}

/**
 * Step 2: ML-DSA-65 over q1337|qnet_claim_v1:{W}:{ts}:{sha3(claimsData)}, built here from the quoted payload and its
 * timestamp (a node's own copy of the message is never signed). Self-verified.
 * @returns {{preimage: string, signature: Uint8Array}}
 */
export function signClaimPayload({ wallet, ts, claimsData }, secretKey, publicKey) {
  const preimage = built(() => claimPayloadPreimage(wallet, ts, claimsData));
  return { preimage, signature: signChecked(wallet, preimage, secretKey, publicKey) };
}

/**
 * The wallet's request for the signed status of its own light node (the registration record, with the burn that
 * registered it): ML-DSA-65 over q1337|light_status:{N}:{ts}. Self-verified.
 * @returns {{preimage: string, signature: Uint8Array}}
 */
export function signNodeStatus({ nodeId, wallet, ts }, secretKey, publicKey) {
  ownNode(nodeId, wallet);
  const preimage = built(() => statusPreimage(nodeId, ts));
  return { preimage, signature: signChecked(wallet, preimage, secretKey, publicKey) };
}

/**
 * The wallet key's unbind of its own light node from the device binding `seq` at `ts` (Unix seconds): ML-DSA-65 over
 * q1337|light_unbind_wallet:{N}:{seq}:{ts}, which ends the node on whatever device runs it. Self-verified.
 * @returns {{preimage: string, signature: Uint8Array}}
 */
export function signNodeUnbind({ nodeId, wallet, seq, ts }, secretKey, publicKey) {
  ownNode(nodeId, wallet);
  const preimage = built(() => walletUnbindPreimage(nodeId, seq, ts));
  return { preimage, signature: signChecked(wallet, preimage, secretKey, publicKey) };
}
