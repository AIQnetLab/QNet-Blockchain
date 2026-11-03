// The QNet Link confirmation screen: nothing is shared without Confirm (armed after a second) and a fresh
// authentication; Reject answers `rejected` with no authentication and nothing performed; a refused or unavailable
// request performs nothing; and the one thing a request can do is share this wallet's two addresses.
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import Action from '../src/components/ui/Action';

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
const buttons = (tree) => tree.root.findAllByType(Action).map((b) => ({ label: b.props.label, props: b.props }));
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
    expect(QNetLink.openSession).toHaveBeenCalledWith(CONNECT, { cancelled: expect.any(Function), onRetry: expect.any(Function) });
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
    expect(QNetLink.performIntent.mock.calls[0]).toEqual([CONNECT, OFFER, { node: null, session: expect.any(Object), onProgress: expect.any(Function) }]);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), OK, expect.any(Object));
    const shown = texts(tree);
    expect(shown).toContain(t('link_result_connect'));
    expect(shown).toContain(t('link_delivered'));
    expect(buttons(tree).map((b) => b.label)).toEqual(['Close']);
    await act(async () => { tree.unmount(); });
  });

  // An answer that expired or failed on its way never shows "The addresses were sent to the website that showed the
  // link." above the line that says it did not arrive: one line, never two saying opposite things.
  it('a connect whose answer did not reach the site says that in one line, never that the addresses were sent', async () => {
    for (const [ended, warning] of [['expired', null], ['failed', null], ['conflict', 'link_delivery_conflict']]) {
      QNetLink.deliverAnswer.mockResolvedValueOnce(ended);
      const onOutcome = jest.fn();
      const tree = await mount(CONNECT, { onOutcome });
      await wait(ARMED);
      await act(async () => { await press(button(tree, 'Confirm')); });
      await wait(0);
      const shown = texts(tree);
      expect([ended, shown.includes(t('link_result_connect_missed')), shown.includes(t('link_result_connect'))]).toEqual([ended, true, false]);
      for (const key of ['link_delivery_expired', 'link_delivery_failed']) expect([ended, key, shown.includes(t(key))]).toEqual([ended, key, false]);
      if (warning) expect(shown).toContain(t(warning));
      // Shown again after a lock it says the same: how the delivery ended went with the outcome.
      const kept = onOutcome.mock.calls[onOutcome.mock.calls.length - 1][0];
      expect(kept.delivery).toBe(ended);
      await act(async () => { tree.unmount(); });
      const again = await mount(CONNECT, { settled: true, settledOutcome: kept });
      expect([ended, texts(again).includes(t('link_result_connect_missed')), texts(again).includes(t('link_result_connect'))])
        .toEqual([ended, true, false]);
      await act(async () => { again.unmount(); });
    }
  });

  // Through the native inbox, which writes it in every build (LinkInboxTest.kt noteLine), never the JS logger.
  it('says in the log the request it shows, by intent and what it offers, never the session or an address', async () => {
    const { NativeModules } = require('react-native');
    const note = jest.fn();
    NativeModules.QNetLinkInbox = { note };
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const tree = await mount(CONNECT);
      expect(note.mock.calls).toEqual([['request_shown', { intent: 'connect', offer: 'connect' }]]);
      expect(JSON.stringify(note.mock.calls)).not.toContain(CONNECT.id);
      expect(JSON.stringify(note.mock.calls)).not.toContain(ADDRESSES.qnet);
      expect(info.mock.calls.join('\n')).not.toContain('[LINK]');
      await act(async () => { tree.unmount(); });
    } finally {
      delete NativeModules.QNetLinkInbox;
      info.mockRestore();
    }
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

describe('a slow network', () => {
  it('keeps the request loading, with no error, while the session is still being fetched; Close leaves it', async () => {
    let open;
    QNetLink.openSession.mockImplementation(() => new Promise((r) => { open = r; }));
    const tree = await mount(CONNECT);
    expect(texts(tree)).toContain(t('link_loading'));
    expect(texts(tree)).not.toContain(t('link_refused_title'));
    expect(buttons(tree).map((b) => b.label)).toEqual(['Close']);
    await act(async () => { open({ expiresAt: Date.now() + 500000 }); });
    await wait(0);
    expect(texts(tree)).toContain(ADDRESSES.qnet);
    await act(async () => { tree.unmount(); });
    // Closing while it loads ends the wait: the screen's tries stop.
    QNetLink.openSession.mockImplementation(() => new Promise(() => {}));
    const slow = await mount(CONNECT);
    await act(async () => { await button(slow, 'Close').props.onPress(); });
    expect(props.onClose).toHaveBeenCalled();
    const { cancelled } = QNetLink.openSession.mock.calls[QNetLink.openSession.mock.calls.length - 1][1];
    expect(cancelled()).toBe(false);
    await act(async () => { slow.unmount(); });
    expect(cancelled()).toBe(true);
  });

  it('an offer the network has not answered yet is read again, still loading and saying so, and the request comes up', async () => {
    QNetLink.prepareOffer.mockReset();
    QNetLink.prepareOffer.mockResolvedValueOnce({ kind: 'unavailable', error: 'NETWORK' }).mockResolvedValue(OFFER);
    const tree = await mount(CONNECT);
    expect(texts(tree)).toContain(t('link_loading_slow'));
    expect(texts(tree)).not.toContain(t('link_loading'));
    expect(texts(tree)).not.toContain(t('link_unavailable_title'));
    await wait(1100);
    expect(QNetLink.prepareOffer).toHaveBeenCalledTimes(2);
    expect(texts(tree)).toContain(ADDRESSES.qnet);
    expect(texts(tree)).not.toContain(t('link_unavailable_title'));
    await act(async () => { tree.unmount(); });
  });

  // While the request loads, a try with no answer makes the line say that the network has not answered and the screen
  // tries again; an answer brings the plain line back.
  it('says the network has not answered after a try with none, and goes back to the plain line on an answer', async () => {
    let open;
    QNetLink.openSession.mockImplementation((link, { onRetry }) => {
      onRetry();
      return new Promise((r) => { open = r; });
    });
    let offer;
    QNetLink.prepareOffer.mockImplementation(() => new Promise((r) => { offer = r; }));
    const tree = await mount(CONNECT);
    expect(texts(tree)).toContain(t('link_loading_slow'));
    expect(buttons(tree).map((b) => b.label)).toEqual(['Close']);
    await act(async () => { open({ expiresAt: Date.now() + 500000 }); });
    await wait(0);
    expect(texts(tree)).toContain(t('link_loading'));
    expect(texts(tree)).not.toContain(t('link_loading_slow'));
    await act(async () => { offer(OFFER); });
    await wait(0);
    expect(texts(tree)).toContain(ADDRESSES.qnet);
    expect(texts(tree)).not.toContain(t('link_loading_slow'));
    await act(async () => { tree.unmount(); });
    // Its own words in every language.
    const translations = require('../src/i18n/translations').default;
    for (const [lang, table] of Object.entries(translations)) {
      expect([lang, typeof table.link_loading_slow === 'string' && table.link_loading_slow !== table.link_loading]).toEqual([lang, true]);
    }
  });
});

// One wallet, one node type: the sheet shows the request at once, and whether the wallet has a node of the other type is
// read meanwhile (QNetLink.otherNodeHint); the site and the chain refuse such a node in any case.
describe('the other node type, read after the request shows', () => {
  const RESERVE = { id: 'e'.repeat(32), sitePub: 'd'.repeat(43), intent: 'reserve', reqHash: 'f'.repeat(64) };
  const RESERVE_OFFER = { kind: 'reserve', qnet: ADDRESSES.qnet, nodeId: 'light_mobile_0123456789abcdef', burner: ADDRESSES.solana };
  const silentNode = () => {
    const node = { answer: null };
    node.otherNode = jest.fn(() => new Promise((r) => { node.answer = r; }));
    node.record = jest.fn(async () => null);
    return node;
  };

  it('the request shows while the genesis nodes say nothing; their word that the wallet has a super node refuses it', async () => {
    QNetLink.prepareOffer.mockResolvedValue(RESERVE_OFFER);
    const node = silentNode();
    const tree = await mount(RESERVE, { node });
    expect(texts(tree)).toContain(t('link_reserve_body'));
    expect(button(tree, 'Confirm')).toBeDefined();
    expect(node.otherNode).toHaveBeenCalledWith(ADDRESSES.qnet);
    await act(async () => { node.answer(true); });
    await wait(0);
    expect(texts(tree)).toContain(t('link_err_NODE_OTHER'));
    expect(button(tree, 'Confirm')).toBeUndefined();
    await act(async () => { await button(tree, 'Close').props.onPress(); });
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(RESERVE, expect.any(Object), { status: 'error', error: 'NODE_OTHER' });
    expect(QNetLink.performIntent).not.toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  it('no word from them, or a word after the user decided, changes nothing', async () => {
    QNetLink.prepareOffer.mockResolvedValue(RESERVE_OFFER);
    const quiet = silentNode();
    let tree = await mount(RESERVE, { node: quiet });
    await act(async () => { quiet.answer(null); });
    await wait(0);
    expect(button(tree, 'Confirm')).toBeDefined();
    await act(async () => { tree.unmount(); });
    const late = silentNode();
    tree = await mount(RESERVE, { node: late });
    await act(async () => { await button(tree, 'Reject').props.onPress(); });
    await act(async () => { late.answer(true); });
    await wait(0);
    expect(texts(tree)).toContain(t('link_result_rejected'));
    expect(texts(tree)).not.toContain(t('link_err_NODE_OTHER'));
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

// The owner learns when the screen goes (it closes any prompt it opened); a request that waited says so before Confirm.
describe('the screen tells its owner when it goes', () => {
  it('onGone on unmount, and the note for a request that arrived meanwhile', async () => {
    const onGone = jest.fn();
    const tree = await mount(CONNECT, { onGone, afterOther: true });
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
    expect(wallet).toMatch(/import \{ parseLink \} from '\.\.\/services\/QNetLink';/);
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

// A decided request may give way to the next link before its answer arrives: the answer is carried to its end with no
// screen (services/LinkAnswers), and the app says it is on its way wherever the user is.
describe('an answer on its way', () => {
  const { answersAway, carryAnswer } = require('../src/services/LinkAnswers');

  it('is made and delivered after its sheet went, and is on its way until the delivery ends, as its sheet says again', async () => {
    let finish;
    let delivered;
    QNetLink.performIntent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    QNetLink.deliverAnswer.mockImplementationOnce(() => new Promise((resolve) => { delivered = resolve; }));
    const tree = await mount(CONNECT, { onOutcome: jest.fn() });
    await wait(ARMED);
    await act(async () => { press(button(tree, 'Confirm')); });
    await wait(0);
    expect(answersAway()).toEqual([CONNECT.id]);
    await act(async () => { tree.unmount(); }); // the next link took its place
    await act(async () => { finish(OK); });
    await wait(0);
    expect(QNetLink.deliverAnswer).toHaveBeenCalledWith(CONNECT, expect.any(Object), OK, expect.any(Object));
    expect(answersAway()).toEqual([CONNECT.id]);
    // Shown again (after a lock) while it is still being sent: it says so.
    const back = await mount(CONNECT, { settled: true, settledOutcome: OK });
    expect(texts(back)).toContain(t('link_working_send'));
    await act(async () => { delivered('delivered'); });
    await wait(0);
    expect(answersAway()).toEqual([]);
    expect(texts(back)).not.toContain(t('link_working_send'));
    await act(async () => { back.unmount(); });
  });

  it('a rejection, the answer of a phone with no wallet and the reason a request cannot be offered are carried too', async () => {
    const seen = [];
    let delivered = [];
    QNetLink.deliverAnswer.mockImplementation(() => new Promise((resolve) => { delivered.push(resolve); }));
    const tree = await mount(CONNECT);
    await act(async () => { await button(tree, 'Reject').props.onPress(); });
    seen.push(answersAway());
    QNetLink.prepareOffer.mockResolvedValueOnce({ kind: 'unavailable', error: 'NO_WALLET' });
    const none = await mount({ ...CONNECT, id: 'e'.repeat(32) }, { wallet: null });
    seen.push(answersAway());
    QNetLink.prepareOffer.mockResolvedValueOnce({ kind: 'unavailable', error: 'WALLET_MISMATCH' });
    const other = await mount({ ...CONNECT, id: 'f'.repeat(32) });
    await act(async () => { await button(other, 'Close').props.onPress(); });
    seen.push(answersAway());
    expect(seen).toEqual([[CONNECT.id], [CONNECT.id, 'e'.repeat(32)], [CONNECT.id, 'e'.repeat(32), 'f'.repeat(32)]]);
    await act(async () => { delivered.forEach((resolve) => resolve('failed')); });
    await wait(0);
    expect(answersAway()).toEqual([]);
    delivered = [];
    QNetLink.deliverAnswer.mockImplementation(async () => 'delivered');
    for (const tr of [tree, none, other]) await act(async () => { tr.unmount(); });
  });

  it('another request\'s answer on its way is said on this sheet until it arrives', async () => {
    let delivered;
    carryAnswer('e'.repeat(32), new Promise((resolve) => { delivered = resolve; }));
    const tree = await mount(CONNECT);
    expect(texts(tree)).toContain(t('link_previous_sending'));
    await act(async () => { delivered(); });
    await wait(0);
    expect(texts(tree)).not.toContain(t('link_previous_sending'));
    await act(async () => { tree.unmount(); });
  });
});

// Revision 2: the link sheet discloses the device check before Confirm and names what happens; the claim sheet names the
// node whose balance moves (the wallet's light or super node) and shows the amount the app read itself; the check number
// appears only once the relay took the answer.
describe('the link and claim sheets', () => {
  const LINK_L = { id: 'e'.repeat(32), sitePub: 'd'.repeat(43), intent: 'link', reqHash: 'f'.repeat(43) };
  const CLAIM_L = { id: 'a'.repeat(32), sitePub: 'd'.repeat(43), intent: 'claim', reqHash: 'b'.repeat(43) };
  const NODE_ID = 'light_mobile_6526ab8fd00ff8ca';
  const SUPER_ID = 'super_node_f3e187d8752f4514';
  // A move's three parts, by their hashes.
  const H = ['a1', 'b2', 'c3'].map((x) => x.repeat(32));
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
    expect(texts(tree)).toContain(t('link_switch_other', { wallet: 'd9fa37…73823e' }));
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('node_linking'));
    await act(async () => { button(tree, t('link_open_node_tab')).props.onPress(); });
    expect(onOpenNode).toHaveBeenCalled();
    await act(async () => { tree.unmount(); });
  });

  // The wallet sends the registration its consent is for itself, at once (services/RegistrationSubmit); the page only
  // follows the chain. The done screen says how far it got, in the Node tab's words.
  it('Confirm on a consent sends its registration from the wallet at once; the done screen follows it into a block', async () => {
    const CONSENT = { ts: '1793031451', pk: 'cGs', sig: 'c2ln' };
    const OK_LINK = { status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, consent: CONSENT, bound: true, here: true };
    QNetLink.prepareOffer.mockResolvedValue(consentOffer());
    QNetLink.performIntent.mockResolvedValue(OK_LINK);
    let stage = null;
    const node = { register: jest.fn((job, onStage) => { stage = onStage; return new Promise(() => {}); }) };
    const onOutcome = jest.fn();
    const tree = await mount(LINK_L, { node, onOutcome });
    expect(node.register).not.toHaveBeenCalled();
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(node.register).toHaveBeenCalledTimes(1);
    expect(node.register).toHaveBeenCalledWith({
      qnet: ADDRESSES.qnet, burnTx: 'b', consent: CONSENT, until: (1793031451 + 86400) * 1000,
    }, expect.any(Function));
    expect(texts(tree)).toContain(t('node_linking'));
    await act(async () => { stage('admitted'); });
    expect(texts(tree)).toContain(t('node_linking_pool'));
    expect(onOutcome).toHaveBeenLastCalledWith({ ...OK_LINK, delivery: 'delivered', registration: 'admitted' });
    await act(async () => { stage('registered'); });
    expect(texts(tree)).toContain(t('node_linked_waiting'));
    // What the user saw stays with the outcome across a lock.
    const back = await mount(LINK_L, { settled: true, settledOutcome: onOutcome.mock.calls.at(-1)[0], node });
    expect(texts(back)).toContain(t('node_linked_waiting'));
    expect(node.register).toHaveBeenCalledTimes(1);
    await act(async () => { tree.unmount(); back.unmount(); });
  });

  it('a binding for a node on the chain, a rejection or a refusal sends no registration', async () => {
    const node = { register: jest.fn() };
    QNetLink.prepareOffer.mockResolvedValue({ ...consentOffer(), mode: 'device' });
    QNetLink.performIntent.mockResolvedValue({ status: 'linked', qnet: ADDRESSES.qnet, nodeId: NODE_ID, seq: '1790086400' });
    const tree = await mount(LINK_L, { node });
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    await act(async () => { tree.unmount(); });
    QNetLink.prepareOffer.mockResolvedValue(consentOffer());
    const rejected = await mount(LINK_L, { node });
    await act(async () => { await button(rejected, 'Reject').props.onPress(); });
    await act(async () => { rejected.unmount(); });
    QNetLink.performIntent.mockResolvedValue({ status: 'error', error: 'INTERNAL' });
    const failed = await mount(LINK_L, { node });
    await wait(ARMED);
    await act(async () => { await press(button(failed, 'Confirm')); });
    await act(async () => { failed.unmount(); });
    expect(node.register).not.toHaveBeenCalled();
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
    expect(onOutcome).toHaveBeenLastCalledWith({ ...LINKED, check: '798820', delivery: 'delivered' });
    const back = await mount(LINK_L, { settled: true, settledOutcome: onOutcome.mock.calls.at(-1)[0] });
    expect(texts(back)).toContain(t('link_check_number', { number: '798\u00a0820' }));
    // And how the delivery ended, as the sheet before the lock would have said it.
    expect(texts(back)).toContain(t('link_delivered'));
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

  // The node already runs here. The sheet says so and discloses no device check (nothing is checked or bound); Confirm
  // asks for the authentication before the website learns anything, and the done screen says nothing changed.
  it('the node already runs here: said so, nothing to bind; Confirm only tells the website', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'link', mode: 'here', nodeId: NODE_ID, qnet: ADDRESSES.qnet, seq: 1790000000 });
    QNetLink.performIntent.mockResolvedValue({ status: 'linked', qnet: ADDRESSES.qnet, nodeId: NODE_ID, seq: '1790000000', already: true });
    const tree = await mount(LINK_L);
    const shown = texts(tree);
    expect(shown).toContain(t('link_link_here_body'));
    for (const s of [t('link_link_existing_body'), t('link_device_check_body'), t('link_cant_run_sheet')]) expect(shown).not.toContain(s);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_here'));
    expect(texts(tree)).toContain(t('link_result_already_here'));
    expect(texts(tree)).not.toContain(t('link_result_linked'));
    await act(async () => { tree.unmount(); });
  });

  // A refused move said only "did not link this device". The reason goes under it: the time a
  // limit ends when the node names it, a clock that is off.
  it('a refused move says why: the limit with its end, a clock that is off', async () => {
    for (const [answer, key] of [
      [{ status: 'error', error: 'BIND_REFUSED', reason: 'rate_limited', retryAfterSeconds: null }, t('node_use_err_limit')],
      [{ status: 'error', error: 'BIND_REFUSED', reason: 'expired' }, t('node_use_err_clock')],
      [{ status: 'error', error: 'BIND_REFUSED', reason: 'future_seq' }, t('node_use_err_clock')],
    ]) {
      QNetLink.prepareOffer.mockResolvedValue({ ...consentOffer(), mode: 'device' });
      QNetLink.performIntent.mockResolvedValue(answer);
      const tree = await mount(LINK_L);
      await wait(ARMED);
      await act(async () => { await press(button(tree, 'Confirm')); });
      expect([answer.reason, texts(tree).includes(t('link_err_BIND_REFUSED')), texts(tree).includes(key)]).toEqual([answer.reason, true, true]);
      await act(async () => { tree.unmount(); });
    }
  });

  it('the claim sheet names the light node and shows the amount the app read, and the done screen the move', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: NODE_ID, nodeType: 'light', qnet: ADDRESSES.qnet, amountNano: 12500000000 });
    QNetLink.performIntent.mockResolvedValue({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, amountNano: '12500000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: '160',
    });
    const tree = await mount(CLAIM_L);
    for (const s of [t('link_title_claim'), t('node_title_light'), NODE_ID, t('link_claim_amount'), '12.5 QNC']) expect(texts(tree)).toContain(s);
    expect(texts(tree)).not.toContain(t('link_claim_empty'));
    expect(texts(tree)).not.toContain(t('node_title_super'));
    // The node, then the amount, then the wallet.
    const shown = texts(tree);
    expect(shown.indexOf(NODE_ID)).toBeLessThan(shown.indexOf('12.5 QNC'));
    expect(shown.indexOf('12.5 QNC')).toBeLessThan(shown.indexOf(ADDRESSES.qnet));
    expect(tree.root.findAllByProps({ testID: 'link-claim-node' }).some((n) => n.props.children === NODE_ID)).toBe(true);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_claim'));
    expect(texts(tree)).toContain(t('link_result_claim', { amount: '12.5 QNC' }));
    expect(texts(tree)).toContain(t('claim_stopped_at', { epoch: '160' }));
    await act(async () => { tree.unmount(); });
  });

  it('the claim sheet of the wallet\'s super node names it, "Super node" with its id, above the amount', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: SUPER_ID, nodeType: 'super', qnet: ADDRESSES.qnet, amountNano: 48000000000 });
    QNetLink.performIntent.mockResolvedValue({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: SUPER_ID, amountNano: '48000000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: null,
    });
    const tree = await mount(CLAIM_L);
    const shown = texts(tree);
    for (const s of [t('link_title_claim'), t('node_title_super'), SUPER_ID, t('link_claim_amount'), '48 QNC', ADDRESSES.qnet]) expect(shown).toContain(s);
    expect(shown).not.toContain(t('node_title_light'));
    expect(shown.indexOf(SUPER_ID)).toBeLessThan(shown.indexOf('48 QNC'));
    expect(tree.root.findAllByProps({ testID: 'link-claim-node' }).some((n) => n.props.children === SUPER_ID)).toBe(true);
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(props.authenticate).toHaveBeenCalledWith(t('link_auth_claim'));
    expect(QNetLink.performIntent).toHaveBeenCalledWith(CLAIM_L, expect.objectContaining({ nodeId: SUPER_ID, nodeType: 'super' }), expect.any(Object));
    expect(texts(tree)).toContain(t('link_result_claim', { amount: '48 QNC' }));
    expect(texts(tree)).toContain(t('claim_credited_on_block'));
    await act(async () => { tree.unmount(); });
  });

  // Before, the done screen said "Credited once confirmed." however long ago the move landed (owner, 18.10).
  it('the done screen follows the move: in the wallet, or the part of it that is, once the wallet\'s live figure shows it', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: SUPER_ID, nodeType: 'super', qnet: ADDRESSES.qnet, amountNano: 48000000000 });
    QNetLink.performIntent.mockResolvedValue({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: SUPER_ID, amountNano: '48000000000', txHash: 'ab'.repeat(32), stoppedAtEpoch: null,
    });
    let outcome = { result: 'moving' };
    const moveOf = jest.fn(() => outcome);
    const tree = await mount(CLAIM_L, { moveOf });
    await wait(ARMED);
    await act(async () => { await press(button(tree, 'Confirm')); });
    expect(texts(tree)).toContain(t('claim_credited_on_block'));
    expect(moveOf).toHaveBeenCalledWith('ab'.repeat(32));
    outcome = { result: 'done', appliedNano: 48e9 };
    await act(async () => { tree.update(<QNetLinkScreen {...props} moveOf={() => outcome} />); });
    expect(texts(tree)).toContain(t('claim_note_done'));
    expect(texts(tree)).not.toContain(t('claim_credited_on_block'));
    outcome = { result: 'partial', appliedNano: 12.5e9 };
    await act(async () => { tree.update(<QNetLinkScreen {...props} moveOf={() => ({ ...outcome })} />); });
    expect(texts(tree)).toContain(t('claim_note_partial', { amount: '12.5 QNC' }));
    expect(texts(tree)).toContain(t('link_result_claim', { amount: '12.5 QNC' }));
    await act(async () => { tree.unmount(); });
  });

  // The sheet moves the whole balance shown with one Confirm, in as many parts as the Node tab would, and
  // answers once at the end. While a next part is to go the sheet says to keep the app open; the done screen says the
  // total, how many transactions it took, and what became of them as the Node tab's card says it.
  it('a move in parts: keep the app open while the next part is to go; then the total, the count and the run\'s note', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: NODE_ID, nodeType: 'light', qnet: ADDRESSES.qnet, amountNano: 9e9 });
    let finish;
    let heard;
    QNetLink.performIntent.mockImplementation((link, offer, { onProgress }) => {
      heard = onProgress;
      return new Promise((resolve) => { finish = resolve; });
    });
    const tree = await mount(CLAIM_L);
    await wait(ARMED);
    // Not awaited: Confirm's work runs until the run answers.
    await act(async () => { press(button(tree, 'Confirm')); });
    await wait(0);
    expect(texts(tree)).toContain(t('link_working_claim'));
    expect(texts(tree)).not.toContain(t('link_claim_parts'));
    await act(async () => { heard({ parts: [{ txHash: H[0], amountNano: '3000000000' }], movedNano: 3000000000n, more: true }); });
    expect(texts(tree)).toContain(t('link_claim_parts'));
    const parts = H.map((txHash) => ({ txHash, amountNano: '3000000000', lastEpoch: 1, stoppedAtEpoch: 2 }));
    const done = (stop) => ({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, amountNano: '9000000000', txHash: H[2], stoppedAtEpoch: '1125',
      run: { parts, more: false, stop },
    });
    await act(async () => { finish(done({ ended: true })); });
    await wait(0);
    const shown = texts(tree);
    expect(shown).toContain(t('link_result_claim', { amount: '9 QNC' }));
    expect(tree.root.findAll((n) => n.props.testID === 'link-claim-parts' && n.props.value === '3')).not.toHaveLength(0);
    // Ended by a lock (or the request's time): what the parts put in the wallet, the rest on the node.
    expect(shown).toContain(t('claim_note_partial', { amount: '9 QNC' }));
    expect(shown).not.toContain(t('link_claim_parts'));
    await act(async () => { tree.unmount(); });
    // Ended by a refusal of the next part: the same, with why.
    QNetLink.performIntent.mockResolvedValue(done({ code: 'RATE_LIMITED' }));
    const refused = await mount(CLAIM_L);
    await wait(ARMED);
    await act(async () => { await press(button(refused, 'Confirm')); });
    expect(texts(refused)).toContain(`${t('claim_note_partial', { amount: '9 QNC' })} ${t('err_RATE_LIMITED')}`);
    await act(async () => { refused.unmount(); });
    // One claim, as an older run answers: no count.
    QNetLink.performIntent.mockResolvedValue({ ...done(null), amountNano: '3000000000', txHash: H[0], run: { parts: parts.slice(0, 1), more: false, stop: null } });
    const one = await mount(CLAIM_L);
    await wait(ARMED);
    await act(async () => { await press(button(one, 'Confirm')); });
    expect(one.root.findAll((n) => n.props.testID === 'link-claim-parts')).toHaveLength(0);
    expect(texts(one)).toContain(t('claim_stopped_at'));
    await act(async () => { one.unmount(); });
    // The last claim expired: the answer is the claims before it, and the note is the last claim's record, not the one
    // the answer names.
    const records = { [H[0]]: { result: 'done', appliedNano: 3e9 }, [H[1]]: { result: 'done', appliedNano: 3e9 }, [H[2]]: { result: 'expired', appliedNano: 0 } };
    QNetLink.performIntent.mockResolvedValue({ ...done(null), amountNano: '6000000000', txHash: H[1] });
    const expired = await mount(CLAIM_L, { moveOf: (hash) => records[hash] });
    await wait(ARMED);
    await act(async () => { await press(button(expired, 'Confirm')); });
    expect(texts(expired)).toContain(t('link_result_claim', { amount: '6 QNC' }));
    expect(texts(expired)).toContain(t('claim_note_partial', { amount: '6 QNC' }));
    expect(texts(expired)).not.toContain(t('claim_note_done'));
    await act(async () => { expired.unmount(); });
    // Nothing was left to quote after a capped claim (a whole balance below 1 QNC names its stop): no rest is said.
    QNetLink.performIntent.mockResolvedValue({ ...done(null), amountNano: '400000000', txHash: H[0], stoppedAtEpoch: '2', run: { parts: [{ ...parts[0], amountNano: '400000000' }], more: false, stop: null, whole: true } });
    const whole = await mount(CLAIM_L, { moveOf: () => ({ result: 'moving' }) });
    await wait(ARMED);
    await act(async () => { await press(button(whole, 'Confirm')); });
    expect(texts(whole)).toContain(t('claim_credited_on_block'));
    expect(texts(whole)).not.toContain(t('claim_stopped_at'));
    await act(async () => { whole.unmount(); });
  });

  // A last part the run does not wait for is said by its record as that comes: the headline counts what the claims put
  // in the wallet, as the note and the Node tab's card do.
  it('the headline follows the claims\' records with the note, as the Node tab\'s card; the site keeps the answer it got', async () => {
    // The first two parts stopped at a quote's size; the third was the rest of the balance, in transit when the run ended.
    const parts = H.map((txHash, i) => ({ txHash, amountNano: '3000000000', lastEpoch: i + 1, stoppedAtEpoch: i < 2 ? i + 2 : null }));
    const sent = () => ({
      status: 'ok', qnet: ADDRESSES.qnet, nodeId: NODE_ID, amountNano: '9000000000', txHash: H[2], stoppedAtEpoch: null,
      run: { parts: parts.map((p) => ({ ...p })), more: false, stop: null, whole: true },
    });
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: NODE_ID, nodeType: 'light', qnet: ADDRESSES.qnet, amountNano: 9e9 });
    for (const [record, moved] of [[{ result: 'expired', appliedNano: 0 }, '6 QNC'], [{ result: 'partial', appliedNano: 1.5e9 }, '7.5 QNC']]) {
      QNetLink.performIntent.mockResolvedValue(sent());
      QNetLink.deliverAnswer.mockClear();
      const records = { [H[0]]: { result: 'done', appliedNano: 3e9 }, [H[1]]: { result: 'done', appliedNano: 3e9 }, [H[2]]: { result: 'moving' } };
      const moveOf = (hash) => records[hash];
      const onOutcome = jest.fn();
      const tree = await mount(CLAIM_L, { moveOf, onOutcome });
      await wait(ARMED);
      await act(async () => { await press(button(tree, 'Confirm')); });
      expect(texts(tree)).toContain(t('link_result_claim', { amount: '9 QNC' }));
      expect(texts(tree)).toContain(t('claim_credited_on_block'));
      records[H[2]] = record;
      await act(async () => { tree.update(<QNetLinkScreen {...props} />); });
      const shown = texts(tree);
      expect([record.result, shown.includes(t('link_result_claim', { amount: moved })), shown.includes(t('claim_note_partial', { amount: moved }))])
        .toEqual([record.result, true, true]);
      expect(shown).not.toContain(t('link_result_claim', { amount: '9 QNC' }));
      // The site and the owner have the answer of the run's end; a sheet shown again after a lock reads the records.
      expect(QNetLink.deliverAnswer.mock.calls).toEqual([[CLAIM_L, expect.any(Object), sent(), expect.any(Object)]]);
      const kept = onOutcome.mock.calls.at(-1)[0];
      expect(kept).toEqual({ ...sent(), delivery: 'delivered' });
      await act(async () => { tree.unmount(); });
      const back = await mount(CLAIM_L, { settled: true, settledOutcome: kept, moveOf });
      expect(texts(back)).toContain(t('link_result_claim', { amount: moved }));
      await act(async () => { back.unmount(); });
    }
    // A move whose one claim no block took says what it submitted, as the card does, and that it all stays on the node.
    const single = { [H[2]]: { result: 'moving' } };
    QNetLink.performIntent.mockResolvedValue({ ...sent(), amountNano: '3000000000', run: { parts: parts.slice(2), more: false, stop: null, whole: true } });
    const one = await mount(CLAIM_L, { moveOf: (hash) => single[hash] });
    await wait(ARMED);
    await act(async () => { await press(button(one, 'Confirm')); });
    single[H[2]] = { result: 'expired', appliedNano: 0 };
    await act(async () => { one.update(<QNetLinkScreen {...props} />); });
    expect(texts(one)).toContain(t('link_result_claim', { amount: '3 QNC' }));
    expect(texts(one)).toContain(t('claim_note_expired'));
    await act(async () => { one.unmount(); });
  });

  it('below 1 QNC there is nothing to move, and the answer after Confirm says so', async () => {
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim_empty', nodeId: SUPER_ID, nodeType: 'super', qnet: ADDRESSES.qnet });
    QNetLink.performIntent.mockResolvedValue({ status: 'empty', qnet: ADDRESSES.qnet, nodeId: SUPER_ID });
    const tree = await mount(CLAIM_L);
    expect(texts(tree)).toContain(t('link_claim_empty'));
    expect(texts(tree)).toContain(t('node_title_super'));
    expect(texts(tree)).toContain(SUPER_ID);
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
    expect(QNetLink.performIntent.mock.calls).toEqual([[RESERVE_L, OFFER_R, { node, session: expect.any(Object), onProgress: expect.any(Function) }]]);
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
    QNetLink.prepareOffer.mockResolvedValue({ kind: 'claim', nodeId: NODE_ID, nodeType: 'light', qnet: ADDRESSES.qnet, amountNano: 12500000000 });
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
