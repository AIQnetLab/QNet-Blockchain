// The linked device by its model (owner, 06.10: the Device tab shows the device itself, not only its platform): the
// public status's `device.model`, which QNet Wallet sends with each binding and the node keeps with it, read by the
// site route with the node's own rule, passed on to the page exactly, and shown as "{model} · {platform}". Device names
// here are made up. Run: npm run test:wallet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeStatus, parsePublicStatus } from '../../server/cabinet/node-proxy.ts';
import { DEVICE_MODEL_MAX, deviceName, isDeviceModel, parseStatusView } from '../cabinet/node-view.ts';
import { TEXTS } from '../texts.ts';

const SRC = new URL('../../', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);
const read = (base, path) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');

const status = (over = {}) => ({
  onchain_registered: true, registration_pending: false, device_bound: true, answered_this_epoch: true, needs_reactivation: false,
  counted: { epochs_since_registration: 6, counted: 5, last_counted_epoch: 155 }, features: ['bind_v2'], ...over,
});
const device = (over = {}) => ({ platform: 'android', model: 'Acme Phone 7', linked_since: 1_789_948_800, last_answer_epoch: 155, state: 'online', ...over });

test('a model is what the node keeps: 1 to 40 ASCII letters, digits, spaces and . , + ( ) / -, trimmed', () => {
  assert.equal(DEVICE_MODEL_MAX, 40);
  for (const ok of ['Acme Phone 7', 'Acme X-2 (5G), 128/8+', 'a'.repeat(40)]) assert.equal(isDeviceModel(ok), true, ok);
  for (const bad of ['', ' Acme 7', 'Acme 7 ', 'a'.repeat(41), "Ann's Phone 7", 'Phoneé', '<b>7</b>', 'a\nb', 7, null, undefined]) {
    assert.equal(isDeviceModel(bad), false, String(bad));
  }
  // One rule for the node, the app and the site.
  const node = read(REPO, 'development/qnet-integration/src/light_binding.rs');
  assert.match(node, /pub const MODEL_HINT_MAX: usize = 40;/);
  assert.match(node, /b\.is_ascii_alphanumeric\(\) \|\| b" \.,\+\(\)\/-"\.contains\(&b\)/);
  const app = read(REPO, 'applications/qnet-mobile/src/services/DeviceModel.js');
  assert.match(app, /export const MODEL_MAX = 40;/);
  assert.match(app, /const MODEL_RE = \/\^\[A-Za-z0-9 \.,\+\(\)\/-\]\+\$\/;/);
});

test('the route reads the model with the node\'s rule; one it cannot read is none, and the status still reads', () => {
  assert.equal(parsePublicStatus(status({ device: device() })).device.model, 'Acme Phone 7');
  const { model: _absent, ...older } = device();
  assert.equal(parsePublicStatus(status({ device: older })).device.model, null, 'a node of an earlier version names none');
  for (const bad of [null, '<b>x</b>', 'a'.repeat(41), 7, ' Acme 7', { name: 'x' }]) {
    const s = parsePublicStatus(status({ device: device({ model: bad }) }));
    assert.equal(s.device.model, null, JSON.stringify(bad));
    assert.equal(s.device.platform, 'android');
  }
});

test('the page takes the first settling answer\'s model exactly, beside the platform', () => {
  const a = parsePublicStatus(status({ device: device() }));
  const b = parsePublicStatus(status({ device: device({ model: 'Acme Tab 3', state: 'offline' }) }));
  const view = mergeStatus(a, b, '0');
  assert.deepEqual([view.device.platform, view.device.model], ['android', 'Acme Phone 7']);
  assert.deepEqual(parseStatusView(view), view);
  assert.deepEqual(parseStatusView(mergeStatus(parsePublicStatus(status({ device: device({ model: undefined }) })), a, '0')).device.model, null);
  assert.equal(parseStatusView({ ...view, device: { ...view.device, model: '<b>x</b>' } }), null);
  assert.equal(parseStatusView({ ...view, device: { ...view.device, model: 7 } }), null);
  const { model: _gone, ...noKey } = view.device;
  assert.equal(parseStatusView({ ...view, device: noKey }), null, 'the key is always there');
});

test('the Device tab names the device as "{model} · {platform}", the platform alone without a model', () => {
  assert.equal(deviceName({ platform: 'android', model: 'Acme Phone 7' }), `Acme Phone 7 · ${TEXTS.device_platform_android}`);
  assert.equal(deviceName({ platform: 'ios', model: 'Acme Tab 3' }), `Acme Tab 3 · ${TEXTS.device_platform_ios_short}`);
  assert.equal(deviceName({ platform: 'unknown', model: 'Acme Phone 7' }), 'Acme Phone 7');
  assert.equal(deviceName({ platform: 'android', model: null }), TEXTS.device_platform_android);
  assert.equal(deviceName({ platform: 'ios', model: null }), TEXTS.device_platform_ios);
  assert.equal(deviceName({ platform: 'unknown', model: null }), TEXTS.device_platform_unknown);
  assert.equal(deviceName({ platform: null, model: null }), null);
  assert.equal(TEXTS.device_model_platform, '{model} · {platform}');
  const rows = read(SRC, 'components/cabinet/NodeStatus.tsx');
  assert.match(rows, /\{full && named && deviceName\(named\) && <p>\{deviceName\(named\)\}<\/p>\}/);
  assert.doesNotMatch(rows, /device_platform_/);
});

// H-1 (06.10): a typed address is only viewed, so the Device tab shows its platform without the model.
test('a typed address: the platform alone, never the model', () => {
  const rows = read(SRC, 'components/cabinet/NodeStatus.tsx');
  assert.match(rows, /const named = device && viewOnly \? \{ platform: device\.platform, model: null \} : device;/);
  assert.equal(deviceName({ platform: 'android', model: null }), TEXTS.device_platform_android);
});
