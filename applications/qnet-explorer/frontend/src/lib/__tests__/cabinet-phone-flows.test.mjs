// CABINET_PHONE_FLOWS (unified plan SITE-8, rollout R5 and R8; src/server/phone-flows.ts): off unless it is exactly
// "1". Off, the relay opens only `connect` sessions and the cabinet offers no `link`, `claim` or `reserve` request to
// QNet Wallet: its read pages, I'm back and the extension's paths stay. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHONE_FLOWS_ENV, phoneFlowsEnabled } from '../../server/phone-flows.ts';
import { createLinkRelay } from '../../server/link-relay.ts';
import { LINK } from './link-helpers.mjs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
let scopes = 0;

test('on only with the value 1', () => {
  assert.equal(PHONE_FLOWS_ENV, 'CABINET_PHONE_FLOWS');
  assert.equal(phoneFlowsEnabled({ CABINET_PHONE_FLOWS: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 'on']) {
    assert.equal(phoneFlowsEnabled({ CABINET_PHONE_FLOWS: value }), false, String(value));
  }
  assert.equal(phoneFlowsEnabled({}), false);
});

test('off, the relay refuses link, claim and reserve sessions and still opens connect', async () => {
  const relay = createLinkRelay({
    intents: ['connect'],
    clientKey: () => ({ ok: true, ip: '203.0.113.7' }),
    scope: `flows${(scopes += 1)}`,
    devOrigins: false,
  });
  const post = (body) => new Request('https://aiqnet.io/api/link/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'aiqnet.io' },
    body: JSON.stringify(body),
  });
  for (const name of ['link-ok-check', 'claim-ok', 'reserve-ok']) {
    const res = await relay.createSession(post(LINK.cases.find((c) => c.name === name).sessionRequest));
    assert.equal(res.status, 404, name);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_available' });
  }
  assert.equal(relay.size(), 0);
  const connect = await relay.createSession(post(LINK.cases.find((c) => c.name === 'connect-ok').sessionRequest));
  assert.equal(connect.status, 201);
});

test('one flag for the relay and the pages: the process relay, the layout, and each page that sends link or claim', () => {
  assert.match(read('server/link-relay.ts'), /createLinkRelay\(\{ intents: phoneFlowsEnabled\(\) \? INTENTS : \['connect'\] \}\)/);
  assert.match(read('app/node/layout.tsx'), /<CabinetProvider phoneFlows=\{phoneFlowsEnabled\(\)\}>/);
  // The pages ask the provider, never the environment.
  for (const file of ['components/cabinet/LinkDevice.tsx', 'components/cabinet/UnlinkDevice.tsx', 'components/cabinet/NodeClaim.tsx', 'components/cabinet/NodeActivate.tsx']) {
    const src = read(file);
    assert.match(src, /, phoneFlows \} = useCabinet\(\);/, file);
    assert.doesNotMatch(src, /process\.env|CABINET_PHONE_FLOWS/, file);
  }
  // Closed, Link a device is still a card of its own that names the app's way (review, 28.09: it was fine print).
  assert.match(read('components/cabinet/LinkDevice.tsx'), /if \(!phoneFlows\) \{\s*return \(\s*<div className="activate-card">\s*<h3 className="activate-step">\{t\('action_link_device'\)\}<\/h3>\s*<p>\{t\('devices_link_closed'\)\}<\/p>\s*<\/div>\s*\);\s*\}/);
  // Closed, Unlink this device is a card of its own too, saying how the node leaves a device meanwhile.
  // Unlink: closed without the phone flows, unless the extension that holds the wallet signs the wallet's own unbind.
  assert.match(read('components/cabinet/UnlinkDevice.tsx'), /if \(!phoneFlows && !extension\) \{\s*return \(\s*<div className="activate-card">\s*<h3 className="activate-step">\{t\(wallet \? 'unlink_title_wallet' : 'unlink_title'\)\}<\/h3>\s*<p>\{t\('unlink_closed'\)\}<\/p>\s*<\/div>\s*\);\s*\}/);
  assert.match(read('components/cabinet/UnlinkDevice.tsx'), /const app = phoneFlows && \(/);
  // A phone that cannot activate here yet is led to the computer's way.
  assert.match(read('components/cabinet/NodeActivate.tsx'), /\{device\?\.phone && <Link href=\{`\$\{GUIDE_HREF\}\?way=computer`\} className="qnet-button secondary">\{t\('guide_show_computer'\)\}<\/Link>\}/);
  assert.match(read('components/cabinet/NodeActivate.tsx'), /const paymentCard = phoneFlows \? \(/);
  // The page reads it on the server only.
  assert.doesNotMatch(read('components/cabinet/CabinetProvider.tsx'), /process\.env/);
});
