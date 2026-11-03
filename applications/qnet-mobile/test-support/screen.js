/* eslint-env jest */
/**
 * The wallet screen rendered under Jest (react-test-renderer): what it shows, a press by its label or its test id, a tab
 * of the bottom bar, Move to wallet on the Node tab, the QNC Send form, a result's explorer action, whether a user
 * action holds the network, and the live read a move in transit schedules.
 */
const { act } = require('react-test-renderer');
const { Text } = require('react-native');

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const textOf = (n) => [].concat(n.props.children).flat(Infinity).filter((c) => typeof c === 'string').join('');
const texts = (tree) => tree.root.findAllByType(Text).map(textOf).join('\n');

const pressText = async (tree, text) => {
  const target = tree.root.findAll((n) => typeof n.props.onPress === 'function'
    && n.findAllByType(Text).some((x) => textOf(x) === text)).pop();
  if (!target) throw new Error(`nothing to press labelled "${text}"`);
  await act(async () => { await target.props.onPress(); });
  await flush(8);
};
const tab = async (tree, name) => {
  await act(async () => { tree.root.find((n) => n.props.testID === `tab-${name}` && typeof n.props.onPress === 'function').props.onPress(); });
  await flush(12);
};
const moveButton = (tree) => tree.root.findAll((n) => n.props.testID === 'node-move' && typeof n.props.onPress === 'function')[0];
const pressId = async (tree, id) => {
  await act(async () => { tree.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === 'function').pop().props.onPress(); });
  await flush();
};

// Send on Assets opens the token picker; QNC chosen there opens its Send form.
const openQncSend = async (tree) => {
  await pressId(tree, 'assets-send');
  await pressId(tree, 'pick-QNC');
};
// The result card's View in the explorer, or null.
const explorerAction = (tree) => tree.root.findAll((n) => n.props.testID === 'tx-result-explorer' && typeof n.props.onPress === 'function')[0] || null;
// Whether no user action holds the network now (utils/userAction): the background verification would start at once.
const networkFree = async () => {
  let done = false;
  require('../src/utils/userAction').afterUserActions().then(() => { done = true; });
  await flush(1);
  return done;
};

// The live read the screen runs every 15 seconds while a move is in transit (requestPace LIVE_READ_MS), run now; not the
// kept-transaction sweep of the same pace. The test spies on global.setInterval.
const transitTick = async () => {
  const timer = global.setInterval.mock.calls.filter((c) => c[1] === 15_000 && c[0].name !== 'sweep').pop();
  if (!timer) throw new Error('no live read is scheduled');
  await act(async () => { timer[0](); });
  await flush(12);
};

module.exports = { flush, textOf, texts, pressText, pressId, tab, moveButton, openQncSend, explorerAction, networkFree, transitTick };
