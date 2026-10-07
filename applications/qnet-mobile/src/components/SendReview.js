/**
 * The review of a send from the wallet's own Send form (MPLAT-R5-01), shown between Send and the fresh check: the
 * whole recipient in groups of four, the network, the amount, the fee, for a Solana token going to an address that
 * never held it the SOL its new token account takes, a payment request's memo, and the total, with the warnings the in-app
 * browser's send sheet gives (the MOBNET-R2-03 rule): a recipient this wallet never paid, one that looks like an address
 * it knows, one that only ever paid this wallet. What it shows is what was captured when Send was tapped, and that is
 * what is signed: a field changed afterwards changes nothing here. Confirm arms only after the review has been on
 * screen untouched for a moment, and only a press that began after that counts (utils/useArmedConfirm).
 */
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useArmedConfirm } from '../utils/useArmedConfirm';
import { SEND_ARM_MS } from '../browser/dappProvider';
import { looksLikeKnownAddress } from '../browser/DappSheet';
import { groupAddress } from '../utils/addressDisplay';

/**
 * The recipient warnings for `to` (lowercase EON), from the sealed list of addresses this wallet signed transfers to
 * and its unconfirmed ones (`counterparties`, known), and from the cached history (`paid`, `senders`), which only adds
 * warnings. { firstTime, lookAlike, incomingOnly }.
 */
export function recipientWarnings(to, own, { counterparties = [], paid = [], senders = [] } = {}) {
  const addr = String(to || '').toLowerCase();
  const self = String(own || '').toLowerCase() === addr;
  const known = counterparties.includes(addr);
  if (self || known) return { firstTime: false, lookAlike: false, incomingOnly: false };
  const lookAlike = looksLikeKnownAddress(addr, [...counterparties, ...paid]);
  return { firstTime: !lookAlike, lookAlike, incomingOnly: !lookAlike && senders.includes(addr) && !paid.includes(addr) };
}

export default function SendReview({ review, t, onCancel, onConfirm }) {
  const { armed, onTouchStart, onPressIn, pressCounts } = useArmedConfirm(true, SEND_ARM_MS);
  const w = review.warnings || {};

  const confirm = () => {
    if (!armed || !pressCounts()) return;
    onConfirm();
  };

  const row = (label, value) => (
    <View style={s.row} key={label}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.mono}>{value}</Text>
    </View>
  );

  return (
    <SafeAreaView style={s.overlay} edges={['top', 'bottom', 'left', 'right']} testID="send-review" onTouchStart={onTouchStart}>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.card}>
          <Text style={s.title}>{t('send_review_title')}</Text>
          <View style={s.row}>
            <Text style={s.rowLabel}>{t('send_review_to')}</Text>
            <Text style={s.recipient} testID="send-review-to">{groupAddress(review.to)}</Text>
          </View>
          {row(t('send_review_network'), review.network)}
          {row(t('send_review_amount'), review.amount)}
          {row(t('send_review_fee'), review.fee)}
          {review.account ? row(t('send_review_account'), review.account) : null}
          {review.memo ? row(t('send_review_memo'), review.memo) : null}
          {row(t('send_review_total'), review.total)}
          {w.lookAlike ? <Text style={s.alert}>{t('dapp_send_lookalike')}</Text> : null}
          {w.incomingOnly ? <Text style={s.alert}>{t('dapp_send_incoming_only')}</Text> : null}
          {w.firstTime ? <Text style={s.warning}>{t('dapp_send_first_time')}</Text> : null}
          <Text style={s.hint}>{t('send_review_check')}</Text>
          <View style={s.actions}>
            <TouchableOpacity style={[s.button, s.secondary]} onPress={onCancel} accessibilityRole="button">
              <Text style={[s.buttonText, s.secondaryText]}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.button, s.primary, !armed && s.disabled]}
              onPress={confirm}
              onPressIn={onPressIn}
              disabled={!armed}
              accessibilityRole="button"
              accessibilityState={{ disabled: !armed }}
              testID="send-review-confirm"
            >
              <Text style={s.buttonText}>{t('common_confirm')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  // Ranked like the request sheets: over every screen, under the password prompt and the alerts (MBL-04).
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8, 10, 20, 0.97)', zIndex: 9000, elevation: 20,
  },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 16 },
  card: {
    width: '100%', maxWidth: 520, alignSelf: 'center', backgroundColor: '#1a1a2e', borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  title: { color: '#00d4ff', fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  row: { marginBottom: 10 },
  rowLabel: { color: '#888888', fontSize: 12, marginBottom: 2 },
  // Addresses and amounts stay left-to-right in every language.
  mono: { color: '#ffffff', fontSize: 14, fontFamily: 'monospace', writingDirection: 'ltr', textAlign: 'left' },
  recipient: {
    color: '#ffffff', fontSize: 16, lineHeight: 24, fontFamily: 'monospace', writingDirection: 'ltr', textAlign: 'left',
    backgroundColor: '#11131f', borderRadius: 8, padding: 10,
  },
  hint: { color: '#888888', fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 4 },
  warning: { color: '#ffaa00', fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 6 },
  alert: { color: '#ff5555', fontSize: 13, lineHeight: 19, fontWeight: '600', marginTop: 6, marginBottom: 6 },
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

export const sendReviewStyles = s;
