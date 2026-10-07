// A node's refusal on a result card (L-12): the known classes in the app's language, never the node's own English.
const fs = require('fs');
const path = require('path');
const translations = require('../src/i18n/translations').default;
const { makeT } = require('../src/i18n');
const { refusalClass, refusalReason, sendErrorText } = require('../src/utils/txRefusal');
const { TooManyPendingError } = require('../src/services/PendingTx');

// What the nodes answer, word for word (rpc/tx_api.rs puts the mempool's error after "Failed to add transaction to mempool").
const NODE = {
  nonce: 'Failed to add transaction to mempool: InvalidTransaction("[REJECT][TX] Invalid nonce: expected 5, got 3 (anti-replay protection)")',
  balance: 'Failed to add transaction to mempool: InvalidTransaction("Insufficient balance: have 1000, need 5000")',
  key: 'Failed to add transaction to mempool: InvalidTransaction("[REJECT][AUTH] pk_unresolved: include dilithium_public_key on the first-use TX")',
  busy: 'Failed to add transaction to mempool: ValidationError("Transaction already in mempool or mempool full")',
  rate: 'Rate limit exceeded',
};

it('names each known class from the words the nodes use, anything else as other', () => {
  for (const [cls, raw] of Object.entries(NODE)) expect([cls, refusalClass(raw)]).toEqual([cls, cls]);
  expect(refusalClass('HTTP 429')).toBe('rate');
  expect(refusalClass('HTTP 503')).toBe('busy');
  expect(refusalClass('Failed to add transaction to mempool: InvalidSignature')).toBe('other');
  expect(refusalClass('')).toBeNull();
  expect(refusalClass(null)).toBeNull();
});

it('every class has its text in every language, and none is English left behind', () => {
  for (const [lang, table] of Object.entries(translations)) {
    for (const cls of ['nonce', 'balance', 'key', 'busy', 'rate', 'other']) {
      expect([lang, cls, typeof table[`tx_refusal_${cls}`]]).toEqual([lang, cls, 'string']);
      if (lang !== 'en' && cls !== 'other') expect([lang, cls, table[`tx_refusal_${cls}`] === translations.en[`tx_refusal_${cls}`]]).toEqual([lang, cls, false]);
    }
    expect([lang, typeof table.err_HEX_RECIPIENT]).toEqual([lang, 'string']);
  }
});

it('a result card says the operation, the known reason in its language, and never the node\'s words', () => {
  for (const lang of Object.keys(translations)) {
    const t = makeT(lang);
    for (const [cls, raw] of Object.entries(NODE)) {
      const text = sendErrorText(t, { message: raw }, 'tx_failed');
      expect(text).toBe(`${t('tx_failed')}\n${t('err_detail', { detail: t(`tx_refusal_${cls}`) })}`);
      expect(text).not.toMatch(/mempool|InvalidTransaction|REJECT|pk_unresolved|Rate limit/);
    }
    // A refusal the wallet does not know, or an internal error: the operation's text alone.
    expect(sendErrorText(t, new Error('No QNet key in wallet — re-create/import to derive the key'), 'tx_failed')).toBe(t('tx_failed'));
    expect(sendErrorText(t, { message: 'all nodes failed' }, 'tx_failed')).toBe(t('tx_failed'));
    // A code the app knows keeps its own text.
    expect(sendErrorText(t, { code: 'HEX_RECIPIENT', message: 'Not an address funds can be sent to' }, 'tx_failed')).toBe(t('err_HEX_RECIPIENT'));
    expect(sendErrorText(t, new TooManyPendingError(), 'tx_failed')).toBe(t('err_TOO_MANY_PENDING'));
  }
  expect(refusalReason(makeT('ru'), NODE.balance)).toBe(translations.ru.tx_refusal_balance);
  expect(makeT('en')('tx_note_refused', { reason: refusalReason(makeT('en'), NODE.nonce) }))
    .toBe("Not accepted yet (out of order with this wallet's other transactions). The wallet retries while the app is open, for up to half an hour.");
});

it('the send form and the browser sheet say refusals this way', () => {
  const screen = fs.readFileSync(path.join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  expect(screen).toMatch(/\{ reason: refusalReason\(t, u\.refusal\) \}/);
  expect(screen).toMatch(/error: sendErrorText\(t, \{ message: result\.error, code: result\.code \}, 'tx_failed'\)/);
  expect(screen).toMatch(/error: sendErrorText\(t, error, 'tx_failed'\)/);
  expect(screen).not.toMatch(/errorText\(t, \{ message: result\.error/);
  const sheet = fs.readFileSync(path.join(__dirname, '../src/browser/DappSheet.js'), 'utf8');
  expect(sheet.match(/reason: refusalReason\(t, outcome\.refusal\)/g)).toHaveLength(2);
  expect(sheet).not.toMatch(/reason: outcome\.refusal\b/);
});
