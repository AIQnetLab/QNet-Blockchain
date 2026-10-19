// The light activation window's line on the record of the node on the QNet network and its longer stay, through the
// real router and provider state machine and the window's own screens on the fake DOM (qnet_activateNode, QNet Link v1
// section 10). The move of a node balance is test/provider-node-claim.test.mjs.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../dist/background/config.js';
import { until } from './helpers/chrome-mock.mjs';
import { createPage } from './helpers/provider-dom.mjs';
import { NODE_ID, SITE, createWorld, replyTo, settleAll } from './helpers/provider-harness.mjs';

const ERROR_LINGER_MS = 30000;

let pageSeq = 0;
async function openPage(world, shown) {
  const page = createPage({
    query: `?id=${shown.id}`,
    runtime: world.chrome.runtime,
    send: (message) => world.router.handleUiMessage(message, shown.sender),
  });
  Object.assign(globalThis, { window: page.window, document: page.document, chrome: page.chrome });
  pageSeq += 1;
  await import(`../dist/ui/approve.js?record=${pageSeq}`);
  return page;
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.chrome;
});

describe('qnet_activateNode: the light node\'s record on the QNet network', () => {
  it('after a light answer the window shows the record and stays up to REGISTRATION_WINDOW_MS; the site result is unchanged', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.registration = { nodeId: NODE_ID, state: 'queued', attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: true };
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const shown = await w.shown();
    await shown.get();
    const resolved = (await shown.resolve(true)).result;
    assert.deepEqual(resolved.registration, { nodeId: NODE_ID, state: 'queued', automatic: true, deferred: false });
    const result = (await replyTo(port, 'a')).result;
    assert.deepEqual(Object.keys(result).sort(), ['burnAmount', 'burnTx', 'code', 'nodeType', 'qnet', 'solana', 'status']);
    await settleAll();
    w.fireTimers(ERROR_LINGER_MS);
    await settleAll();
    assert.equal(w.openWindows.has(shown.windowId), true, 'not the short linger while it is recorded');
    w.fireTimers(TIMINGS.REGISTRATION_WINDOW_MS);
    await until(() => !w.openWindows.has(shown.windowId));
  });

  it('the page follows the record after the answer, with no line on it before the confirm', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const w = createWorld();
    w.state.registration = { nodeId: NODE_ID, state: 'queued', attempts: 0, lastError: null, txHash: null, updatedAt: 1, automatic: true };
    const port = w.connect(`${SITE}/activate`);
    port.send({ id: 'a', method: 'qnet_activateNode', params: { nodeType: 'light' } });
    const page = await openPage(w, await w.shown());
    await until(() => page.app.button('Burn 1,500 1DEV') !== null);
    assert.ok(!page.app.textContent.includes('Then the wallet records its light node on QNet Blockchain'));
    const [ack] = page.app.querySelectorAll('input');
    t.mock.timers.tick(TIMINGS.CONFIRM_ARM_VALUE_MS);
    ack.checked = true;
    ack.fire('change');
    page.app.button('Burn 1,500 1DEV').click();
    await replyTo(port, 'a');
    await until(() => page.app.textContent.includes('Recording on QNet Blockchain'));
    w.state.registration = { ...w.state.registration, state: 'onchain', automatic: false };
    t.mock.timers.tick(TIMINGS.REGISTRATION_POLL_MS);
    await until(() => page.app.textContent.includes('Recorded on QNet Blockchain for this wallet.'));
  });
});
