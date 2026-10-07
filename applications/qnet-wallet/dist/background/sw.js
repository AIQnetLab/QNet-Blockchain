// Service worker entry (module). MV3 requires every listener to be registered synchronously on each
// start, so this file only wires: listeners first, then the asynchronous start-up work.
import * as activation from './activation.js';
import { notifyViews, setViewBroadcaster } from './events.js';
import * as keys from './keys.js';
import { log } from './log.js';
import * as nodes from './nodes.js';
import * as provider from './provider.js';
import * as qnet from './qnet.js';
import { createRouter } from './router.js';
import * as session from './session.js';
import * as vault from './vault.js';

// the router reaches a page whose relay holds no open port through its tab (chrome.tabs.sendMessage, EXT-F3): the
// lock, unlock and accountsChanged events come through after an idle worker closed every port
const router = createRouter({ tabs: chrome.tabs });
router.install();
provider.setEventSink(router.emitProviderEvent);
setViewBroadcaster(router.broadcastToViews);
// a light activation stored with its registration queued starts recording the node on the QNet network at once; a
// confirmed site request for it also has a record on chain read again ({recheck: true})
activation.setRegistrationHook((options) => nodes.resumeRegistration(options));

const guard = (tag) => (error) => log.error(tag, error?.code ?? error?.name);
// Fire and forget, whether `fn` throws, rejects or returns a value.
const background = (tag, fn) => {
  Promise.resolve().then(fn).catch(guard(tag));
};

session.onLockChange((change) => {
  notifyViews(change.reason === 'wipe' ? 'wiped' : change.locked ? 'locked' : 'unlocked');
  background('provider lock notify', () => provider.notifyLockChanged(change));
  if (!change.locked) {
    // After an unlock: resend signed transfers still pending, go on with a burn search a budget cut short
    // (R4-ESA-03), with the light node's registration, and bring aiqnet.io's record of the wallet's burn in line with
    // the vault (decision 35).
    background('resubmit pending', () => qnet.resubmitPending());
    background('burn search', () => activation.resumeBurnSearches());
    background('node registration', () => nodes.resumeRegistration());
    background('burn record', () => activation.syncRecord());
  }
});

chrome.runtime.onStartup.addListener(() => {
  session.lock('startup').catch(guard('startup lock'));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  session.onAlarm(alarm).catch(guard('alarm'));
  nodes.onAlarm(alarm).catch(guard('registration alarm'));
});
chrome.idle.onStateChanged.addListener((state) => {
  session.onIdleState(state).catch(guard('idle'));
});
chrome.windows.onRemoved.addListener((windowId) => {
  provider.onWindowRemoved(windowId).catch(guard('window removed'));
});

async function startup() {
  await session.initSession();
  // After initSession: storage.session is already limited to trusted contexts when the pass is read.
  await keys.startKeys();
  // a forgot-password restore this worker's predecessor stopped in the middle of leaves no staged copy (R5-ESM-03)
  await vault.discardRestoreStaging().catch(guard('restore staging'));
}

startup().catch(guard('startup'));
