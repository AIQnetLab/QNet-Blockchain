// MBL-04: Android draws sibling views by elevation before zIndex, but touches follow zIndex. Every overlay that sits
// at the root of the wallet screen must rank the same way in both, or a layer is drawn under one it is touched above:
// the password prompt that a request sheet's Confirm opens would take taps while hidden underneath the sheet.
const walletStyles = require('../src/screens/WalletScreen.styles').default;
const { sheetStyles } = require('../src/browser/DappSheet');
const { linkScreenStyles } = require('../src/screens/QNetLinkScreen');

const layers = {
  'browser request sheet': sheetStyles.overlay,
  'QNet Link screen': linkScreenStyles.overlay,
  'password prompt, delete prompt, alerts (modalOverlay)': walletStyles.modalOverlay,
  'header menu backdrop': walletStyles.menuBackdrop,
  'header menu': walletStyles.menuCard,
};

it('every root overlay is drawn in the order it is touched', () => {
  const entries = Object.entries(layers).map(([name, s]) => ({ name, z: s.zIndex || 0, e: s.elevation || 0 }));
  for (const a of entries) {
    for (const b of entries) {
      if (a.z > b.z) expect([`${a.name} over ${b.name}`, a.e > b.e]).toEqual([`${a.name} over ${b.name}`, true]);
      if (a.z === b.z) expect([`${a.name} level with ${b.name}`, a.e]).toEqual([`${a.name} level with ${b.name}`, b.e]);
    }
  }
});

it('the password prompt and the alerts are above the request sheets in both', () => {
  for (const sheet of [sheetStyles.overlay, linkScreenStyles.overlay]) {
    expect(walletStyles.modalOverlay.zIndex).toBeGreaterThan(sheet.zIndex);
    expect(walletStyles.modalOverlay.elevation).toBeGreaterThan(sheet.elevation);
  }
});

it('the prompt and the alerts are rendered after the sheets, with the style that ranks them above', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  const tail = src.slice(src.lastIndexOf('{renderDappSheet()}'));
  // The QNet Link screen after the browser's sheet: the verified aiqnet.io request is the top layer (MOBLINK-R2-03).
  const order = ['{renderDappSheet()}', '{renderLinkRequest()}', '{renderDeletePrompt()}', '{renderFreshPrompt()}', '{renderCustomAlert()}'];
  const at = order.map((s) => tail.indexOf(s));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
  for (const fn of ['const renderFreshPrompt', 'const renderDeletePrompt', 'const renderCustomAlert']) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 400);
    expect([fn, body.includes('styles.modalOverlay')]).toEqual([fn, true]);
  }
});

// MOBLINK-R2-03: a browser sheet opened before a QNet Link request neither covers it nor stays approvable under it.
it('a QNet Link request ends the browser\'s open requests, hides its sheet and refuses its approvals', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screens/WalletScreen.js'), 'utf8');
  expect(src).toMatch(/if \(linkRequest && browserRef\.current\) browserRef\.current\.cancelAll\(\);/);
  expect(src).toMatch(/if \(!dappSheet \|\| !wallet \|\| linkRequest\) return null;/);
  const browser = require('fs').readFileSync(require('path').join(__dirname, '../src/browser/BrowserScreen.js'), 'utf8');
  expect(browser).toMatch(/cancelAll: \(\) => engine\.cancelWhere\(\(\) => true, CODES\.USER_REJECTED\)/);

  const { createDappProvider, CODES } = require('../src/browser/dappProvider');
  const state = { unlocked: true, interactive: true, accounts: { qnet: 'q', solana: 's' }, walletId: 'q' };
  let shown = null;
  const p = createDappProvider({
    now: () => 1, state: () => state, grants: { get: async () => null, put: async () => {}, remove: async () => {} },
    isCurrent: () => true, emit: () => {}, onChange: (v) => { shown = v; },
  });
  const asked = p.request({ origin: 'https://dapp.example', binding: {} }, 'qnet_requestAccounts');
  await new Promise((r) => setTimeout(r, 0));
  state.interactive = false; // the link screen is up: the browser is not what the user looks at
  expect(await p.approve(shown.id)).toEqual({ status: 'failed', code: CODES.USER_REJECTED });
  p.cancelWhere(() => true, CODES.USER_REJECTED);
  await expect(asked).rejects.toMatchObject({ code: 4001 });
  expect(shown).toBeNull();
});
