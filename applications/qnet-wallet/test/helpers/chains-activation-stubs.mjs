// Stand-in for session.js, vault.js and keys.js in the chains-activation tests (see the loader). Every
// call goes to the environment the test installed with chains-activation-env.mjs.
const env = () => {
  const current = globalThis.__qnetChainsEnv;
  if (!current) throw new Error('chains-activation env not installed');
  return current;
};

export const requireUnlocked = (...args) => env().session.requireUnlocked(...args);
export const touch = (...args) => env().session.touch(...args);
export const cachedViews = (...args) => env().session.cachedViews(...args);
export const forgetViews = (...args) => env().session.forgetViews(...args);

export const readState = (...args) => env().vault.readState(...args);
export const updateState = (...args) => env().vault.updateState(...args);
export const verifyPassword = (...args) => env().vault.verifyPassword(...args);
export const readLightAnchors = (...args) => env().vault.readLightAnchors(...args);
export const writeLightAnchors = (...args) => env().vault.writeLightAnchors(...args);
export const readChainCache = (...args) => env().vault.readChainCache(...args);
export const updateChainCache = (...args) => env().vault.updateChainCache(...args);
export const readBurnScan = (...args) => env().vault.readBurnScan(...args);
export const writeBurnScan = (...args) => env().vault.writeBurnScan(...args);
// vault.withRecipient is pure: the same rule as the shipped one (RECIPIENTS_MAX 128, newest last).
export const withRecipient = (state, address) => ({
  ...state, recipients: [...state.recipients.filter((known) => known !== address), address].slice(-128),
});
export const withSolanaRecipient = (state, address) => ({
  ...state, solanaRecipients: [...state.solanaRecipients.filter((known) => known !== address), address].slice(-128),
});
// vault.withRecentTransfer / liveRecentTransfers: the same rules (RECENT_TRANSFERS_MAX 64, RECENT_TRANSFER_MS 30 min).
export const RECENT_TRANSFER_MS = 30 * 60 * 1000;
export const liveRecentTransfers = (state, since) => state.recentTransfers.filter((r) => r.createdAt >= since);
export const withRecentTransfer = (state, transfer) => ({
  ...state,
  recentTransfers: [...liveRecentTransfers(state, transfer.createdAt - RECENT_TRANSFER_MS),
    { to: transfer.to, amountNano: transfer.amountNano, createdAt: transfer.createdAt }].slice(-64),
});

export const signQnetTransfer = (...args) => env().keys.signQnetTransfer(...args);
export const signQnetTokenTransfer = (...args) => env().keys.signQnetTokenTransfer(...args);
export const signQnetContractCall = (...args) => env().keys.signQnetContractCall(...args);
export const signSolanaMessage = (...args) => env().keys.signSolanaMessage(...args);
export const getQnetPublicKey = (...args) => env().keys.getQnetPublicKey(...args);
export const signingEnabled = (...args) => env().keys.signingEnabled(...args);
export const signNodeRegistration = (...args) => env().keys.signNodeRegistration(...args);
export const signNodeClaim = (...args) => env().keys.signNodeClaim(...args);
export const signClaimPayload = (...args) => env().keys.signClaimPayload(...args);
export const signNodeStatus = (...args) => env().keys.signNodeStatus(...args);
export const signNodeUnbind = (...args) => env().keys.signNodeUnbind(...args);
export const signBurnRecord = (...args) => env().keys.signBurnRecord(...args);
export const signReservation = (...args) => env().keys.signReservation(...args);
