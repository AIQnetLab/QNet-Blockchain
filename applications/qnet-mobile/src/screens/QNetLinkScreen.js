// The confirmation screen of a QNet Link request (services/QNetLink): shown only for a link the OS delivered
// through App Links / Universal Links that parsed and whose relay session matched it. It says exactly what
// will happen, a Reject answers `rejected` with no authentication, and Confirm asks for the device authentication (or
// the app password) before anything is shared or signed. Confirm arms only after the screen has been on view untouched
// for a moment, and only a press that begins after that counts (utils/useArmedConfirm). The outcome is shown here, so
// nothing depends on the site receiving the answer. The same sheets, texts and buttons on every phone and tablet.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, BackHandler, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { hasKey } from '../i18n';
import {
  openSession, prepareOffer, performIntent, deliverAnswer, markHandled, groupCheckNumber, LinkRefusal,
} from '../services/QNetLink';
import { useArmedConfirm } from '../utils/useArmedConfirm';

export const ARM_MS = 1000;

const TITLES = {
  connect: 'link_title_connect', reserve: 'link_title_reserve', link: 'link_title_link', claim: 'link_title_claim',
  unlink: 'link_title_unlink',
};
const AUTH = {
  connect: 'link_auth_connect', reserve: 'link_auth_reserve', link: 'link_auth_link', claim: 'link_auth_claim',
  unlink: 'link_auth_unlink',
};
const WORKING = {
  connect: 'link_working_send', reserve: 'link_working_send', link: 'link_working_link', claim: 'link_working_claim',
  unlink: 'link_working_unlink',
};
// The unlink from a device that does not run the node: the wallet key ends the binding on whichever device holds it.
const WALLET_UNLINK = { title: 'link_title_unlink_wallet', auth: 'link_auth_unlink_wallet', working: 'link_working_unlink_wallet' };
const byWallet = (o) => !!o && o.kind === 'unlink' && o.mode === 'wallet';

// A node balance in nanoQNC as the sheet shows it.
const qncText = (nano) => `${(Number(nano) / 1e9).toFixed(6).replace(/\.?0+$/, '')} QNC`;
// A wallet named on the sheet: its start and its end.
const shortAddress = (a) => (typeof a === 'string' && a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : String(a || ''));
// The day this device was linked (Unix seconds), as the sheet shows it.
const pad2 = (n) => String(n).padStart(2, '0');
const dayText = (s) => { const d = new Date(s * 1000); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

// `afterOther`: this request arrived while another one was on screen and waited until that one was closed
// (R4-MOBLINK-01); the screen says so before anything can be confirmed. `onShown` tells the owner the user has this
// request in front of them; `onGone` that the screen is going (the owner closes any prompt it opened for it).
// `onOutcome` hands the owner the outcome as soon as there is one, even after this screen went: a request the user
// decided stays with the owner across a lock, and comes back `settled` with that `settledOutcome` (or, while it is
// still being carried out, without one, until it arrives), so what the user must see is never lost with the screen
// (MOBLINK-R5-02). `node`: the Node side of the open wallet (services/NodeLinkActions); `onPrivacy` opens the privacy
// policy in the system browser; `onOpenNode` shows the Node tab; `onPlayDialog(kind)` shows Google Play's own dialog
// where the build has one.
export default function QNetLinkScreen({
  link, wallet, t, authenticate, onClose, node = null,
  onSettled = () => {}, onShown = () => {}, onGone = () => {}, afterOther = false,
  onOutcome = () => {}, settled = false, settledOutcome = null,
  onPrivacy = () => {}, onOpenNode = null, onPlayDialog = null,
}) {
  // loading | refused | unavailable | confirm | working | done
  const [phase, setPhase] = useState(settled ? (settledOutcome ? 'done' : 'working') : 'loading');
  const [refusal, setRefusal] = useState(null);
  const [offer, setOffer] = useState(null);
  const [answer, setAnswer] = useState(settled ? settledOutcome : null);
  // null while sending, then delivered | conflict | expired | failed; 'resumed' for an outcome shown again after a lock
  const [delivery, setDelivery] = useState(settled ? 'resumed' : null);
  // The check number, once the relay took an answer that asked for it (kept with the outcome across a lock).
  const [check, setCheck] = useState((settled && settledOutcome && settledOutcome.check) || null);
  const session = useRef(null);
  const alive = useRef(true);
  const acting = useRef(settled);
  const resumed = useRef(settled);

  const set = (fn) => (value) => { if (alive.current) fn(value); };

  // The user decided (or there was nothing to decide): this device will not act on the session again.
  const settle = async () => {
    await markHandled(link.id);
    onSettled();
  };

  // Shows the outcome and sends the answer; the delivery and the hand-over to the owner go on even if the screen
  // closes meanwhile.
  const send = (ans) => {
    onOutcome(ans);
    set(setAnswer)(ans);
    set(setDelivery)(null);
    set(setPhase)('done');
    const onCheck = (n) => {
      onOutcome({ ...ans, check: n });
      set(setCheck)(n);
    };
    deliverAnswer(link, session.current, ans, { onCheck })
      .then(set(setDelivery), () => set(setDelivery)('failed'));
  };

  // A request shown again after a lock: its outcome, once the work that was under way when the wallet locked ends.
  useEffect(() => {
    if (!resumed.current || !settledOutcome) return;
    setAnswer(settledOutcome);
    if (settledOutcome.check) setCheck(settledOutcome.check);
    setPhase('done');
  }, [settledOutcome]);

  useEffect(() => {
    alive.current = true;
    if (resumed.current) return () => { alive.current = false; };
    (async () => {
      try {
        session.current = await openSession(link);
      } catch (e) {
        set(setRefusal)(e instanceof LinkRefusal ? e.reason : 'network');
        set(setPhase)('refused');
        return;
      }
      let o;
      try {
        o = await prepareOffer(link, { wallet, session: session.current, node });
      } catch (_) {
        o = { kind: 'unavailable', error: 'INTERNAL' };
      }
      if (!alive.current) return;
      setOffer(o);
      if (o.kind === 'unavailable' && o.error === 'NO_WALLET') {
        // Nothing to confirm and nothing revealed: the site learns only that there is no wallet here.
        acting.current = true;
        await settle();
        send({ status: 'error', error: 'NO_WALLET' });
        return;
      }
      setPhase(o.kind === 'unavailable' ? 'unavailable' : 'confirm');
    })();
    return () => { alive.current = false; };
  }, [link]); // eslint-disable-line react-hooks/exhaustive-deps

  const { armed, onTouchStart, onPressIn, pressCounts } = useArmedConfirm(phase === 'confirm', ARM_MS);

  // A new link never takes this screen's place while it is up (the owner queues it: R4-MOBLINK-01).
  useEffect(() => {
    onShown();
    return () => onGone();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const reject = async () => {
    if (acting.current) return;
    acting.current = true;
    await settle();
    send({ status: 'rejected' });
  };

  // The only button of a request the wallet cannot offer: it answers with the reason, which is no rejection.
  const dismissUnavailable = async () => {
    if (acting.current) return;
    acting.current = true;
    await settle();
    deliverAnswer(link, session.current, { status: 'error', error: offer.error }).catch(() => {});
    onClose();
  };

  const confirm = async () => {
    if (!armed || !pressCounts() || acting.current || phase !== 'confirm') return;
    if (Date.now() >= session.current.expiresAt) {
      setRefusal('expired');
      setPhase('refused');
      return;
    }
    acting.current = true;
    let ok = false;
    try { ok = (await authenticate(t(byWallet(offer) ? WALLET_UNLINK.auth : AUTH[link.intent]))) === true; } catch (_) { ok = false; }
    if (!ok || !alive.current) {
      acting.current = false;
      return;
    }
    await settle();
    set(setPhase)('working');
    let ans;
    try {
      ans = await performIntent(link, offer, { node });
    } catch (_) {
      ans = { status: 'error', error: 'INTERNAL' };
    }
    send(ans);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (phase === 'confirm' && acting.current) return false; // the authentication prompt above handles it
      if (phase === 'confirm') reject();
      else if (phase === 'unavailable') dismissUnavailable();
      else if (phase !== 'working' && phase !== 'loading') onClose();
      return true;
    });
    return () => sub.remove();
  });

  // An error code this build has no text for is shown as the generic one.
  const errText = (error) => t(hasKey(`link_err_${error}`) ? `link_err_${error}` : 'link_err_INTERNAL');
  // Why this device cannot take the node, when a check of the device or the network said so.
  const deviceReasonText = (reason) => {
    if (reason === 'device_secondary_user') return t('node_main_profile');
    if (reason === 'device_unsupported' || reason === 'device_desktop' || reason === 'device_emulator') return t('node_cant_run');
    if (typeof reason === 'string' && reason.startsWith('device_')) return t('node_cant_run_now');
    return null;
  };
  // Google Play's licence dialog, on the builds that carry its text (Android).
  const licenceFix = (reason) => reason === 'device_unlicensed' && onPlayDialog && hasKey('node_play_licence');

  const row = (label, value, key) => (
    <View style={s.row} key={key || label}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.mono} selectable>{value}</Text>
    </View>
  );

  // A whole address on one line: the font shrinks to fit the card before anything would wrap or be cut. A larger
  // system text size counts up to 1.2 times, so half of that size still holds the address on a 320 dp screen.
  const addressRow = (label, value) => (
    <View style={s.row} key={label}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.mono} selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} maxFontSizeMultiplier={1.2} testID="link-address">{value}</Text>
    </View>
  );

  const button = (label, onPress, kind = 'primary', disabled = false, pressIn = undefined) => (
    <TouchableOpacity
      key={label}
      style={[s.button, kind === 'primary' ? s.primary : s.secondary, disabled && s.disabled]}
      onPress={onPress}
      onPressIn={pressIn}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      <Text style={[s.buttonText, kind !== 'primary' && s.secondaryText]}>{label}</Text>
    </TouchableOpacity>
  );

  const refusalText = () => ({
    handled: t('link_refused_handled'),
    not_found: t('link_refused_not_found'),
    expiring: t('link_refused_expiring'),
    expired: t('link_expired_now'),
    answered: t('link_refused_answered'),
    mismatch: t('link_refused_mismatch'),
  }[refusal] || t('link_refused_network'));

  // The device check the link sheet discloses (plan-technical 16.1): Confirm consents to it, the unlink sheet ends it.
  const deviceBlock = (o) => (o.device && o.device.capable === true ? (
    <View style={s.block}>
      <Text style={s.text}>
        <Text style={s.bold}>{t('link_device_check_title')}</Text>
        {` ${t('link_device_check_body')} `}
        <Text style={s.link} onPress={onPrivacy} accessibilityRole="link">{t('legal_privacy')}</Text>
      </Text>
    </View>
  ) : <Text style={s.warning}>{t('link_cant_run_sheet')}</Text>);

  const offerBody = () => {
    const o = offer;
    if (o.kind === 'connect') {
      return (
        <>
          <Text style={s.text}>{t('link_connect_body')}</Text>
          {addressRow(t('link_qnet_address'), o.addresses.qnet)}
          {addressRow(t('link_solana_address'), o.addresses.solana)}
        </>
      );
    }
    // The reservation of this wallet's light node: the rows of the link sheet, and no funds leave the wallet.
    if (o.kind === 'reserve') {
      return (
        <>
          <Text style={s.text}>{t('link_reserve_body')}</Text>
          {row(t('link_node'), o.nodeId)}
          {addressRow(t('link_wallet'), o.qnet)}
        </>
      );
    }
    // The end of the binding on another device, by the wallet key: what stops there and what stays with the wallet, and
    // the day that device was linked. The kind of device is not named: no text of the app names a platform.
    if (byWallet(o)) {
      return (
        <>
          <Text style={s.text}>{t('link_unlink_wallet_body')}</Text>
          {row(t('link_node'), o.nodeId)}
          {addressRow(t('link_wallet'), o.qnet)}
          {Number.isSafeInteger(o.since) ? row(t('link_unlink_linked_since'), dayText(o.since)) : null}
        </>
      );
    }
    // The end of this device's binding: what stops here and what stays with the wallet, and since when it ran here.
    if (o.kind === 'unlink') {
      return (
        <>
          <Text style={s.text}>{t('link_unlink_body')}</Text>
          {row(t('link_node'), o.nodeId)}
          {addressRow(t('link_wallet'), o.qnet)}
          {Number.isSafeInteger(o.since) ? row(t('link_unlink_since'), dayText(o.since)) : null}
        </>
      );
    }
    if (o.kind === 'link') {
      return (
        <>
          <Text style={s.text}>{t(o.mode === 'device' ? 'link_link_existing_body' : 'link_link_body')}</Text>
          {row(t('link_node'), o.nodeId)}
          {addressRow(t('link_wallet'), o.qnet)}
          {o.switchFrom ? <Text style={s.warning}>{t('link_switch_other', { wallet: shortAddress(o.switchFrom) })}</Text> : null}
          {deviceBlock(o)}
        </>
      );
    }
    return (
      <>
        {o.kind === 'claim' ? null : <Text style={s.text}>{t('link_claim_empty')}</Text>}
        {o.kind === 'claim' ? row(t('link_claim_amount'), qncText(o.amountNano)) : null}
        {addressRow(t('link_wallet'), o.qnet)}
      </>
    );
  };

  const outcome = () => {
    const a = answer;
    if (a.status === 'rejected') return <Text style={s.text}>{t('link_result_rejected')}</Text>;
    if (a.status === 'error') {
      const why = deviceReasonText(a.reason);
      // Sent, and no answer told whether it was done: said as unknown, never as "nothing changed" (MN-R4-05).
      if (a.unknown) {
        return <Text style={s.text}>{t(link.intent === 'claim' ? 'claim_note_unknown' : 'node_use_unknown')}</Text>;
      }
      return (
        <>
          <Text style={s.text}>{errText(a.error)}</Text>
          {why ? <Text style={s.text}>{why}</Text> : null}
          {licenceFix(a.reason) ? <Text style={s.text}>{t('node_play_licence')}</Text> : null}
        </>
      );
    }
    if (link.intent === 'connect') return <Text style={s.text}>{t('link_result_connect')}</Text>;
    if (link.intent === 'reserve') return <Text style={s.text}>{t('link_result_reserve')}</Text>;
    if (link.intent === 'unlink') {
      if (a.byWallet) return <Text style={s.text}>{t('link_result_unlinked_wallet')}</Text>;
      return <Text style={s.text}>{t(a.unbound === true ? 'link_result_unlinked' : 'link_result_unlinked_unconfirmed')}</Text>;
    }
    if (a.status === 'linked') return <Text style={s.text}>{t('link_result_linked')}</Text>;
    if (a.status === 'empty') return <Text style={s.text}>{t('link_result_claim_empty')}</Text>;
    if (link.intent === 'claim') {
      return (
        <>
          <Text style={s.text}>{t('link_result_claim', { amount: qncText(a.amountNano) })}</Text>
          <Text style={s.hint}>
            {a.stoppedAtEpoch !== null && a.stoppedAtEpoch !== undefined
              ? t('claim_stopped_at', { epoch: a.stoppedAtEpoch }) : t('claim_credited_on_block')}
          </Text>
        </>
      );
    }
    if (a.here !== false && a.reason) {
      // The consent stands; the network refused this device's binding for good.
      const why = deviceReasonText(a.reason);
      return (
        <>
          <Text style={s.text}>{t('link_result_consent_only')}</Text>
          <Text style={s.text}>{errText('BIND_REFUSED')}</Text>
          {why ? <Text style={s.text}>{why}</Text> : null}
          {licenceFix(a.reason) ? <Text style={s.text}>{t('node_play_licence')}</Text> : null}
        </>
      );
    }
    return <Text style={s.text}>{t(a.here === false ? 'link_result_consent_only' : 'node_linking')}</Text>;
  };

  const deliveryText = () => {
    if (!answer || answer.error === 'NO_WALLET' || delivery === 'resumed') return null;
    if (delivery === null) return <Text style={s.hint}>{t('link_working_send')}</Text>;
    if (delivery === 'delivered') return <Text style={s.hint}>{t('link_delivered')}</Text>;
    if (delivery === 'conflict') return <Text style={s.warning}>{t('link_delivery_conflict')}</Text>;
    return <Text style={s.hint}>{t(delivery === 'expired' ? 'link_delivery_expired' : 'link_delivery_failed')}</Text>;
  };

  // The six digits the page compares, once the relay took the answer (qnet-link-v1 section 14.6). A no-break space joins
  // the two groups into one number, so a right-to-left language keeps them in their order.
  const checkText = () => (check ? (
    <View style={s.block}>
      <Text style={s.check} selectable>{t('link_check_number', { number: groupCheckNumber(check).replace(' ', '\u00a0') })}</Text>
      <Text style={s.hint}>{t('link_check_hint')}</Text>
    </View>
  ) : null);

  const title = () => {
    if (phase === 'refused') return t('link_refused_title');
    if (phase === 'done') return t('link_done');
    if (phase === 'unavailable') return t('link_unavailable_title');
    if (byWallet(offer)) return t(WALLET_UNLINK.title);
    return t(TITLES[link.intent] || 'link_title_connect');
  };

  const doneButtons = () => {
    const out = [];
    if (answer && licenceFix(answer.reason)) out.push(button(t('node_play_open'), () => onPlayDialog('licence'), 'secondary'));
    if (onOpenNode && answer && (answer.status === 'linked' || (link.intent === 'link' && answer.status === 'ok'))) {
      out.push(button(t('link_open_node_tab'), onOpenNode, 'secondary'));
    }
    out.push(button(t('link_close'), onClose, 'primary'));
    return out;
  };

  return (
    <SafeAreaView style={s.overlay} edges={['top', 'bottom', 'left', 'right']} onTouchStart={onTouchStart}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.origin}>{t('link_origin')}</Text>
          <Text style={s.title}>{title()}</Text>

          {phase === 'loading' || phase === 'working' ? (
            <View style={s.busy}>
              <ActivityIndicator color="#00d4ff" />
              <Text style={s.text}>
                {phase === 'loading' ? t('link_loading') : t(byWallet(offer) ? WALLET_UNLINK.working : (WORKING[link.intent] || 'link_working_send'))}
              </Text>
            </View>
          ) : null}

          {phase === 'refused' ? <Text style={s.text}>{refusalText()}</Text> : null}
          {phase === 'unavailable' ? (
            <>
              <Text style={s.text}>{errText(offer.error)}</Text>
              {deviceReasonText(offer.reason) ? <Text style={s.text}>{deviceReasonText(offer.reason)}</Text> : null}
            </>
          ) : null}

          {phase === 'confirm' ? (
            <>
              {afterOther ? <Text style={s.warning}>{t('link_after_other')}</Text> : null}
              <Text style={s.warning}>{t('link_started_here')}</Text>
              {offerBody()}
            </>
          ) : null}

          {phase === 'done' ? (
            <>
              {outcome()}
              {checkText()}
              {deliveryText()}
            </>
          ) : null}

          <View style={s.actions}>
            {phase === 'confirm' ? [
              button(t('link_reject'), reject, 'secondary'),
              button(t('link_confirm'), confirm, 'primary', !armed, onPressIn),
            ] : null}
            {phase === 'unavailable' ? button(t('link_close'), dismissUnavailable, 'secondary') : null}
            {phase === 'refused' ? button(t('link_close'), onClose, 'secondary') : null}
            {phase === 'done' ? doneButtons() : null}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#11131f', zIndex: 9000, elevation: 20,
  },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 16 },
  card: {
    width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: '#1a1a2e', borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  origin: { color: '#888888', fontSize: 13, textAlign: 'center', marginBottom: 6 },
  title: { color: '#00d4ff', fontSize: 19, fontWeight: '700', textAlign: 'center', marginBottom: 14 },
  text: { color: '#ffffff', fontSize: 14, lineHeight: 20, marginBottom: 10 },
  bold: { fontWeight: '700' },
  link: { color: '#00d4ff', textDecorationLine: 'underline' },
  warning: { color: '#ffaa00', fontSize: 14, lineHeight: 20, marginBottom: 8 },
  hint: { color: '#888888', fontSize: 12, lineHeight: 17, marginTop: 6 },
  block: { marginTop: 4, marginBottom: 6 },
  check: { color: '#ffffff', fontSize: 20, fontWeight: '700', textAlign: 'center', marginVertical: 8 },
  row: { marginBottom: 10 },
  rowLabel: { color: '#888888', fontSize: 12, marginBottom: 2 },
  // Addresses and hashes stay left-to-right in every language.
  mono: { color: '#ffffff', fontSize: 13, fontFamily: 'monospace', writingDirection: 'ltr', textAlign: 'left' },
  busy: { alignItems: 'center', paddingVertical: 12, gap: 10 },
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

export const linkScreenStyles = s;
