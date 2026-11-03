/**
 * The Node side of a QNet Link request (services/QNetLink prepareOffer and performIntent): what the sheets read before
 * the user decides (the light node's status from its shard owners, whether the chain lists the wallet's super node,
 * whether this device can run a node, this device's binding, the node balance) and the things a confirmed request does
 * (the reservation of the light node for the page's one-time address, consent and a pending binding, the registration
 * that consent is for, a binding of this device, the end of the node's binding, a move of the balance of the node the
 * request names, the wallet's light or super node). The wallet screen makes one for the open wallet; every wallet-key signature is made by its WalletManager.
 * The end of a binding this device holds is signed by the node's ping key here (PushService.stopLightNode); the end of
 * a binding another device holds, by the wallet key, from any device that has the wallet (`unlinkByWallet`).
 */
import { postUnbind, readAgreedNodeStatus, readServerNodeListed } from './LightNode';
import {
  bindThisDevice, getPendingRewards, linkWithConsent, localBinding, localNode, nodeCheckState, readUnconfirmedBinding,
  signStatusWithPingKey, stopLightNode,
} from './PushService';
import { checkDevice, isThisDevice } from './NodeDeviceKey';
import { nodeView } from '../screens/NodeTab';
import { readNodeRecordState } from './NodeRecordRead';
import { sendRegistration } from './RegistrationSubmit';
import { FIRST_CONTACT_MS } from '../config/nodes';
import { NANO_PER_QNC } from '../config/fees';
import { acceptedBalance } from './ClaimTransit';
import { lastCountedPart, runMovedNano } from './MoveRun';
import { ownNodeType } from '../crypto/NodePreimages';

const TX_HASH_RE = /^[0-9a-f]{64}$/;

// The node balance (nanoQNC) from three genesis answers, as the Node tab reads it: the largest of those not behind the
// wallet's claim watermark `floor` (ClaimTransit.answerFloor, acceptedBalance: a node behind it still holds a moved
// amount). null when none counts.
async function quorumBalance(nodeId, floor = null) {
  const answers = await Promise.all(
    Array.from({ length: 3 }, () => getPendingRewards(nodeId).catch(() => ({ success: false }))),
  );
  return acceptedBalance(answers, floor);
}

/**
 * A run of Move to wallet (services/MoveRun) as the `claim` answer takes it (qnet-link-v1 section 14.7): what its claims
 * moved as their records show (a last one taken in part counts its share, one that expired nothing), the last counted
 * claim's hash and stop (null once the whole balance moved, at least 1 QNC in all). `run` is for this device's screen.
 */
function claimAnswer(run) {
  if (run.refused) {
    const code = run.refused.code;
    return code === 'NO_REWARDS' || code === 'MIN_CLAIM' ? { status: 'empty' } : { status: 'error', error: 'CLAIM_REFUSED' };
  }
  const last = lastCountedPart(run);
  // every claim of the run expired: nothing was done
  if (!last) return { status: 'error', error: run.parts.length > 0 ? 'CLAIM_REFUSED' : 'INTERNAL' };
  const movedNano = runMovedNano(run);
  return {
    status: 'ok',
    amountNano: movedNano.toString(),
    txHash: typeof last.txHash === 'string' && TX_HASH_RE.test(last.txHash) ? last.txHash : null,
    stoppedAtEpoch: run.whole && movedNano >= BigInt(NANO_PER_QNC) ? null : (last.restEpoch ?? last.stoppedAtEpoch),
    run: { parts: run.parts.slice(), more: false, stop: run.stop, whole: run.whole },
  };
}

/**
 * The actions for the open wallet: `walletManager` holds it and `credential` opens it (the password, or the screen
 * lock's secret); `serverNode` whether the wallet has a super or genesis node; `claimBusy()` whether a move of its node
 * balance is running (the Node tab's or a sheet's) or in transit; `onUnlinked()` runs once this device's binding ended
 * (the Node tab reads again); `move({ nodeType, nodeId, balanceNano, until, onPart })` the screen's run of Move to
 * wallet (WalletScreen startMove: each part the network took is in transit from then on, as one from the Node tab;
 * null while another move runs); `onMoved()` once a move answered; `claimFloor()` the wallet's claim watermark
 * (ClaimTransit.answerFloor; null: none known), which the balance read is judged by; `height()` reads the block height as
 * the Node tab does (a promise; 0: none), which that tab's view of a device key is judged by.
 * The node balance, a move running and a move in transit are the wallet's, whichever of its node ids a move names: one
 * started for the super node holds a move of the light node's balance too, and the reverse.
 */
export function nodeLinkActions({
  walletManager, credential, serverNode = false, claimBusy = () => false, onUnlinked = () => {}, move = null,
  onMoved = () => {}, claimFloor = () => null, height = async () => 0,
}) {
  // Every status read here is one the user waits on: it decides as soon as two owners agree, never waiting for the third.
  const agreedStatus = (nodeId, signStatus = null) => readAgreedNodeStatus(nodeId, { signStatus, timeoutMs: FIRST_CONTACT_MS });
  const walletStatus = (nodeId) => agreedStatus(nodeId, (id, ts) => walletManager.signNodeStatus(credential, id, ts));
  // The wallet form of the unbind (contract 1.9b): the binding two owners name while a device is bound (S), withdrawn
  // with the wallet key's signature over it; with `onlySeqs`, only while S is one of those bindings (this device's own:
  // a binding another device took meanwhile is never withdrawn in its place). This device's own records are not touched.
  const unbindByWallet = async (nodeId, onlySeqs = null) => {
    const before = await walletStatus(nodeId).catch(() => null);
    if (!before || before.onChain === null) return { status: 'error', error: 'NETWORK' };
    if (before.onChain === false || before.deviceBoundAgreed === false) return { status: 'error', error: 'NOT_LINKED' };
    if (before.deviceBoundAgreed !== true || !Number.isSafeInteger(before.bindingSeqAgreed) || before.bindingSeqAgreed <= 0) {
      return { status: 'error', error: 'NETWORK' };
    }
    if (onlySeqs !== null && !onlySeqs.includes(before.bindingSeqAgreed)) return { status: 'error', error: 'UNLINK_REFUSED' };
    const seq = before.bindingSeqAgreed;
    const ts = Math.floor(Date.now() / 1000);
    const { sig, identityPublicKey } = await walletManager.signNodeUnbind(credential, nodeId, seq, ts);
    const r = await postUnbind(nodeId, { node_id: nodeId, seq, ts, signer: 'wallet', sig, identity_pubkey: identityPublicKey });
    if (r.ok && r.answer && r.answer.unbound === true) return { status: 'ok', unbound: true };
    if (!r.ok && r.reason === 'network') return { status: 'error', error: 'NETWORK' };
    // A newer binding, or one withdrawn meanwhile: the signed status tells whether any device is bound now.
    if (r.ok || r.reason === 'stale_seq') {
      const after = await walletStatus(nodeId).catch(() => null);
      if (after && after.onChain === true && after.deviceBoundAgreed === false) return { status: 'ok', unbound: true };
    }
    return { status: 'error', error: 'UNLINK_REFUSED' };
  };
  return {
    serverNode,
    // Whether the network holds a super or genesis node for the wallet: true or false when two genesis nodes agree
    // (WalletManager.confirmServerNode), null when they do not.
    otherNode: (qnet) => walletManager.confirmServerNode(qnet, { nodeType: 'super', timeoutMs: FIRST_CONTACT_MS }).catch(() => null),
    // aiqnet.io's record of the wallet's burn ({ state, nodeType }), null when it cannot be read (NodeRecordRead).
    record: (qnet) => readNodeRecordState(qnet).catch(() => null),
    status: (nodeId) => agreedStatus(nodeId),
    // Whether the chain lists the wallet's super node, as two genesis nodes say alike (true, false, or null).
    serverListed: (nodeId) => readServerNodeListed(nodeId, { timeoutMs: FIRST_CONTACT_MS }).catch(() => null),
    // The status signed with this device's ping key, which tells whether the network names this device's binding.
    pingStatus: (nodeId) => agreedStatus(nodeId, signStatusWithPingKey),
    // Whether the Node tab offers Use this device for this device's binding `local` by that status (NodeTab nodeView,
    // with the device check and key comparison the tab makes): a new binding mends what it shows. With no height, a
    // check-pending key with a rotation due cannot be told overdue or not, so a new binding mends it either way.
    offersUse: async (nodeId, status, local) => {
      const pending = !!status.signed && status.signed.deviceState === 'check_pending';
      const h = await Promise.resolve().then(height).catch(() => 0);
      if (pending && Number.isSafeInteger(status.signed.rotationDue) && !(h > 0)) return true;
      const check = pending ? await nodeCheckState(nodeId, local.seq).catch(() => null) : null;
      const tagOurs = local.hw && (status.deviceTags || []).length > 0
        ? await isThisDevice(status.nonce, status.deviceTags).catch(() => null) : null;
      return nodeView({ status: { ...status, tagOurs }, local, height: h, check }).offerUse === true;
    },
    device: () => checkDevice().catch(() => ({ capable: false, reason: 'device_unsupported' })),
    localNode,
    // This device's binding of the node ({ seq, boundAt, ... }), or null when this device does not run it.
    binding: (nodeId) => localBinding(nodeId),
    // The unlink of the binding this device holds, which the website asked for and the user confirmed: the ping key's
    // signed unbind with the device's release, then this device forgets the binding whatever the network answered. A
    // ping-key unbind the network did not take (no ping key here any more, a refusal) goes again in the wallet form
    // where two genesis nodes serve it, for this device's bindings only: the current one, and one sent from here with no
    // answer that the network may hold (stopLightNode ends both). Resolves { unbound }.
    unlink: async (nodeId) => {
      const local = await localBinding(nodeId);
      if (!local) return { unbound: false };
      try {
        const waiting = await readUnconfirmedBinding(nodeId);
        const r = await stopLightNode();
        if (r.unbound) return r;
        const status = await agreedStatus(nodeId).catch(() => null);
        if (!status || !status.features.includes('unbind_wallet') || status.deviceBoundAgreed !== true) return r;
        const w = await unbindByWallet(nodeId, waiting ? [local.seq, waiting.seq] : [local.seq]).catch(() => null);
        return { unbound: !!w && w.status === 'ok' };
      } finally {
        onUnlinked();
      }
    },
    // The unlink from any device that holds the wallet (contract 1.9b): the wallet key withdraws the binding the network
    // holds, whichever device it is on. { status: 'ok', unbound: true } or { status: 'error', error }.
    unlinkByWallet: async (nodeId) => {
      try {
        return await unbindByWallet(nodeId);
      } catch (_) {
        return { status: 'error', error: 'INTERNAL' };
      } finally {
        onUnlinked();
      }
    },
    balance: (nodeId) => quorumBalance(nodeId, claimFloor()),
    claimBusy: () => claimBusy(),
    reserve: ({ burner, time }) => walletManager.signNodeReservation(credential, { burner, time }),
    // `burner`: the wallet's own Solana address that made the burn, whose key signs its owner bind with the consent.
    consent: ({ nodeId, burnTx, burner = null, device, features }) => linkWithConsent({
      signer: walletManager, credential, nodeId, burnTx, burner, device, features, interactive: true,
    }),
    // The registration that consent is for, sent by this wallet itself (services/RegistrationSubmit): `job` { qnet,
    // burnTx, consent, until }; `onStage('admitted' | 'registered')` once aiqnet.io's route took it.
    register: (job, onStage) => sendRegistration(job, { onStage }).catch(() => null),
    // `known`: the status the sheet decided on (PushService.bindThisDevice).
    useDevice: ({ nodeId, device, known = null }) => bindThisDevice({ signer: walletManager, credential, nodeId, device, interactive: true, known }),
    // The move of the balance of the node the request names: the wallet's light or super node, whose id the quote the
    // wallet key signs and the claim both carry (claimRewards); any other id is refused before anything is signed. It is
    // the Node tab's run (`move`), from the balance the sheet showed, a next part only before `until` (ms); `onPart(view)`
    // hears each part. One answer, once the run ended.
    claim: async ({ nodeId, qnet, amountNano, until = null, onPart = () => {} }) => {
      const nodeType = ownNodeType(nodeId, qnet);
      if (nodeType === null) return { status: 'error', error: 'WALLET_MISMATCH' };
      if (typeof move !== 'function') return { status: 'error', error: 'INTERNAL' };
      if (claimBusy()) return { status: 'error', error: 'CLAIM_BUSY' };
      try {
        const run = await move({ nodeType, nodeId, balanceNano: amountNano, until, onPart });
        if (!run) return { status: 'error', error: 'CLAIM_BUSY' };
        const answer = claimAnswer(run);
        if (answer.status === 'ok') {
          try { onMoved(); } catch (_) { /* the screen's reads never change the answer */ }
        }
        return answer;
      } catch (e) {
        // No answer in time: the move may have gone through, and the site reads the chain for it. The wire says NETWORK
        // (the protocol has no code for an unknown outcome); `unknown` tells this device's screen never to say that
        // nothing changed (MN-R4-05). A node that says the balance is empty, or that a move is running already, is said
        // as such; nothing was submitted either way.
        if (e && e.unknown) return { status: 'error', error: 'NETWORK', unknown: true };
        if (e && (e.code === 'NO_REWARDS' || e.code === 'MIN_CLAIM')) return { status: 'empty' };
        return { status: 'error', error: e && e.code === 'CLAIM_BUSY' ? 'CLAIM_BUSY' : 'CLAIM_REFUSED' };
      }
    },
  };
}
