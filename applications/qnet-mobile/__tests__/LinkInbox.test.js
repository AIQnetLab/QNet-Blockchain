/**
 * The link inbox (services/LinkInbox over the native inbox, android LinkInbox.kt / ios LinkInbox.swift): a link the
 * system hands to the app waits there until the screen that shows it is done with it, so it is heard by whichever
 * screen is up, once each, one at a time in the order they came, and by the next screen again while it is not done;
 * never applied twice.
 */
const { AppState } = require('react-native');
const { fakeLinkInbox } = require('../test-support/linkInbox');
const { watchLinks } = require('../src/services/LinkInbox');

const SOL = 'https://link.aiqnet.io/send#to=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin&amount=0.001';
const LINK = 'https://link.aiqnet.io/l#v1.x';
const tick = () => new Promise((r) => { setTimeout(r, 0); });

let inbox;
let appState;
beforeEach(() => {
  inbox = fakeLinkInbox();
  appState = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'change') appState.push(fn);
    return { remove: () => { appState = appState.filter((f) => f !== fn); } };
  });
});
afterEach(() => {
  inbox.remove();
  jest.restoreAllMocks();
});

const heard = () => {
  const got = [];
  return { got, onLink: (url, done, { waited }) => got.push({ url, done, waited }) };
};

it('a link that came before any screen listened is heard when one is up, once, whatever cues follow', async () => {
  inbox.arrive(SOL, { event: false });
  const a = heard();
  const stop = watchLinks(a.onLink);
  await tick();
  expect(a.got.map((x) => x.url)).toEqual([SOL]);
  // The app comes to the front, Linking says a link came: the same link is not heard again.
  appState.forEach((fn) => fn('active'));
  inbox.arrive(SOL);
  await tick();
  expect(a.got.map((x) => x.url)).toEqual([SOL]);
  stop();
  expect(inbox.listening()).toBe(0);
});

it('a screen made anew (Back finished the activity, the JS started again) hears every link not done yet, and no other', async () => {
  inbox.arrive(SOL, { event: false });
  inbox.arrive(LINK, { event: false });
  const first = heard();
  const stopFirst = watchLinks(first.onLink);
  await tick();
  // One at a time: the second waits until the screen is done with the first.
  expect(first.got.map((x) => x.url)).toEqual([SOL]);
  first.got[0].done();
  await tick();
  expect(first.got.map((x) => x.url)).toEqual([SOL, LINK]);
  stopFirst();
  const next = heard();
  const stopNext = watchLinks(next.onLink);
  await tick();
  expect(next.got.map((x) => x.url)).toEqual([LINK]);
  // Done twice by one screen tells the inbox once; the screen that went may still let its link go.
  first.got[0].done();
  expect(inbox.module.done).toHaveBeenCalledTimes(1);
  next.got[0].done();
  first.got[1].done();
  expect(inbox.waiting()).toEqual([]);
  stopNext();
});

it('links that come while a screen listens are heard in their order, each once the screen is done with the one before', async () => {
  const a = heard();
  const stop = watchLinks(a.onLink);
  await tick();
  inbox.arrive(SOL);
  inbox.arrive(LINK);
  await tick();
  expect(a.got.map((x) => x.url)).toEqual([SOL]);
  // Cues and the app's return to the front hand nothing more while the screen holds a link.
  inbox.cue();
  appState.forEach((fn) => fn('active'));
  await tick();
  expect(a.got.map((x) => x.url)).toEqual([SOL]);
  // Done with it: the next one, which arrived while the screen held it, at once and with no cue.
  a.got[0].done();
  await tick();
  expect(a.got.map((x) => [x.url, x.waited])).toEqual([[SOL, false], [LINK, true]]);
  // A link that came with no event (a new activity in the running app), after the screen let the last one go, waited
  // behind none: heard when the app is in front again.
  a.got[1].done();
  await tick();
  inbox.arrive(`${LINK}2`, { event: false });
  appState.forEach((fn) => fn('active'));
  await tick();
  expect(a.got.map((x) => [x.url, x.waited])).toEqual([[SOL, false], [LINK, true], [`${LINK}2`, false]]);
  stop();
});

it('a look that read the inbox just before the screen let a link go never hands it over again', async () => {
  inbox.arrive(SOL, { event: false });
  const a = heard();
  // The screen lets every link go as soon as it hears it (a link it refuses), while another look is under way.
  const stop = watchLinks((url, done, o) => { a.onLink(url, done, o); done(); });
  appState.forEach((fn) => fn('active'));
  await tick();
  await tick();
  expect(a.got.map((x) => x.url)).toEqual([SOL]);
  stop();
});

it('with no native inbox nothing is heard and nothing fails', async () => {
  delete require('react-native').NativeModules.QNetLinkInbox;
  const a = heard();
  const stop = watchLinks(a.onLink);
  await tick();
  expect(a.got).toEqual([]);
  stop();
});

describe('the link path\'s lines (noteLink)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const { noteLink } = require('../src/services/LinkInbox');

  it('go to the native inbox as the event and its fields, and a missing or failing inbox stops nothing', () => {
    const note = jest.fn();
    inbox.module.note = note;
    noteLink('answer_delivered', { intent: 'connect', status: 201, ms: 842 });
    noteLink('transfer_form_opened', { token: 'SOL' });
    noteLink('request_shown');
    expect(note.mock.calls).toEqual([
      ['answer_delivered', { intent: 'connect', status: 201, ms: 842 }], ['transfer_form_opened', { token: 'SOL' }],
      ['request_shown', {}],
    ]);
    inbox.module.note = () => { throw new Error('bridge'); };
    expect(() => noteLink('request_shown', { intent: 'link' })).not.toThrow();
    delete inbox.module.note;
    expect(() => noteLink('request_shown', { intent: 'link' })).not.toThrow();
    inbox.remove();
    expect(() => noteLink('request_shown', { intent: 'link' })).not.toThrow();
  });

  // The native lines are written in every build (the JS logger only in development): the same events and keys on both
  // platforms (LinkInboxTest.kt for Android's line), and each link that comes is said with how many wait.
  it('are written by the native inbox on both platforms, with the same events and keys, and so is each link that comes', () => {
    const kt = read('android/app/src/main/java/com/qnetmobile/LinkInbox.kt');
    const swift = read('ios/QNetMobile/LinkInbox.swift');
    const table = (src, start, end) => {
      const body = src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
      return [...body.matchAll(/"([a-z_]+)"(?: to listOf\(|: \[)([^)\]]*)/g)].map((m) => [m[1], m[2].replace(/[\s"]/g, '').split(',').filter(Boolean)]);
    };
    const android = table(kt, 'internal val NOTE_KEYS = mapOf(', '\n)');
    expect(android).toEqual([
      ['request_shown', ['intent', 'offer']], ['answer_delivered', ['intent', 'status', 'ms']],
      ['answer_not_delivered', ['intent', 'outcome', 'status', 'ms']], ['transfer_form_opened', ['token']],
    ]);
    expect(table(swift, 'private static let noteKeys: [String: [String]] = [', '\n  ]')).toEqual(android);
    expect(kt).toMatch(/private const val NOTE_WARN = "answer_not_delivered"/);
    expect(swift).toMatch(/private static let noteWarn = "answer_not_delivered"/);
    expect(kt).toMatch(/private val NOTE_CODE = Regex\("\^\[A-Za-z0-9_\]\{1,16\}\$"\)/);
    expect(swift).toContain('text.range(of: "^[A-Za-z0-9_]{1,16}$", options: .regularExpression)');
    expect(kt).toMatch(/it >= 0 && it < 1e9 && it == Math\.floor\(it\)/);
    expect(swift).toMatch(/d\.isFinite && d >= 0 && d < 1e9 && d == d\.rounded\(\.down\)/);
    // The module's method, in its log. Android writes every line of the link path with Log.println, which the release
    // build keeps: its R8 rules strip the level calls (d, v, i, w, e) and list no println.
    expect(kt).toMatch(/@ReactMethod\s*fun note\(event: String, fields: ReadableMap\) \{\s*val line = noteLine\(event, fields\.toHashMap\(\)\) \?: return\s*linkLog\(line\.startsWith\("\[WARN\]"\), line\)/);
    expect(kt).toMatch(/internal fun prodLog\(tag: String, warn: Boolean, line: String\) \{\s*Log\.println\(if \(warn\) Log\.WARN else Log\.INFO, tag, line\)\s*\}/);
    expect(kt).toMatch(/private fun linkLog\(warn: Boolean, line: String\) = prodLog\(PrefsLinkStore\.TAG, warn, line\)/);
    // The connection pool's lines too: each through AppNetwork.log, whose default is prodLog, at the level its line names.
    const net = read('android/app/src/main/java/com/qnetmobile/AppNetwork.kt');
    expect(net).toMatch(/internal var log: \(warn: Boolean, line: String\) -> Unit = \{ warn, line -> prodLog\("QNetNetwork", warn, line\) \}/);
    expect(net).not.toMatch(/\bLog\.[dviwe]\(/);
    // Nowhere in the app's Kotlin does a line go through a level call the release build strips.
    const kotlin = 'android/app/src/main/java/com/qnetmobile';
    const stripping = fs.readdirSync(path.join(__dirname, '..', kotlin)).filter((f) => f.endsWith('.kt'))
      .filter((f) => /\bLog\.[dviwe]\(/.test(read(`${kotlin}/${f}`)));
    expect(stripping).toEqual([]);
    const lines = [...net.matchAll(/\blog\((true|false), "\[(WARN|INFO)\]\[NET\] /g)];
    expect([lines.length, lines.every((m) => (m[1] === 'true') === (m[2] === 'WARN'))]).toEqual([5, true]);
    expect(kt).toMatch(/Inbox\(store = PrefsLinkStore\(context\.applicationContext\), log = ::linkLog\)/);
    expect(kt).toContain('linkLog(true, "[WARN][LINK] store_write_failed waiting_bytes=${value.length}")');
    expect(kt).not.toMatch(/\bLog\.[dviwe]\(/);
    const r8 = read('android/app/proguard-rules.pro');
    const stripped = r8.slice(r8.indexOf('-assumenosideeffects class android.util.Log {'), r8.indexOf('}', r8.indexOf('-assumenosideeffects class android.util.Log {')));
    expect(stripped).toMatch(/public static \*\*\* i\(\.\.\.\);/);
    expect(stripped).not.toMatch(/println/);
    expect(read('android/app/build.gradle')).toMatch(/minifyEnabled true/);
    expect(swift).toMatch(/@objc\(note:fields:\)\s*func note\(_ event: String, fields: NSDictionary\) \{\s*guard let line = QNetLinkInbox\.noteLine\(event, fields as\? \[String: Any\] \?\? \[:\]\) else \{ return \}\s*NSLog\("%@", line\)/);
    expect(read('ios/QNetMobile/QNetLinkInbox.m')).toMatch(/RCT_EXTERN_METHOD\(note:\(nonnull NSString \*\)event fields:\(nonnull NSDictionary \*\)fields\)/);
    // Each link the system hands over, as it is kept.
    expect(kt).toMatch(/links\.add\(WaitingLink\(next\+\+, url, now\(\)\)\)\s*save\(\)\s*log\(false, "\[INFO\]\[LINK\] link_received waiting=\$\{links\.size\}"\)/);
    expect(swift).toMatch(/save\(links\)\s*NSLog\("\[INFO\]\[LINK\] link_received waiting=%ld", links\.count\)/);
  });

  it('the link path writes its lines only through it: the sheet and the delivery have no logger', () => {
    for (const f of ['src/services/QNetLink.js', 'src/screens/QNetLinkScreen.js']) {
      const src = read(f);
      expect([f, /\[(INFO|WARN)\]\[LINK\]/.test(src), /from '\.\.\/utils\/logger'/.test(src)]).toEqual([f, false, false]);
    }
    expect(read('src/services/QNetLink.js')).toMatch(/noteLink\('answer_delivered', took\);/);
    expect(read('src/screens/QNetLinkScreen.js')).toMatch(/noteLink\('request_shown', \{ intent: link\.intent, offer: /);
  });
});
