/**
 * The Node side of a QNet Link request (services/QNetLink prepareOffer and performIntent): what the sheets read before
 * the user decides (the node's status from its shard owners, whether this device can run a node, this device's binding,
 * the node balance) and the things a confirmed request does (the reservation of the light node for the page's one-time
 * address, consent and a pending binding, a binding of this device, the end of the node's binding, a move of the
 * balance). The wallet screen makes one for the open wallet; every wallet-key signature is made by its WalletManager.
 * The end of a binding this device holds is signed by the node's ping key here (PushService.stopLightNode); the end of
 * a binding another device holds, by the wallet key, from any device that has the wallet (`unlinkByWallet`).
 */
import { postUnbind, readNodeStatus } from './LightNode';
import {
  bindThisDevice, getPendingRewards, linkWithConsent, localBinding, localNode, signStatusWithPingKey, stopLightNode,
} from './PushService';
import { checkDevice } from './NodeDeviceKey';
import { readNodeRecordState } from './NodeRecordRead';

const TX_HASH_RE = /^[0-9a-f]{64}$/;

// The node balance (nanoQNC): the largest of three genesis answers, as the Node tab reads it (a claim is re-verified on
// chain, so an honest node can only under-report). null when none answered.
async function quorumBalance(nodeId) {
  const answers = (await Promise.all(
    Array.from({ length: 3 }, () => getPendingRewards(nodeId).catch(() => ({ success: false }))),
  )).filter((r) => r && r.success && Number.isSafeInteger(r.pendingRewards));
  return answers.length > 0 ? answers.reduce((m, r) => Math.max(m, r.pendingRewards), 0) : null;
}

// A move's outcome as the `claim` answer takes it (qnet-link-v1 section 14.7).
function claimAnswer(result) {
  if (!result || result.success !== true) {
    return result && (result.code === 'NO_REWARDS' || result.code === 'MIN_CLAIM')
      ? { status: 'empty' } : { status: 'error', error: 'CLAIM_REFUSED' };
  }
  const nano = typeof result.amountNano === 'string' && /^[0-9]+$/.test(result.amountNano)
    ? result.amountNano : BigInt(Math.round(Number(result.amount || 0) * 1e9)).toString();
  return {
    status: 'ok',
    amountNano: nano,
    txHash: typeof result.txHash === 'string' && TX_HASH_RE.test(result.txHash) ? result.txHash : null,
    stoppedAtEpoch: Number.isSafeInteger(result.stoppedAtEpoch) ? result.stoppedAtEpoch : null,
  };
}

/**
 * The actions for the open wallet: `walletManager` holds it and `credential` opens it (the password, or the screen
 * lock's secret); `serverNode` whether the wallet has a super or genesis node; `claimBusy()` whether a move of its node
 * balance is running on the Node tab; `onUnlinked()` runs once this device's binding ended (the Node tab reads again).
 */
export function nodeLinkActions({
  walletManager, credential, serverNode = false, claimBusy = () => false, onUnlinked = () => {},
}) {
  let moving = false;
  const walletStatus = (nodeId) => readNodeStatus(nodeId, { signStatus: (id, ts) => walletManager.signNodeStatus(credential, id, ts) });
  // The wallet form of the unbind (contract 1.9b): the binding two owners name while a device is bound (S), withdrawn
  // with the wallet key's signature over it. This device's own records are not touched here.
  const unbindByWallet = async (nodeId) => {
    const before = await walletStatus(nodeId).catch(() => null);
    if (!before || before.onChain === null) return { status: 'error', error: 'NETWORK' };
    if (before.onChain === false || before.deviceBoundAgreed === false) return { status: 'error', error: 'NOT_LINKED' };
    if (before.deviceBoundAgreed !== true || !Number.isSafeInteger(before.bindingSeqAgreed) || before.bindingSeqAgreed <= 0) {
      return { status: 'error', error: 'NETWORK' };
    }
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
    otherNode: (qnet) => walletManager.confirmServerNode(qnet, { nodeType: 'super' }).catch(() => null),
    // aiqnet.io's record of the wallet's burn ({ state, nodeType }), null when it cannot be read (NodeRecordRead).
    record: (qnet) => readNodeRecordState(qnet).catch(() => null),
    status: (nodeId) => readNodeStatus(nodeId),
    // The status signed with this device's ping key, which tells whether the network names this device's binding.
    pingStatus: (nodeId) => readNodeStatus(nodeId, { signStatus: signStatusWithPingKey }),
    device: () => checkDevice().catch(() => ({ capable: false, reason: 'device_unsupported' })),
    localNode,
    // This device's binding of the node ({ seq, boundAt, ... }), or null when this device does not run it.
    binding: (nodeId) => localBinding(nodeId),
    // The unlink of the binding this device holds, which the website asked for and the user confirmed: the ping key's
    // signed unbind with the device's release, then this device forgets the binding whatever the network answered. A
    // ping-key unbind the network did not take (no ping key here any more, a refusal) goes again in the wallet form
    // where two genesis nodes serve it. Resolves { unbound }.
    unlink: async (nodeId) => {
      if (!(await localBinding(nodeId))) return { unbound: false };
      try {
        const r = await stopLightNode();
        if (r.unbound) return r;
        const status = await readNodeStatus(nodeId).catch(() => null);
        if (!status || !status.features.includes('unbind_wallet') || status.deviceBoundAgreed !== true) return r;
        const w = await unbindByWallet(nodeId).catch(() => null);
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
    balance: quorumBalance,
    claimBusy: () => moving || claimBusy(),
    reserve: ({ burner, time }) => walletManager.signNodeReservation(credential, { burner, time }),
    // `burner`: the wallet's own Solana address that made the burn, whose key signs its owner bind with the consent.
    consent: ({ nodeId, burnTx, burner = null, device, features }) => linkWithConsent({
      signer: walletManager, credential, nodeId, burnTx, burner, device, features, interactive: true,
    }),
    useDevice: ({ nodeId, device }) => bindThisDevice({ signer: walletManager, credential, nodeId, device, interactive: true }),
    claim: async ({ nodeId, qnet, amountNano }) => {
      if (moving || claimBusy()) return { status: 'error', error: 'CLAIM_BUSY' };
      moving = true;
      try {
        return claimAnswer(await walletManager.claimRewards('light', qnet, credential, amountNano, nodeId));
      } catch (e) {
        // No answer in time: the move may have gone through, and the site reads the chain for it. The wire says NETWORK
        // (the protocol has no code for an unknown outcome); `unknown` tells this device's screen never to say that
        // nothing changed (MN-R4-05). A node that says the balance is empty, or that a move is running already, is said
        // as such; nothing was submitted either way.
        if (e && e.unknown) return { status: 'error', error: 'NETWORK', unknown: true };
        if (e && (e.code === 'NO_REWARDS' || e.code === 'MIN_CLAIM')) return { status: 'empty' };
        return { status: 'error', error: e && e.code === 'CLAIM_BUSY' ? 'CLAIM_BUSY' : 'CLAIM_REFUSED' };
      } finally {
        moving = false;
      }
    },
  };
}
