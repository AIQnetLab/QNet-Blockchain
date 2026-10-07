// The QNet Link confirmation screen: nothing is shared without Confirm (armed after a second) and a fresh
// authentication; Reject answers `rejected` with no authentication and nothing performed; a refused or unavailable
// request performs nothing; and the one thing a request can do is share this wallet's two addresses.
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';

jest.mock('../src/services/QNetLink', () => {
  const actual = jest.requireActual('../src/services/QNetLink');
  return {
    ...actual,
    openSession: jest.fn(),
    prepareOffer: jest.fn(),
    performIntent: jest.fn(),
    deliverAnswer: jest.fn(async () => 'delivered'),
    markHandled: jest.fn(async () => {}),
  };
});

const QNetLink = require('../src/services/QNetLink');
const QNetLinkScreen = require('../src/screens/QNetLinkScreen').default;

const t = require('../src/i18n').makeT('en'); // the app's translator: English, placeholders filled
const CONNECT = { id: 'c'.repeat(32), sitePub: 'd'.repeat(43), intent: 'connect' };
const ADDRESSES = { qnet: 'd9fa370374e24333242eon847d1d354dcd87fe873823e', solana: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' };
const OFFER = { kind: 'connect', addresses: ADDRESSES };
const OK = { status: 'ok', ...ADDRESSES };

const texts = (tree) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join('\n');
const buttons = (tree) => tree.root.findAllByType(TouchableOpacity)
  .map((b) => ({ label: b.findAllByType(Text).map((n) => [].concat(n.props.children).join('')).join(''), props: b.props }));
const button = (tree, label) => buttons(tree).find((b) => b.label === label);
const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));
// A real press: the finger goes down (onPressIn), then the press ends (onPress). Only a press that began after the
// button armed counts (utils/useArmedConfirm).
const press = async (b) => { if (b.props.onPressIn) b.props.onPressIn(); await b.props.onPress(); };
const ARMED = 1100; // ARM_MS + a margin

let props;
async function mount(link, extra = {}) {
  props = {
    link, wallet: { qnetAddress: ADDRESSES.qnet, solanaAddress: ADDRESSES.solana }, t,
    authenticate: jest.fn(async () => true), onClose: jest.fn(), onSettled: jest.fn(), ...extra,
  };
  let tree;
  await act(async () => { tree = renderer.create(<QNetLinkScreen {...props} />); });
  await wait(0);
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  QNetLink.openSession.mockResolvedValue({ expiresAt: Date.now() + 500000 });
  QNetLink.prepareOffer.mockResolvedValue(OFFER);
  QNetLink.performIntent.mockResolvedValue(OK);
});

describe('a connect request', () => {
  it('says where it came from and shows both addresses before anything is shared', async () => {
    const tree = await mount(CONNECT);
    const shown = texts(tree);
    for (const s of [t('link_origin'), t('link_title_connect'), t('link_started_here'), t('link_connect_body'),
      ADDRESSES.qnet, ADDRESSES.solana]) {
      expect(shown).toContain(s);
    }
    expect(QNetLink.openSession).toHaveBeenCalledWith(CONNECT);
    expect(QNetLink.prepareOffer).toHaveBeenCalledWith(CONNECT, { wallet: props.wallet, session: expect.any(Object), node: null });
    expect(QNetLink.deliverAnswer).not.toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('Reject answers `rejected` with no authentication and nothing performed', async () => {
    const tree = await mount(CONNECT);
    await act(async () => { await button(tree, 'Reject').props.onPress(); });
    expect(props.authenticate).not.toHaveBeenCalled();
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(QNetLink.markHandled).toHaveBeenCalledWith(CONNECT.id);
    expect(props.onSettled).toHaveBeenCalled();
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), { status: 'rejected' }, expect.any(Object));
    expect(texts(tree)).toContain(t('link_result_rejected'));
    await act(async () => { tree.unmount(); });
  });

  it('Confirm does nothing before it is armed, and nothing without the authentication', async () => {
    const tree = await mount(CONNECT);
    expect(button(tree, 'Confirm').props.disabled).toBe(true);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).not.toHaveBeenCalled();
    await wait(ARMED);
    expect(button(tree, 'Confirm').props.disabled).toBe(false);
    props.authenticate.mockResolvedValueOnce(false);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_connect'));
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(QNetLink.deliverAnswer).not.toHaveBeenCalled();
    expect(QNetLink.markHandled).not.toHaveBeenCalled();
    expect(button(tree, 'Reject')).toBeDefined(); // still deciding
    await act(async () => { tree.unmount(); });
  });

  it('Confirm with the authentication shares exactly the offered addresses, once', async () => {
    const tree = await mount(CONNECT);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    await act(async () => { const b = button(tree, 'Confirm'); if (b) await press(b); }); // a second tap shares nothing more
    expect(QNetLink.performIntent).toHaveBeenCalledTimes(1);
    expect(QNetLink.performIntent.mock.calls[0]).toEqual([CONNECT, OFFER, { node: null }]);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), OK, expect.any(Object));
    const shown = texts(tree);
    expect(shown).toContain(t('link_result_connect'));
    expect(shown).toContain(t('link_delivered'));
    expect(buttons(tree).map((b) => b.label)).toEqual(['Close']);
    await act(async () => { tree.unmount(); });
  });

  it('a request that has expired by the time of Confirm performs nothing', async () => {
    QNetLink.openSession.mockResolvedValue({ expiresAt: Date.now() + 500 });
    const tree = await mount(CONNECT);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).not.toHaveBeenCalled();
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(texts(tree)).toContain(t('link_expired_now'));
    await act(async () => { tree.unmount(); });
  });

  // MBL-05: a page that keeps the user tapping at the Confirm spot never turns a stray tap into a confirmation.
  it('every touch on the screen before it arms starts the wait again', async () => {
    const tree = await mount(CONNECT);
    const root = tree.root.findAll((n) => n.props && typeof n.props.onTouchStart === 'function')[0];
    await wait(700);
    await act(async () => { root.props.onTouchStart(); });
    await wait(700);
    expect(button(tree, 'Confirm').props.disabled).toBe(true); // 1.4 s since mount, 0.7 s since the touch
    await wait(ARMED - 700);
    expect(button(tree, 'Confirm').props.disabled).toBe(false);
    await act(async () => { tree.unmount(); });
  });

  it('a press that began before it armed does nothing when it ends after', async () => {
    const tree = await mount(CONNECT);
    await act(async () => { button(tree, 'Confirm').props.onPressIn(); }); // the finger is already down
    await wait(ARMED);
    await act(async () => { await button(tree, 'Confirm').props.onPress(); });
    expect(props.authenticate).not.toHaveBeenCalled();
    await act(async () => { await press(button(tree, 'Confirm')); }); // a new press after arming counts
    expect(props.authenticate).toHaveBeenCalledTimes(1);
    await act(async () => { tree.unmount(); });
  });

  it('leaving the app disarms it; coming back starts the wait again', async () => {
    const { AppState } = require('react-native');
    const listeners = [];
    const original = AppState.addEventListener;
    AppState.addEventListener = (type, fn) => {
      listeners.push(fn);
      return { remove: () => {} };
    };
    const tree = await mount(CONNECT);
    await wait(ARMED);
    expect(button(tree, 'Confirm').props.disabled).toBe(false);
    await act(async () => { listeners.forEach((fn) => fn('background')); });
    expect(button(tree, 'Confirm').props.disabled).toBe(true);
    await act(async () => { listeners.forEach((fn) => fn('active')); });
    expect(button(tree, 'Confirm').props.disabled).toBe(true);
    await wait(ARMED);
    expect(button(tree, 'Confirm').props.disabled).toBe(false);
    await act(async () => { tree.unmount(); });
    AppState.addEventListener = original;
  });

  it('an offer that could not be read is shown as such, and Close answers only INTERNAL', async () => {
    QNetLink.prepareOffer.mockRejectedValue(new Error('boom'));
    const tree = await mount(CONNECT);
    expect(texts(tree)).toContain(t('link_err_INTERNAL'));
    expect(button(tree, 'Confirm')).toBeUndefined();
    await act(async () => { await button(tree, 'Close').props.onPress(); });
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), { status: 'error', error: 'INTERNAL' });
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });
});

describe('refusals', () => {
  it.each([['mismatch', 'link_refused_mismatch'], ['answered', 'link_refused_answered'], ['handled', 'link_refused_handled'],
    ['not_found', 'link_refused_not_found'], ['network', 'link_refused_network']])(
    'a %s session shows why and does nothing else', async (reason, key) => {
      QNetLink.openSession.mockRejectedValue(new QNetLink.LinkRefusal(reason));
      const tree = await mount(CONNECT);
      expect(texts(tree)).toContain(t(key));
      expect(QNetLink.prepareOffer).not.toHaveBeenCalled();
      expect(QNetLink.performIntent).not.toHaveBeenCalled();
      expect(QNetLink.deliverAnswer).not.toHaveBeenCalled();
      expect(buttons(tree).map((b) => b.label)).toEqual(['Close']);
      await act(async () => { tree.unmount(); });
    },
  );

  it('with no wallet on the phone the site learns only that, and nothing is shown to confirm', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'unavailable', error: 'NO_WALLET' });
    const tree = await mount(CONNECT, { wallet: null });
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), { status: 'error', error: 'NO_WALLET' }, expect.any(Object));
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(texts(tree)).toContain(t('link_err_NO_WALLET'));
    expect(button(tree, 'Confirm')).toBeUndefined();
    await act(async () => { tree.unmount(); });
  });
});

// R4-MOBLINK-01: the owner learns when the user has the request in front of them (from then on no other link takes its
// place) and when the screen goes (it closes any prompt it opened); a request that waited says so before Confirm.
describe('the screen tells its owner when it is up and when it goes', () => {
  it('onShown on mount, onGone on unmount, and the note for a request that arrived meanwhile', async () => {
    const onShown = jest.fn();
    const onGone = jest.fn();
    const tree = await mount(CONNECT, { onShown, onGone, afterOther: true });
    expect(onShown).toHaveBeenCalledTimes(1);
    expect(onGone).not.toHaveBeenCalled();
    expect(texts(tree)).toContain(t('link_after_other'));
    await act(async () => { tree.unmount(); });
    expect(onGone).toHaveBeenCalledTimes(1);
    const plain = await mount(CONNECT);
    expect(texts(plain)).not.toContain(t('link_after_other'));
    await act(async () => { plain.unmount(); });
  });
});

// R4-MOBLINK-02: anyone can mint a link.aiqnet.io link for a relay session of their own, so the wallet cannot know which
// website asks: no screen, prompt or result names aiqnet.io as the one that receives what is shared.
describe('the screens say only what the wallet knows about who asks', () => {
  const translations = require('../src/i18n/translations').default;

  it('the request comes through aiqnet.io; what is shared goes to the website that showed the link', async () => {
    expect(t('link_origin')).toBe('Request through aiqnet.io');
    expect(t('link_started_here')).toMatch(/cannot check which website made this link/);
  });

  it('in every language, no text about what is shared names aiqnet.io as its recipient', () => {
    const keys = ['link_connect_body', 'link_auth_connect', 'link_result_connect', 'link_link_body', 'link_auth_link',
      'link_auth_claim', 'link_check_hint', 'link_title_reserve', 'link_reserve_body', 'link_auth_reserve', 'link_result_reserve'];
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of keys) {
        expect([lang, k, typeof table[k] === 'string' && !/aiqnet/i.test(table[k])]).toEqual([lang, k, true]);
      }
      expect([lang, /aiqnet\.io/.test(table.link_origin)]).toEqual([lang, true]); // the relay it came through
    }
  });
});

describe('what a request can do is reached from this screen only', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '../src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(SRC).map((f) => ({ name: path.relative(SRC, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));
  const importers = (mod) => files.filter((f) => new RegExp(`from '[./]*(?:services/)?${mod}'`).test(f.text)).map((f) => f.name);

  it('performIntent is called by this screen only; the wallet screen only parses links', () => {
    expect(importers('QNetLink').sort()).toEqual(['screens/QNetLinkScreen.js', 'screens/WalletScreen.js']);
    expect(files.filter((f) => /performIntent\(/.test(f.text)).map((f) => f.name).sort())
      .toEqual(['screens/QNetLinkScreen.js', 'services/QNetLink.js']);
    const wallet = files.find((f) => f.name === 'screens/WalletScreen.js').text;
    expect(wallet).toMatch(/import \{ parseLink, takeInitialUrl \} from '\.\.\/services\/QNetLink';/);
  });
});

// MOBLINK-R5-02: what the outcome screen had to say is never lost with a lock: a request the user decided comes back
// with its outcome (or waits for it), and the owner gets the outcome even from a screen already gone.
describe('the outcome outlives a lock', () => {
  it('a decided request comes back with its outcome and asks the relay nothing', async () => {
    const tree = await mount(CONNECT, { settled: true, settledOutcome: OK });
    expect(QNetLink.openSession).not.toHaveBeenCalled();
    expect(QNetLink.prepareOffer).not.toHaveBeenCalled();
    expect(QNetLink.deliverAnswer).not.toHaveBeenCalled();
    expect(texts(tree)).toContain(t('link_result_connect'));
    expect(button(tree, 'Confirm')).toBeUndefined();
    await act(async () => { button(tree, 'Close').props.onPress(); });
    expect(props.onClose).toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('decided while the work was under way: it waits, then shows the outcome when it arrives', async () => {
    const tree = await mount(CONNECT, { settled: true, settledOutcome: null });
    expect(texts(tree)).toContain(t('link_working_send'));
    expect(QNetLink.openSession).not.toHaveBeenCalled();
    await act(async () => { tree.update(<QNetLinkScreen {...props} settledOutcome={{ status: 'rejected' }} />); });
    expect(texts(tree)).toContain(t('link_result_rejected'));
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('the owner gets the outcome even when the screen went before it arrived', async () => {
    let finish;
    QNetLink.performIntent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const onOutcome = jest.fn();
    const tree = await mount(CONNECT, { onOutcome });
    await wait(ARMED);
    await act(async () => { press(button(tree, 'Confirm')); });
    await wait(0);
    await act(async () => { tree.unmount(); }); // the wallet locked
    await act(async () => { finish(OK); });
    await wait(0);
    expect(onOutcome).toHaveBeenCalledWith(OK);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), OK, expect.any(Object));
  });
});

// Revision 2: the link sheet discloses the device check before Confirm and names what happens; the claim sheet shows the
// amount the app read itself; the check number appears only once the relay took the answer.
describe('the link and claim sheets', () => {
  const LINK_L = { id: 'e'.repeat(32), sitePub: 'd'.repeat(43), intent: 'link', reqHash: 'f'.repeat(43) };
  const CLAIM_L = { id: 'a'.repeat(32), sitePub: 'd'.repeat(43), intent: 'claim', reqHash: 'b'.repeat(43) };
  const NODE_ID = 'light_mobile_6526ab8fd00ff8ca';
  const CAPABLE = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null };
  const consentOffer = (over = {}) => ({
    kind: 'link', mode: 'consent', nodeId: NODE_ID, qnet: ADDRESSES.qnet, burnTx: 'b', device: CAPABLE, features: [], switchFrom: null, ...over,
  });

  it('the link sheet names the node and the wallet and discloses the device check, with the privacy policy', async () => {
    QNetLink.prepareOffer.mockResolvedValue(consentOffer());
    const onPrivacy = jest.fn();
    const tree = await mount(LINK_L, { onPrivacy, node: { any: true } });
    const shown = texts(tree);
    for (const s of [t('link_title_link'), t('link_link_body'), NODE_ID, ADDRESSES.qnet, t('link_device_check_title'),
      t('link_device_check_body'), t('legal_privacy')]) {
      expect(shown).toContain(s);
    }
    expect(shown).not.toContain(t('link_cant_run_sheet'));
    expect(QNetLink.prepareOffer).toHaveBeenCalledWith(LINK_L, { wallet: props.wallet, session: expect.any(Object), node: { any: true } });
    const privacy = tree.root.findAllByType(Text).find((n) => n.props.onPress && [].concat(n.props.children).join('') === t('legal_privacy'));
    await act(async () => { privacy.props.onPress(); });
    expect(onPrivacy).toHaveBeenCalled();
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_link'));
    await act(async () => { tree.unmount(); });
  });

  it('on a device that cannot run a node the sheet says so and Confirm gives the consent only', async () => {
    QNetLink.prepareOffer.mockResolvedValue(consentOffer({ device: { capable: false, reason: 'device_desktop' } }));
    QNetLink.performIntent.mockResolvedValue({ status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, consent: {}, bound: false, here: false });
    const tree = await mount(LINK_L);
    expect(texts(tree)).toContain(t('link_cant_run_sheet'));
    expect(texts(tree)).not.toContain(t('link_device_check_body'));
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('link_result_consent_only'));
    await act(async () => { tree.unmount(); });
  });

  it('another wallet\'s node on this device is named before Confirm; the done screen says when the node will run', async () => {
    QNetLink.prepareOffer.mockResolvedValue(consentOffer({ switchFrom: 'd9fa370374e24333242eon847d1d354dcd87fe873823e' }));
    QNetLink.performIntent.mockResolvedValue({ status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, consent: {}, bound: true, here: true });
    const onOpenNode = jest.fn();
    const tree = await mount(LINK_L, { onOpenNode });
    expect(texts(tree)).toContain(t('link_switch_other', { wallet: 'd9fa370374…73823e' }));
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('node_linking'));
    await act(async () => { button(tree, t('link_open_node_tab')).props.onPress(); });
    expect(onOpenNode).toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('the check number appears after the relay took the answer, in two groups of three', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ ...consentOffer(), mode: 'device' });
    QNetLink.performIntent.mockResolvedValue({ status: 'linked', qnet: ADDRESSES.qnet, nodeId: NODE_ID, seq: '1790086400' });
    QNetLink.deliverAnswer.mockImplementationOnce(async (link, session, answer, { onCheck }) => { onCheck('798820'); return 'delivered'; });
    const tree = await mount(LINK_L);
    expect(texts(tree)).toContain(t('link_link_existing_body'));
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    await wait(0);
    const shown = texts(tree);
    expect(shown).toContain(t('link_result_linked'));
    expect(shown).toContain(t('link_check_number', { number: '798\u00a0820' }));
    expect(shown).toContain(t('link_check_hint'));
    await act(async () => { tree.unmount(); });
  });

  it('the check number stays with the outcome across a lock', async () => {
    const LINKED = { status: 'linked', qnet: ADDRESSES.qnet, nodeId: NODE_ID, seq: '1790086400' };
    QNetLink.prepareOffer.mockResolvedValue({ ...consentOffer(), mode: 'device' });
    QNetLink.performIntent.mockResolvedValue(LINKED);
    let accept;
    QNetLink.deliverAnswer.mockImplementationOnce((link, session, answer, { onCheck }) => new Promise((resolve) => {
      accept = () => { onCheck('798820'); resolve('delivered'); };
    }));
    const onOutcome = jest.fn();
    const tree = await mount(LINK_L, { onOutcome });
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    await act(async () => { tree.unmount(); }); // the wallet locked before the relay took the answer
    await act(async () => { accept(); });
    expect(onOutcome).toHaveBeenLastCalledWith({ ...LINKED, check: '798820' });
    const back = await mount(LINK_L, { settled: true, settledOutcome: onOutcome.mock.calls.at(-1)[0] });
    expect(texts(back)).toContain(t('link_check_number', { number: '798\u00a0820' }));
    await act(async () => { back.unmount(); });
  });

  it('a consent whose binding the network refused for good says so; the node still joins the wallet', async () => {
    QNetLink.prepareOffer.mockResolvedValue(consentOffer());
    QNetLink.performIntent.mockResolvedValue({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, consent: {}, bound: false, here: true, reason: 'device_not_genuine',
    });
    const tree = await mount(LINK_L);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    const shown = texts(tree);
    for (const s of [t('link_result_consent_only'), t('link_err_BIND_REFUSED'), t('node_cant_run_now')]) expect(shown).toContain(s);
    expect(shown).not.toContain(t('node_linking'));
    await act(async () => { tree.unmount(); });
  });

  it('a device the network would not take is said as it is; the licence dialog only where the build has its text', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'unavailable', error: 'BIND_REFUSED', reason: 'device_secondary_user' });
    const tree = await mount(LINK_L);
    expect(texts(tree)).toContain(t('link_err_BIND_REFUSED'));
    expect(texts(tree)).toContain(t('node_main_profile'));
    expect(button(tree, 'Confirm')).toBeUndefined();
    await act(async () => { tree.unmount(); });

    QNetLink.prepareOffer.mockResolvedValue({ ...consentOffer(), mode: 'device' });
    QNetLink.performIntent.mockResolvedValue({ status: 'error', error: 'BIND_REFUSED', reason: 'device_unlicensed' });
    const onPlayDialog = jest.fn();
    const refused = await mount(LINK_L, { onPlayDialog });
    await wait(ARMED);
    await act(async () => { await press(button(refused, 'Confirm')); });
    expect(texts(refused)).toContain(t('node_cant_run_now'));
    // Under Jest the tables are iOS's: no Google Play text, so no dialog is offered.
    expect(buttons(refused).map((b) => b.label)).toEqual(['Close']);
    await act(async () => { refused.unmount(); });
  });

  it('the claim sheet shows the amount the app read, and the done screen the move', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: NODE_ID, qnet: ADDRESSES.qnet, amountNano: 12500000000 });
    QNetLink.performIntent.mockResolvedValue({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, amountNano: '12500000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: '160',
    });
    const tree = await mount(CLAIM_L);
    for (const s of [t('link_title_claim'), t('link_claim_amount'), '12.5 QNC']) expect(texts(tree)).toContain(s);
    expect(texts(tree)).not.toContain(t('link_claim_empty'));
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_claim'));
    expect(texts(tree)).toContain(t('link_result_claim', { amount: '12.5 QNC' }));
    expect(texts(tree)).toContain(t('claim_stopped_at', { epoch: '160' }));
    await act(async () => { tree.unmount(); });
  });

  it('below 1 QNC there is nothing to move, and the answer after Confirm says so', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim_empty', nodeId: NODE_ID, qnet: ADDRESSES.qnet });
    QNetLink.performIntent.mockResolvedValue({ status: 'empty', qnet: ADDRESSES.qnet, nodeId: NODE_ID });
    const tree = await mount(CLAIM_L);
    expect(texts(tree)).toContain(t('link_claim_empty'));
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('link_result_claim_empty'));
    await act(async () => { tree.unmount(); });
  });
});

// A1: the reservation sheet, a light-node consent of the same kind: the wallet and its node, nothing leaves the wallet,
// and nothing about a price, a payment or a code; Confirm asks for the device authentication before the wallet signs.
describe('the reserve sheet', () => {
  const RESERVE_L = { id: '4'.repeat(32), sitePub: 'd'.repeat(43), intent: 'reserve', reqHash: 'c'.repeat(43) };
  const NODE_ID = 'light_mobile_6526ab8fd00ff8ca';
  const OFFER_R = { kind: 'reserve', qnet: ADDRESSES.qnet, nodeId: NODE_ID, burner: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' };
  const SIGNED = { status: 'ok', qnet: ADDRESSES.qnet, time: '1790000000', pk: 'pk', sig: 'sig' };

  it('names the wallet and its node, says where it came from, and shows no payment address', async () => {
    QNetLink.prepareOffer.mockResolvedValue(OFFER_R);
    const node = { any: true };
    const tree = await mount(RESERVE_L, { node });
    const shown = texts(tree);
    for (const s of [t('link_origin'), t('link_title_reserve'), t('link_started_here'), t('link_reserve_body'), t('link_node'), NODE_ID,
      t('link_wallet'), ADDRESSES.qnet]) {
      expect(shown).toContain(s);
    }
    expect(shown).not.toContain(OFFER_R.burner);
    expect(shown).not.toContain(t('link_device_check_body'));
    expect(QNetLink.prepareOffer).toHaveBeenCalledWith(RESERVE_L, { wallet: props.wallet, session: expect.any(Object), node });
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('Confirm asks for the device authentication, then the wallet signs once and the sheet says to go back', async () => {
    QNetLink.prepareOffer.mockResolvedValue(OFFER_R);
    QNetLink.performIntent.mockResolvedValue(SIGNED);
    const node = { any: true };
    const onOpenNode = jest.fn();
    const tree = await mount(RESERVE_L, { node, onOpenNode });
    expect(button(tree, 'Confirm').props.disabled).toBe(true);
    await wait(ARMED);
    props.authenticate.mockResolvedValueOnce(false);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_reserve'));
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(QNetLink.performIntent.mock.calls).toEqual([[RESERVE_L, OFFER_R, { node }]]);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(RESERVE_L, expect.any(Object), SIGNED, expect.any(Object));
    const shown = texts(tree);
    expect(shown).toContain(t('link_result_reserve'));
    expect(shown).toContain(t('link_delivered'));
    expect(buttons(tree).map((b) => b.label)).toEqual(['Close']); // no Node tab: nothing runs yet
    await act(async () => { tree.unmount(); });
  });

  it('Reject signs nothing; a wallet with a server node gets the reason and no Confirm', async () => {
    QNetLink.prepareOffer.mockResolvedValue(OFFER_R);
    const tree = await mount(RESERVE_L, { node: { any: true } });
    await act(async () => { await button(tree, 'Reject').props.onPress(); });
    expect(props.authenticate).not.toHaveBeenCalled();
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(RESERVE_L, expect.any(Object), { status: 'rejected' }, expect.any(Object));
    await act(async () => { tree.unmount(); });
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'unavailable', error: 'NODE_OTHER' });
    const other = await mount({ ...RESERVE_L, id: '5'.repeat(32) }, { node: { any: true } });
    expect(texts(other)).toContain(t('link_err_NODE_OTHER'));
    expect(button(other, 'Confirm')).toBeUndefined();
    await act(async () => { await button(other, 'Close').props.onPress(); });
    expect(QNetLink.deliverAnswer).toHaveBeenLastCalledWith({ ...RESERVE_L, id: '5'.repeat(32) }, expect.any(Object), { status: 'error', error: 'NODE_OTHER' });
    await act(async () => { other.unmount(); });
  });

  // App policy: the sheet is a light-node consent: no price, payment, code or link, in any language.
  it('its texts speak of no price, payment, code or link to a page, in any language', () => {
    const translations = require('../src/i18n/translations').default;
    for (const [lang, table] of Object.entries(translations)) {
      for (const k of ['link_title_reserve', 'link_reserve_body', 'link_auth_reserve', 'link_result_reserve']) {
        expect([lang, k, /\d|https?:|1DEV|SOL\b|price|pay|code/i.test(table[k])]).toEqual([lang, k, false]);
      }
    }
    expect(translations.en.link_title_reserve).toBe('Set up a light node for this wallet');
  });
});

// MN-R4-05: a request that went out and got no answer is said as unknown, never as "nothing changed".
describe('an outcome nobody answered', () => {
  const CLAIM_U = { id: '1'.repeat(32), sitePub: 'd'.repeat(43), intent: 'claim', reqHash: 'b'.repeat(43) };
  const LINK_U = { id: '2'.repeat(32), sitePub: 'd'.repeat(43), intent: 'link', reqHash: 'f'.repeat(43) };
  const NODE_ID = 'light_mobile_6526ab8fd00ff8ca';
  const CAPABLE = { capable: true, platform: 'ios', flags: 'mac=0,vision=0,idiom=phone', report: null };

  it('a claim: the unknown note, not "could not be reached. Nothing changed."', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: NODE_ID, qnet: ADDRESSES.qnet, amountNano: 12500000000 });
    QNetLink.performIntent.mockResolvedValue({ status: 'error', error: 'NETWORK', unknown: true });
    const tree = await mount(CLAIM_U);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('claim_note_unknown'));
    expect(texts(tree)).not.toContain(t('link_err_NETWORK'));
    await act(async () => { tree.unmount(); });
  });

  it('a device link: the unknown note; a network error before anything went still says nothing changed', async () => {
    const offer = { kind: 'link', mode: 'device', nodeId: NODE_ID, qnet: ADDRESSES.qnet, device: CAPABLE, features: [], switchFrom: null };
    QNetLink.prepareOffer.mockResolvedValue(offer);
    QNetLink.performIntent.mockResolvedValue({ status: 'error', error: 'NETWORK', reason: 'network', unknown: true });
    const tree = await mount(LINK_U, { node: { any: true } });
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('node_use_unknown'));
    expect(texts(tree)).not.toContain(t('link_err_NETWORK'));
    await act(async () => { tree.unmount(); });
    QNetLink.performIntent.mockResolvedValue({ status: 'error', error: 'NETWORK', reason: 'network' });
    const known = await mount({ ...LINK_U, id: '3'.repeat(32) }, { node: { any: true } });
    await wait(ARMED);
    await act(async () => { await press(button(known, 'Confirm')); });
    expect(texts(known)).toContain(t('link_err_NETWORK'));
    await act(async () => { known.unmount(); });
  });
});
