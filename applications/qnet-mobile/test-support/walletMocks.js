/* eslint-env jest */
/**
 * The wallet screen's WalletManager and PushService under Jest, each loaded inside a suite's jest.mock factory: a sealed
 * vault any password opens into one wallet, every WalletManager method a suite does not give answering null, and every
 * push service call answering as with no node bound to this device. A suite gives only what its tests read.
 */

// A new wallet's recovery phrase, and the word list beside it: its words and four more a check of the phrase offers.
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const WORD_LIST = [...WORDS, 'zebra', 'zero', 'zone', 'zoo'];

/**
 * The class a suite's FakeWalletManager extends: the wallet of QNet address `qnet` and Solana address `sol`, its trusted
 * `nodes`, and the ids of the light and super node derived from it.
 */
function fakeWalletManager({ qnet, sol, light = null, superNode = null, nodes = [] }) {
  class FakeWalletManager {
    constructor() {
      return new Proxy(this, {
        get: (target, prop) => {
          if (prop in target || typeof prop === 'symbol' || prop === 'then') return target[prop];
          return async () => null;
        },
      });
    }
    async prepareInstall() {}
    async vaultState() { return 'sealed'; }
    async isBiometricEnabled() { return false; }
    async isBiometricSupported() { return false; }
    async getPasswordLockStatus() { return { locked: false }; }
    async unlockWithPassword() { return { ok: true, token: 'session-token' }; }
    async checkPassword() { return { ok: true }; }
    async loadWallet() { return { address: sol, solanaAddress: sol, publicKey: sol, qnetAddress: qnet }; }
    getBIP39WordList() { return WORD_LIST; }
    getTrustedNodes() { return nodes; }
    trustedNodeUrl() { return nodes[0] || 'https://node.invalid'; }
    async deviceAuthAvailable() { return false; }
    generateQNetAddressFromSolana() { return qnet; }
    generateLightNodePseudonym() { return light; }
    generateSuperNodePseudonym() { return superNode; }
    sessionOpen() { return true; }
    closeSession() {}
  }
  FakeWalletManager.MIN_PASSWORD_LENGTH = 8;
  FakeWalletManager.publicWallet = (w) => ({ ...w });
  FakeWalletManager.canonicalAddress = (a) => a;
  return FakeWalletManager;
}

// The WalletManager module a jest.mock factory returns for `Fake`: fakeWalletManager's class, or a class extending it.
function walletManagerModule(Fake) {
  class VaultCorruptError extends Error {}
  return { __esModule: true, default: Fake, WalletManager: Fake, VaultCorruptError };
}

// WalletManager.recipientAddress's rule: value goes only to a checksummed EON address; 64 hex is a contract or a hash.
function recipientAddress(a) {
  if (!/^[0-9a-f]{19}eon[0-9a-f]{23}$/.test(String(a))) throw Object.assign(new Error('not an account'), { code: 'HEX_RECIPIENT' });
  return a;
}

// The PushService module: every call answering as with no node bound to this device, the suite's `own` in their place.
function pushServiceModule(own = {}) {
  return {
    LAST_ANSWER_KEY: 'qnet_last_self_attest_at',
    BG_REFRESH_STATUS_KEY: 'qnet_bg_refresh_status',
    readUnconfirmedBinding: jest.fn(async () => null),
    settleUnconfirmedBinding: jest.fn(async () => false),
    readdressIfOwed: jest.fn(async () => false),
    localBinding: jest.fn(async () => null),
    localNode: jest.fn(async () => null),
    forgetIfReplaced: jest.fn(async () => false),
    signStatusWithPingKey: jest.fn(async () => null),
    stopLightNode: jest.fn(async () => ({ unbound: true })),
    bindThisDevice: jest.fn(async () => ({ ok: true })),
    selfAttestIfNeeded: jest.fn(async () => false),
    checkServerNodeStatus: jest.fn(async () => ({ success: false, error: 'network' })),
    getWalletNodeEvents: jest.fn(async () => ({ success: true, nodes: [] })),
    getNodeEpochs: jest.fn(async () => null),
    getPendingRewards: jest.fn(async () => ({ success: true, pendingRewards: 0 })),
    refreshFcmTokenOnServer: jest.fn(async () => ({})),
    isTokenRefreshNeeded: jest.fn(async () => false),
    teardownLightNode: jest.fn(async () => {}),
    teardownLightNodeIfForeign: jest.fn(async () => {}),
    resendPendingBinding: jest.fn(async () => false),
    enrolAgainIfUnleased: jest.fn(async () => false),
    nodeCheckState: jest.fn(async () => null),
    endExpiredLink: jest.fn(async () => false),
    settleUnansweredKey: jest.fn(async () => null),
    refreshLeaseFromTab: jest.fn(async () => false),
    ...own,
  };
}

module.exports = { WORDS, fakeWalletManager, walletManagerModule, recipientAddress, pushServiceModule };
