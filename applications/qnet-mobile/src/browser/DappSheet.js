/**
 * The native confirmation sheet of an in-app browser request (browser/dappProvider): connect, sign a message,
 * send QNC, send a built-in token, call a contract. Drawn by the app over everything, never by the page. It names the
 * requesting origin (the registrable domain emphasised, an international name decoded with a warning), shows exactly
 * what will be shared, signed or sent, arms its confirm button only after the ready sheet has been on screen untouched
 * for a moment (utils/useArmedConfirm), and asks for the password (Android) or Face ID / Touch ID / passcode (iOS)
 * before anything happens. While the wallet has an unconfirmed transaction, a send says so and waits for it (the
 * sheet reads it again every few seconds), or takes its place when it is the one at the confirmed nonce + 1; a site's
 * send never goes in addition to it (browser/dappProvider, the extension's one transaction in flight).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, BackHandler, ActivityIndicator, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { describeOrigin } from './url';
import { useArmedConfirm } from '../utils/useArmedConfirm';
import {
  ARM_MS, SEND_ARM_MS, armDelayFor, previewShort, previewUnread, spendableNano, spendableTokenBase,
} from './dappProvider';
import { formatUnits } from './dappRequests';
import { refusalReason } from '../utils/txRefusal';

// A send moves money: a longer untouched look before it arms (the times live with the provider, which also counts
// a page that leaves under an armed sheet as a rejection).
export { ARM_MS, SEND_ARM_MS, armDelayFor };
export const REPEAT_WINDOW_MS = 30 * 60_000;
// The message box's border: what it shows of its text is its height less the border above and below.
const MESSAGE_BORDER = 1;

/**
 * Resolves once the app is in front (at once when it is), or after `timeoutMs` whatever it is. iOS reports the app
 * inactive while Face ID, Touch ID or the passcode is on screen, and the system's reply can arrive before the app is
 * active again: an approval waits for that, so a check the user just passed is never dropped (MB-01). Listeners run in
 * the order they were added, so the browser's own (added when it mounted) has seen the change by then.
 */
export function untilActive(timeoutMs = 3000) {
  // Only a state known to be away from the front waits ('unknown' before the first report counts as in front).
  const away = (s) => s === 'background' || s === 'inactive';
  if (!away(AppState.currentState)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let sub = null;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (sub) sub.remove();
      clearTimeout(timer);
      resolve(v);
    };
    sub = AppState.addEventListener('change', (next) => { if (next === 'active') finish(true); });
    timer = setTimeout(() => finish(!away(AppState.currentState)), timeoutMs);
  });
}

/**
 * Minutes since this wallet last sent exactly `amountNano` to `to` (an unconfirmed transaction, or one settled in
 * the last half hour), or null.
 */
export function repeatedPaymentMinutes(to, amountNano, pending, recent, now = Date.now()) {
  const amount = String(amountNano);
  let best = null;
  for (const p of pending || []) {
    if (p && p.to === to && p.amountNano !== null && String(p.amountNano) === amount) {
      const ms = Number(p.ageMs) || 0;
      if (best === null || ms < best) best = ms;
    }
  }
  for (const r of recent || []) {
    if (r && r.to === to && r.amountNano !== null && String(r.amountNano) === amount) {
      const ms = now - (Number(r.settledAt) || 0);
      if (ms < REPEAT_WINDOW_MS && (best === null || ms < best)) best = ms;
    }
  }
  return best === null ? null : Math.max(1, Math.round(best / 60_000));
}

/** Nano QNC (decimal string) as a QNC amount: "1500000000" → "1.5". */
export function formatNano(nano) {
  if (typeof nano !== 'string' || !/^\d+$/.test(nano)) return '—';
  const v = BigInt(nano);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Token base units (decimal string) in the token's own units: "1500" with 3 decimals → "1.5". */
export function formatTokenUnits(base, decimals) {
  return typeof base === 'string' && /^\d+$/.test(base) && Number.isInteger(decimals) ? formatUnits(base, decimals) : '—';
}

// ── What a send costs against what the preview read ──
const digits = (v) => typeof v === 'string' && /^\d+$/.test(v);
// Too few of the token: its balance, less what this wallet's unconfirmed transactions may still move of it.
const tokenBelow = (preview, d, pick = null) => !!preview && digits(preview.tokenBalanceBase)
  && spendableTokenBase(preview, pick) < BigInt(d.amountBase);
// A token transfer's QNC: the fee, and the deposit when the recipient holds none of the token yet.
const tokenTotalNano = (d, preview) => (BigInt(d.feeNano)
  + BigInt(preview && digits(preview.depositNano) ? preview.depositNano : '0')).toString();

/**
 * Whether the preview could not read a balance the send is checked against: the QNC balance for every send, the token
 * balance too for a token transfer (browser/dappProvider previewUnread). Such a send is not offered.
 */
export function sendUnread(type, preview) {
  return previewUnread({ type }, preview);
}

/**
 * What the sheet says when a balance went unread: a transaction from another device not confirmed yet, a balance not
 * confirmed yet (try again in a minute), or the wallet's state not read (the network did not answer).
 */
export function unreadKey(type, preview) {
  const problems = [preview && preview.balanceProblem, type === 'tokenTransfer' ? preview && preview.tokenProblem : null];
  if (problems.includes('foreign')) return 'balance_foreign_pending';
  if (problems.includes('unconfirmed')) return 'balance_unconfirmed';
  return 'dapp_send_preview_failed';
}

/**
 * Whether the preview shows the wallet cannot pay for the send with the choice `pick` about its unconfirmed
 * transactions, or could not read what it is checked against: the provider's rule (browser/dappProvider previewShort),
 * which refuses the approval of what this sheet does not offer.
 */
export function sendShort(type, d, preview, pick = null) {
  if (!preview || !d) return false;
  return previewShort({ ...d, type }, preview, pick);
}

/** Another known address that shares the first and last four characters (the extension's rule). */
export function looksLikeKnownAddress(candidate, known) {
  if (typeof candidate !== 'string' || candidate.length < 12) return false;
  return (known || []).some((a) => typeof a === 'string' && a !== candidate && a.length === candidate.length
    && a.slice(0, 4) === candidate.slice(0, 4) && a.slice(-4) === candidate.slice(-4));
}

export default function DappSheet({ view, actions, t, authenticate, accounts }) {
  const [acting, setActing] = useState(false);
  const [pick, setPick] = useState(null); // 'replace' while the wallet's one unconfirmed transaction may be replaced
  // A confirm that did nothing (the approval refused it) says so on the sheet, which stays.
  const [failNote, setFailNote] = useState(false);
  useEffect(() => { setFailNote(false); }, [view.id]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const kind = view.kind;
  // A send's type: 'transfer' (QNC), 'tokenTransfer' or 'contractCall'.
  const type = kind === 'send' && view.details && view.details.type ? view.details.type : 'transfer';
  const preview = view.preview;
  const outcome = view.outcome;
  const pending = preview && Array.isArray(preview.pending) ? preview.pending : [];
  // An earlier transaction holds the nonce and cannot be replaced: nothing to confirm until it is in a block.
  const inFlight = kind === 'send' && pending.length > 0 && !!preview && preview.inFlight !== false;
  const needsPick = kind === 'send' && pending.length > 0 && !inFlight;
  const shownNonce = !preview || inFlight ? null
    : !needsPick ? preview.nonce
      : pick === 'replace' ? preview.replaceNonce : null;
  // A message to sign counts as seen only once all of it has been on screen: it fits its box, or the box was
  // scrolled to its end (MB3-02). Line breaks and runs of spaces can push most of a message below the first line.
  // The box's content (its padding included) fits when it is no taller than what the box shows inside its border (MB-05).
  const [msgBox, setMsgBox] = useState({ box: 0, content: 0, end: false });
  useEffect(() => { setMsgBox({ box: 0, content: 0, end: false }); }, [view.id]);
  const shownHeight = msgBox.box - 2 * MESSAGE_BORDER;
  const messageSeen = kind !== 'sign' || msgBox.end || (shownHeight > 0 && msgBox.content > 0 && msgBox.content <= shownHeight + 0.5);
  // A send the preview shows the wallet cannot pay for, with the choice made about its unconfirmed transactions, is not
  // offered (MB-08; the extension's INSUFFICIENT_FUNDS).
  const unaffordable = kind === 'send' && !!preview && sendShort(type, view.details, preview, needsPick ? pick : null);
  const ready = kind === 'sign' ? messageSeen : (kind !== 'send' || (!!preview && shownNonce !== null && !unaffordable));

  // The transfer preview (nonce, balance, recipients, unconfirmed transactions) is read when the sheet shows a send.
  useEffect(() => {
    if (kind === 'send' && !preview && !outcome) actions.loadPreview(view.id);
  }, [view.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // A preview that changes the question asks it again; the same one read again (every few seconds while a transaction
  // is unconfirmed) keeps the answer.
  const question = preview ? `${pending.map((p) => p.nonce).join(',')}|${preview.replaceNonce}|${preview.replaceHash}|${preview.nonce}` : '';
  useEffect(() => { setPick(null); }, [view.id, question]);

  // Armed only once what it confirms is complete (the preview read, the choice made) and stayed on screen untouched.
  const armKey = `${view.id}|${ready}|${pick}|${shownNonce}`;
  const { armed, onTouchStart, onPressIn, pressCounts, restart } = useArmedConfirm(ready && !outcome, armDelayFor(kind));
  const lastArmKey = useRef(armKey);
  useEffect(() => {
    if (lastArmKey.current !== armKey) { lastArmKey.current = armKey; restart(); }
  }, [armKey, restart]);

  const reject = () => {
    if (acting || view.busy) return;
    actions.reject(view.id);
  };

  const authReason = () => {
    const site = describeOrigin(view.origin);
    const host = site ? site.host : view.origin;
    if (kind === 'connect') return t('dapp_auth_connect', { site: host });
    if (kind === 'sign') return t('dapp_auth_sign', { site: host });
    if (type === 'tokenTransfer') return t('dapp_auth_token', { amount: `${view.details.amount} ${view.details.symbol}` });
    if (type === 'contractCall') return t('dapp_auth_call', { method: view.details.method, site: host });
    return t('dapp_auth_send', { amount: formatNano(view.details.amountNano) });
  };

  const confirm = async () => {
    // Only a press that began after the button armed counts (utils/useArmedConfirm).
    if (!armed || !pressCounts() || acting || view.busy || outcome) return;
    if (needsPick && !pick) return;
    setActing(true);
    setFailNote(false);
    let ok = false;
    // A send's recipient (a call's contract) goes on the fresh check itself, the system's prompt included (MPLAT-R5-01).
    const recipient = kind === 'send' && view.details ? view.details.to || view.details.contract || null : null;
    try { ok = (await authenticate(authReason(), null, recipient)) === true; } catch (_) { ok = false; }
    if (ok && alive.current) await untilActive();
    if (ok && alive.current) {
      const r = await actions.approve(view.id, needsPick ? pick : null);
      if (alive.current && r && r.status === 'failed') setFailNote(true);
    }
    if (alive.current) setActing(false);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (acting || view.busy) return true;
      if (outcome) actions.dismiss(view.id);
      else reject();
      return true;
    });
    return () => sub.remove();
  });

  const site = describeOrigin(view.origin);

  const row = (label, value, key) => (
    <View style={s.row} key={key || label}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.mono} selectable>{value}</Text>
    </View>
  );

  // A whole address on one line: the font shrinks to fit the sheet before anything would wrap or be cut. A larger
  // system text size counts up to 1.2 times, so half of that size still holds the address on a 320 dp screen.
  const addressRow = (label, value) => (
    <View style={s.row} key={label}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.mono} selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} maxFontSizeMultiplier={1.2} testID="dapp-address">{value}</Text>
    </View>
  );

  const button = (label, onPress, primary, disabled = false, pressIn = undefined) => (
    <TouchableOpacity
      key={label}
      style={[s.button, primary ? s.primary : s.secondary, disabled && s.disabled]}
      onPress={onPress}
      onPressIn={pressIn}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      <Text style={[s.buttonText, !primary && s.secondaryText]}>{label}</Text>
    </TouchableOpacity>
  );

  // One unconfirmed transaction of this wallet, as a line: what it is and how long ago it was signed.
  const pendingLine = (p) => {
    const age = t('time_min', { n: Math.max(1, Math.round((Number(p.ageMs) || 0) / 60_000)) });
    const what = p.kind === 'transfer' && p.amountNano !== null
      ? t('pending_line_transfer', { amount: `${formatNano(String(p.amountNano))} QNC`, to: p.to || '—' })
      : p.kind === 'call' ? t('pending_line_call', { method: p.method || '—', to: p.to || '—' })
        : p.kind === 'deploy' ? t('pending_line_deploy') : t('pending_line_other');
    return `${what} · ${age}`;
  };

  const choiceButton = (value, label, disabled) => (
    <TouchableOpacity
      key={value}
      style={[s.choice, pick === value && s.choiceOn, disabled && s.disabled]}
      onPress={() => { if (!disabled) setPick(value); }}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected: pick === value, disabled }}
      testID={`pick-${value}`}
    >
      <Text style={[s.choiceText, pick === value && s.choiceTextOn]}>{label}</Text>
    </TouchableOpacity>
  );

  const pendingBlock = () => (
    <View style={s.pendingBox}>
      <Text style={s.warning}>{t('pending_title', { count: pending.length })}</Text>
      {pending.map((p) => <Text key={`p${p.nonce}`} style={s.mono}>{pendingLine(p)}</Text>)}
      {inFlight ? <Text style={s.hint} testID="in-flight">{t('dapp_in_flight')}</Text> : (
        <>
          <Text style={s.hint}>{t('dapp_replace_or_wait')}</Text>
          <View style={s.choices}>{choiceButton('replace', t('pending_replace'), preview.replaceNonce === null)}</View>
          {pick === 'replace' ? <Text style={s.hint}>{t('pending_replace_note')}</Text> : null}
        </>
      )}
    </View>
  );

  const originBlock = () => (
    <View style={s.originBox}>
      <Text style={s.originLabel}>{t('dapp_request_from')}</Text>
      {site ? (
        <Text style={s.originHost} accessibilityLabel={site.host}>
          <Text style={s.originPrefix}>{site.prefix}</Text>
          <Text style={s.originDomain}>{site.domain}</Text>
          {site.port ? <Text style={s.originPrefix}>{`:${site.port}`}</Text> : null}
        </Text>
      ) : null}
      <Text style={s.originFull} selectable>{view.origin}</Text>
      {site && site.idn ? (
        <Text style={s.warning}>{t('dapp_idn_warning', { ascii: site.hostAscii })}</Text>
      ) : null}
    </View>
  );

  const connectBody = () => (
    <>
      <Text style={s.text}>{t('dapp_connect_body')}</Text>
      {addressRow(t('dapp_qnet_address'), accounts ? accounts.qnet : '—')}
      {addressRow(t('dapp_solana_address'), accounts ? accounts.solana : '—')}
    </>
  );

  const signBody = () => (
    <>
      <Text style={s.text}>{t('dapp_sign_body')}</Text>
      <ScrollView
        style={s.messageBox}
        contentContainerStyle={s.messageContent}
        nestedScrollEnabled
        testID="sign-message"
        scrollEventThrottle={100}
        onLayout={(e) => {
          const h = e && e.nativeEvent && e.nativeEvent.layout ? e.nativeEvent.layout.height : 0;
          setMsgBox((m) => ({ ...m, box: h }));
        }}
        onContentSizeChange={(w, h) => setMsgBox((m) => ({ ...m, content: h }))}
        onScroll={(e) => {
          const n = e && e.nativeEvent;
          if (!n) return;
          if (n.contentOffset.y + n.layoutMeasurement.height >= n.contentSize.height - 2) setMsgBox((m) => (m.end ? m : { ...m, end: true }));
        }}
      >
        <Text style={s.message} selectable>{view.details.message}</Text>
      </ScrollView>
      {!messageSeen ? <Text style={s.warning}>{t('dapp_sign_scroll')}</Text> : null}
      <Text style={s.hint}>{t('dapp_sign_bytes', { bytes: view.details.byteLength })}</Text>
    </>
  );

  // The recipient warnings of a transfer to `to`. Known: an address this wallet signed transfers to; the history only
  // adds warnings (MOBNET-R2-03).
  const recipientWarnings = (to) => {
    const known = preview.counterparties;
    const paid = Array.isArray(preview.paid) ? preview.paid : [];
    const senders = Array.isArray(preview.senders) ? preview.senders : [];
    const strange = !known.includes(to) && !(accounts && accounts.qnet === to);
    const lookAlike = strange && looksLikeKnownAddress(to, [...known, ...paid]);
    const incomingOnly = strange && senders.includes(to) && !paid.includes(to);
    return (
      <>
        {lookAlike ? <Text style={s.alert}>{t('dapp_send_lookalike')}</Text> : null}
        {incomingOnly && !lookAlike ? <Text style={s.alert}>{t('dapp_send_incoming_only')}</Text> : null}
        {strange && !lookAlike ? <Text style={s.warning}>{t('dapp_send_first_time')}</Text> : null}
      </>
    );
  };

  // What every send shows once the wallet's state is read: its unconfirmed transactions and the QNC balance.
  const walletRows = () => (
    <>
      {needsPick || inFlight ? pendingBlock() : null}
      {preview.balanceNano !== null ? row(t('dapp_send_balance'), `${formatNano(preview.balanceNano)} QNC`) : null}
    </>
  );

  const reading = () => (
    <View style={s.busy}>
      {view.previewError ? null : <ActivityIndicator color="#00d4ff" />}
      <Text style={view.previewError === 'TOKEN_DECIMALS' ? s.alert : s.hint}>
        {t(!view.previewError ? 'common_loading' : view.previewError === 'TOKEN_DECIMALS' ? 'dapp_token_decimals_differ' : 'dapp_send_preview_failed')}
      </Text>
    </View>
  );

  // Too little QNC for `totalNano`: the balance itself, or what the wallet's unconfirmed transfers leave of it
  // (dappProvider spendableNano), each said as it is; null when it covers it or was not read.
  const qncShort = (totalNano) => {
    if (!preview || !digits(preview.balanceNano)) return null;
    if (BigInt(preview.balanceNano) < BigInt(totalNano)) return 'dapp_send_insufficient';
    const left = spendableNano(preview, needsPick ? pick : null);
    return left !== null && left < BigInt(totalNano) ? 'dapp_send_insufficient_pending' : null;
  };
  const shortLine = (totalNano) => {
    const key = qncShort(totalNano);
    return key ? <Text style={s.alert}>{t(key)}</Text> : null;
  };

  const transferBody = () => {
    const d = view.details;
    const repeatMin = preview ? repeatedPaymentMinutes(d.to, d.amountNano, pending, preview.recent) : null;
    return (
      <>
        {row(t('dapp_send_to'), d.to)}
        {d.destroys ? <Text style={s.alert} testID="qnc-destroyed">{t('dapp_qnc_destroyed')}</Text> : null}
        {row(t('dapp_send_amount'), `${formatNano(d.amountNano)} QNC`)}
        {row(t('dapp_send_fee'), `${formatNano(d.feeNano)} QNC`)}
        {row(t('dapp_send_total'), `${formatNano(d.totalNano)} QNC`)}
        {preview ? (
          <>
            {repeatMin !== null ? <Text style={s.alert}>{t('send_repeat_body', { minutes: repeatMin })}</Text> : null}
            {walletRows()}
            {d.destroys ? null : recipientWarnings(d.to)}
            {shortLine(d.totalNano)}
            {sendUnread(type, preview) ? <Text style={s.alert}>{t(unreadKey(type, preview))}</Text> : null}
          </>
        ) : reading()}
      </>
    );
  };

  // A built-in token: what the token says it is (no proof covers it), the amount in its units and in base units, the
  // QNC it costs (the fee, and a deposit when the recipient holds none of it yet) and both balances.
  const tokenBody = () => {
    const d = view.details;
    const depositNano = preview && preview.depositNano !== null ? preview.depositNano : null;
    const totalNano = tokenTotalNano(d, preview);
    const tokenShort = !!preview && tokenBelow(preview, d, needsPick ? pick : null);
    return (
      <>
        {row(t('dapp_token'), d.name ? `${d.symbol} · ${d.name}` : d.symbol)}
        {row(t('dapp_token_contract'), d.token)}
        {d.reservedName ? <Text style={s.alert}>{t('tok_reserved_warning')}</Text> : null}
        {row(t('dapp_send_to'), d.to)}
        {d.destroys ? <Text style={s.alert}>{t('dapp_token_destroyed')}</Text> : null}
        {row(t('dapp_send_amount'), `${d.amount} ${d.symbol}`)}
        {row(t('dapp_token_base'), d.amountBase)}
        {row(t('dapp_send_fee'), `${formatNano(d.feeNano)} QNC`)}
        {preview ? (
          <>
            {depositNano !== null && depositNano !== '0' ? row(t('dapp_token_deposit'), `${formatNano(depositNano)} QNC`) : null}
            {row(t('dapp_send_total'), `${formatNano(totalNano)} QNC`)}
            {preview.listed ? null : <Text style={s.warning}>{t('dapp_token_unlisted')}</Text>}
            {walletRows()}
            {preview.tokenBalanceBase !== null
              ? row(t('dapp_token_balance'), `${formatTokenUnits(preview.tokenBalanceBase, d.decimals)} ${d.symbol}`) : null}
            {d.destroys ? null : recipientWarnings(d.to)}
            {tokenShort ? <Text style={s.alert}>{t('dapp_token_insufficient')}</Text> : null}
            {shortLine(totalNano)}
            {sendUnread(type, preview) ? <Text style={s.alert}>{t(unreadKey(type, preview))}</Text> : null}
          </>
        ) : reading()}
      </>
    );
  };

  // A WASM contract call: the contract (two genesis nodes agree it is a contract and no built-in token; the provider
  // refuses a call to anything else before this sheet), the method, the input as hex with its size (and its text when it
  // is readable), the gas limit and the most it can cost. It sends no QNC.
  const callBody = () => {
    const d = view.details;
    return (
      <>
        {row(t('dapp_call_contract'), d.contract)}
        <Text style={s.alert}>{t('dapp_call_unknown')}</Text>
        {row(t('dapp_call_method'), d.method)}
        <View style={s.row}>
          <Text style={s.rowLabel}>{t('dapp_call_input', { bytes: d.argsBytes })}</Text>
          <ScrollView style={s.inputBox} nestedScrollEnabled testID="call-input">
            <Text style={s.mono} selectable>{d.args || '—'}</Text>
          </ScrollView>
        </View>
        {d.argsText ? row(t('dapp_call_input_text'), d.argsText) : null}
        {row(t('dapp_call_gas'), d.gasLimit)}
        {row(t('dapp_call_max_fee'), `${formatNano(d.feeNano)} QNC`)}
        {preview ? (
          <>
            {walletRows()}
            {shortLine(d.feeNano)}
            {sendUnread(type, preview) ? <Text style={s.alert}>{t(unreadKey(type, preview))}</Text> : null}
          </>
        ) : reading()}
      </>
    );
  };

  const sendBody = () => (
    <>
      {view.notice ? (
        <Text style={s.alert}>
          {t({ settled: 'pending_settled_notice', recheck: 'dapp_recheck_notice' }[view.notice] || 'pending_changed_notice')}
        </Text>
      ) : null}
      {type === 'tokenTransfer' ? tokenBody() : type === 'contractCall' ? callBody() : transferBody()}
    </>
  );

  // A node's refusal is said as the Send form says it: final (never sent again, listed under Assets until the next
  // send takes its place), or one the wallet sends again while waiting may heal it; its reason in the app's language.
  const outcomeBody = () => {
    if (outcome.refusal && outcome.final) {
      return <Text style={s.text}>{t('tx_note_refused_final', { reason: refusalReason(t, outcome.refusal) })}</Text>;
    }
    // A recipient found to be a contract when it was read again at the approval (MOB-BR-R3-01): said as the Send form says it.
    if (outcome.recipient === 'contract') return <Text style={s.text}>{t('send_recipient_contract')}</Text>;
    if (outcome.error !== undefined) return <Text style={s.text}>{t('dapp_send_failed')}</Text>;
    const said = outcome.status === 'submitted' ? t('dapp_send_submitted')
      : outcome.refusal ? t('tx_note_refused', { reason: refusalReason(t, outcome.refusal) }) : t('dapp_send_unknown');
    return (
      <>
        <Text style={s.text}>{said}</Text>
        {outcome.txHash ? row(t('dapp_send_hash'), outcome.txHash) : null}
      </>
    );
  };

  const sendTitle = type === 'tokenTransfer' ? t('dapp_title_token')
    : type === 'contractCall' ? t('dapp_title_call') : t('dapp_title_send');
  const title = kind === 'connect' ? t('dapp_title_connect') : kind === 'sign' ? t('dapp_title_sign') : sendTitle;
  const confirmLabel = kind === 'connect' ? t('dapp_connect') : kind === 'sign' ? t('dapp_sign')
    : type === 'contractCall' ? t('dapp_call') : t('dapp_send');
  const busyText = kind === 'connect' ? t('dapp_working_connect') : kind === 'sign' ? t('dapp_working_sign') : t('dapp_working_send');

  return (
    <SafeAreaView style={s.overlay} edges={['top', 'bottom', 'left', 'right']} testID="dapp-sheet" onTouchStart={onTouchStart}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          {originBlock()}
          <Text style={s.title}>{title}</Text>
          {outcome ? outcomeBody() : kind === 'connect' ? connectBody() : kind === 'sign' ? signBody() : sendBody()}
          {view.busy ? (
            <View style={s.busy}>
              <ActivityIndicator color="#00d4ff" />
              <Text style={s.text}>{busyText}</Text>
            </View>
          ) : null}
          {view.queued > 0 && !outcome ? <Text style={s.hint}>{t('dapp_queued', { count: view.queued })}</Text> : null}
          {failNote && !outcome && !view.busy ? <Text style={s.alert}>{t('dapp_approve_again')}</Text> : null}
          <View style={s.actions}>
            {outcome ? button(t('dapp_close'), () => actions.dismiss(view.id), true) : [
              button(t('dapp_reject'), reject, false, acting || view.busy),
              // A preview that could not be read, or that came without a balance the send is checked against, offers to
              // read it again: Reject would count as a refusal for the site (MB-R2-03).
              kind === 'send' && ((view.previewError && !preview) || (preview && sendUnread(type, preview)))
                ? button(t('dapp_retry'), () => actions.loadPreview(view.id), true)
                : button(confirmLabel, confirm, true, !armed || acting || view.busy, onPressIn),
            ]}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  // Over the browser and every screen, under the password prompt and the alerts (WalletScreen modalOverlay):
  // elevation and zIndex rank it the same way, so it is drawn where it is touched.
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8, 10, 20, 0.97)', zIndex: 9000, elevation: 20,
  },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 16 },
  card: {
    width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: '#1a1a2e', borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  originBox: { alignItems: 'center', marginBottom: 12 },
  originLabel: { color: '#888888', fontSize: 12, marginBottom: 4 },
  originHost: { fontSize: 20, textAlign: 'center', writingDirection: 'ltr' },
  originPrefix: { color: '#9aa3b5', fontWeight: '400' },
  originDomain: { color: '#ffffff', fontWeight: '700' },
  originFull: { color: '#888888', fontSize: 12, fontFamily: 'monospace', marginTop: 4, textAlign: 'center', writingDirection: 'ltr' },
  title: { color: '#00d4ff', fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  text: { color: '#ffffff', fontSize: 14, lineHeight: 20, marginBottom: 10 },
  hint: { color: '#888888', fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 4 },
  warning: { color: '#ffaa00', fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 6 },
  alert: { color: '#ff5555', fontSize: 13, lineHeight: 19, fontWeight: '600', marginTop: 6, marginBottom: 6 },
  row: { marginBottom: 10 },
  rowLabel: { color: '#888888', fontSize: 12, marginBottom: 2 },
  // Addresses, amounts and hashes stay left-to-right in every language.
  mono: { color: '#ffffff', fontSize: 13, fontFamily: 'monospace', writingDirection: 'ltr', textAlign: 'left' },
  messageBox: {
    maxHeight: 220, backgroundColor: '#11131f', borderRadius: 8, borderWidth: MESSAGE_BORDER, borderColor: 'rgba(0, 212, 255, 0.2)',
  },
  // Inside the scrolled content, so the content height the fit check compares is the whole text with its padding.
  messageContent: { padding: 10 },
  message: { color: '#ffffff', fontSize: 14, lineHeight: 20 },
  inputBox: {
    maxHeight: 140, backgroundColor: '#11131f', borderRadius: 8, borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.2)', padding: 8,
  },
  busy: { alignItems: 'center', paddingVertical: 10, gap: 8 },
  pendingBox: {
    borderWidth: 1, borderColor: 'rgba(255, 170, 0, 0.4)', borderRadius: 10, padding: 10, marginTop: 6, marginBottom: 10, gap: 4,
  },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  choice: {
    flexGrow: 1, flexBasis: 120, minHeight: 40, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)', alignItems: 'center', justifyContent: 'center',
  },
  choiceOn: { backgroundColor: 'rgba(0, 212, 255, 0.2)', borderColor: '#00d4ff' },
  choiceText: { color: '#9aa3b5', fontSize: 14, textAlign: 'center' },
  choiceTextOn: { color: '#ffffff', fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  button: {
    flexGrow: 1, flexBasis: 128, minHeight: 44, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  primary: { backgroundColor: '#00d4ff' },
  secondary: { backgroundColor: 'rgba(0, 212, 255, 0.1)', borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)' },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#1a1a2e', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  secondaryText: { color: '#00d4ff' },
});

export const sheetStyles = s;