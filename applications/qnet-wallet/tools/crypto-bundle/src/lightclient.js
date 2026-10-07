// The mobile light client and the shared state-proof verifier, compiled from their own sources. QcLightClient's
// './DilithiumCrypto' import is mapped by the build to shims/DilithiumCrypto.js, which verifies with noble ML-DSA-65
// instead of the native module.
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  accountLeafHash as fullAccountLeafHash,
  isLegacyProofBody,
  readCertifiedAccount as readCertifiedAccountWith,
  readCertifiedToken as readCertifiedTokenWith,
  smtFold,
  storageKeyHash as storageKeyHashWith,
  storageLeafValue as storageLeafValueWith,
  verifyAbsence as verifyAbsenceWith,
  verifyAbsenceInBucket as verifyAbsenceInBucketWith,
  verifyInclusion as verifyInclusionWith,
} from '../../../../qnet-mobile/src/crypto/SmtFold.js';
import { assertBytes } from './bytes.js';
import { fail } from './errors.js';

export {
  certifiedHead,
  certifiedHeadHint,
  certifiedStateRootAt,
  certifiedStateRootIndex,
  chainIdentity,
  checkpointContentDigest,
  checkpointHash,
  checkpointQuorum,
  clearQcCache,
  decodeEligibleNodeIds,
  epochCommitment,
  exportVerifiedAnchors,
  highestVerifiedIndex,
  importVerifiedAnchors,
  ltHashRowLanes,
  markNodeOld,
  nodeMarkedOld,
  parseDilithiumSig,
  quorumSize,
  recomputeRegistryRoot,
  resolvePubkeys,
  sampleCommittee,
  transferLogLeaf,
  trustFloorIndex,
  verifyLogInclusion,
  verifyLogWindowInclusion,
  verifyMacroblockLogsRoot,
  verifyMacroblockStateRoot,
  wsPinIsWellformed,
} from '../../../../qnet-mobile/src/crypto/QcLightClient.js';
// The app's strict reader of proof answers: a repeated key refuses the answer, an integer past 2^53 stays exact text.
export { parseStrictJson, u64Text } from '../../../../qnet-mobile/src/utils/strictJson.js';
export { verifyDilithium as verifyConsensusSignature } from './shims/DilithiumCrypto.js';
export { isLegacyProofBody, smtFold };

/** Bytes in, lowercase hex out: the hash shape smtFold expects. */
export const sha3_256Hex = (bytes) => bytesToHex(sha3_256(assertBytes(bytes)));

/** SMT key of an account: sha3_256("QNET_ADDR:" + address). */
export function accountKeyHash(address) {
  if (typeof address !== 'string' || address.length === 0) fail('INVALID_ADDRESS');
  return sha3_256Hex(utf8ToBytes(`QNET_ADDR:${address}`));
}

/** SMT key of a contract storage entry: sha3_256("QNET_STORAGE_KEY:" + key). */
export const storageKeyHash = (key) => storageKeyHashWith(key, sha3_256Hex);

/** Leaf of a stored contract value: sha3_256("QNET_STORAGE_VAL:" + raw value). */
export const storageLeafValue = (value) => storageLeafValueWith(value, sha3_256Hex);

/**
 * The account leaf over every field the node hashes (hash_account, QNET_ACCOUNT_V2), the shared verifier's own:
 * `fields` { balance, nonce, is_contract, contract_code_hash, storage_root, heartbeat_epoch, heartbeat_slots,
 * heartbeat_final_epoch, heartbeat_final_slots, last_claimed_epoch, banned_at_height, is_node }.
 */
export function certifiedAccountLeafHash(address, fields) {
  if (typeof address !== 'string' || address.length === 0) fail('INVALID_ADDRESS');
  return fullAccountLeafHash(address, fields, sha3_256Hex);
}

/**
 * Leaf of a wallet account (no contract) from every field an account proof carries. A field the answer does not carry
 * is 0, as in the app's reading of the older proof body.
 */
export function accountLeafHash({
  address, balance, nonce, lastClaimedEpoch = 0, isNode = false, heartbeatEpoch = 0, heartbeatSlots = 0,
  heartbeatFinalEpoch = 0, heartbeatFinalSlots = 0, bannedAtHeight = 0,
}) {
  return certifiedAccountLeafHash(address, {
    balance, nonce, is_contract: false, contract_code_hash: null, storage_root: null, heartbeat_epoch: heartbeatEpoch,
    heartbeat_slots: heartbeatSlots, heartbeat_final_epoch: heartbeatFinalEpoch, heartbeat_final_slots: heartbeatFinalSlots,
    last_claimed_epoch: lastClaimedEpoch, banned_at_height: bannedAtHeight, is_node: isNode === true,
  });
}

/** Folds a served account proof up to `stateRoot`; the root itself must come from a QC-verified checkpoint. */
export function verifyAccountProof(account, proof, stateRoot) {
  try {
    return smtFold(accountLeafHash(account), accountKeyHash(account.address), proof, stateRoot, sha3_256Hex);
  } catch {
    return false;
  }
}

/** The key holds `leafHex` under `root` (an inclusion proof). */
export const verifyInclusion = (keyHashHex, leafHex, steps, root) => verifyInclusionWith(keyHashHex, leafHex, steps, root, sha3_256Hex);

/** The key's bucket is empty under `root`: the default bucket hash seeds exactly 40 steps. */
export const verifyAbsence = (keyHashHex, steps, root) => verifyAbsenceWith(keyHashHex, steps, root, sha3_256Hex);

/** The key's bucket holds exactly `entries` ([key, leaf] pairs) under `root`, none of them the key. */
export const verifyAbsenceInBucket = (keyHashHex, entries, steps, root) => verifyAbsenceInBucketWith(keyHashHex, entries, steps, root,
  sha3_256Hex);

/**
 * A certified account answer (proof_format 2) for `address`, read strictly: {ok: true, index, account, fold(root)} or
 * {ok: false, reason}. The caller folds to the root it verified for `index`, never to the one the node served.
 */
export const readCertifiedAccount = (body, address) => readCertifiedAccountWith(body, address, sha3_256Hex);

/**
 * A certified token answer (proof_format 2) for (`contract`, `holder`): {ok: true, index, status, balanceBase,
 * contractNonce, fold(root)} or {ok: false, reason}. Both levels fold under the root the caller verified for `index`.
 */
export const readCertifiedToken = (body, contract, holder) => readCertifiedTokenWith(body, contract, holder, sha3_256Hex);

const HEX32 = /^[0-9a-f]{64}$/;
const ZERO32 = '0'.repeat(64);

/**
 * A token answer of a node from before certified proofs (it ignores the `mb` query): whether its two levels fold to
 * the state root it names (`body.state_root`), bound to the asked contract and holder. The contract leaf is rebuilt from
 * every field it carries; a drained holder's entry is the empty leaf. The root counts only once the caller found it
 * to be a certified one.
 */
export function verifyLegacyTokenProof(body, contract, holder) {
  try {
    if (!body || typeof body !== 'object' || body.contract_address !== contract || body.holder !== holder) return false;
    if (!HEX32.test(String(body.state_root)) || !HEX32.test(String(body.storage_root))) return false;
    if (!Array.isArray(body.storage_proof) || !Array.isArray(body.account_proof)) return false;
    const raw = body.token_balance === undefined ? '0' : String(body.token_balance);
    if (!/^(0|[1-9][0-9]{0,19})$/.test(raw)) return false;
    const storageLeaf = raw === '0' ? ZERO32 : storageLeafValue(raw);
    if (!smtFold(storageLeaf, storageKeyHash(`balance:${holder}`), body.storage_proof, body.storage_root, sha3_256Hex)) return false;
    const leaf = certifiedAccountLeafHash(contract, {
      balance: body.account_balance, nonce: body.account_nonce, is_contract: true,
      contract_code_hash: typeof body.contract_code_hash === 'string' && body.contract_code_hash !== '' ? body.contract_code_hash : null,
      storage_root: body.storage_root, heartbeat_epoch: body.heartbeat_epoch ?? 0, heartbeat_slots: body.heartbeat_slots ?? 0,
      heartbeat_final_epoch: body.heartbeat_final_epoch ?? 0, heartbeat_final_slots: body.heartbeat_final_slots ?? 0,
      last_claimed_epoch: body.last_claimed_epoch ?? 0, banned_at_height: body.banned_at_height ?? 0, is_node: body.is_node === true,
    });
    return smtFold(leaf, accountKeyHash(contract), body.account_proof, body.state_root, sha3_256Hex);
  } catch {
    return false;
  }
}
