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
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useArmedConfirm } from '../utils/useArmedConfirm';
import { SEND_ARM_MS } from '../browser/dappProvider';
import { looksLikeKnownAddress } from '../browser/DappSheet';
import { groupAddress } from '../utils/addressDisplay';
import { InfoField, InfoRow } from './InfoRow';
import { ActionPair } from './ui/Action';
import { color, layer, radius, size, space, themed } from '../theme';

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

  return (
    <SafeAreaView style={s.overlay} edges={['top', 'bottom', 'left', 'right']} testID="send-review" onTouchStart={onTouchStart}>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.card}>
          <Text style={s.title}>{t('send_review_title')}</Text>
          <InfoField label={t('send_review_to')} divider={false} t={t}>
            <Text style={s.recipient} testID="send-review-to">{groupAddress(review.to)}</Text>
          </InfoField>
          {/* Each figure beside its label (components/InfoRow); a total in two currencies takes a line for each. */}
          <InfoRow label={t('send_review_network')} value={review.network} />
          <InfoRow label={t('send_review_amount')} value={review.amount} ltr fit />
          <InfoRow label={t('send_review_fee')} value={review.fee} ltr fit />
          {review.account ? <InfoRow label={t('send_review_account')} value={review.account} ltr fit /> : null}
          {review.memo ? <InfoField label={t('send_review_memo')} value={review.memo} t={t} /> : null}
          <InfoRow label={t('send_review_total')} value={review.total} ltr fit total />
          {w.lookAlike ? <Text style={s.alert}>{t('dapp_send_lookalike')}</Text> : null}
          {w.incomingOnly ? <Text style={s.alert}>{t('dapp_send_incoming_only')}</Text> : null}
          {w.firstTime ? <Text style={s.warning}>{t('dapp_send_first_time')}</Text> : null}
          <Text style={s.hint}>{t('send_review_check')}</Text>
          <ActionPair
            style={s.actions}
            start={{ label: t('cancel'), onPress: onCancel }}
            end={{ label: t('common_confirm'), onPress: confirm, onPressIn, disabled: !armed, testID: 'send-review-confirm' }}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = themed((type) => ({
  // Ranked like the request sheets: over every screen, under the password prompt and the alerts (MBL-04).
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.ink, ...layer.request,
  },
  scroll: { flexGrow: 1, padding: space.gut },
  card: { width: '100%', maxWidth: size.request, alignSelf: 'center' },
  title: { ...type('title'), color: color.paper, marginBottom: space.s16 },
  // The whole recipient over the rows, under its label (components/InfoRow), left to right in groups: the one box, as
  // it is the thing being checked.
  recipient: {
    ...type('address'), color: color.paper, writingDirection: 'ltr',
    backgroundColor: color.fillField, borderWidth: 1, borderColor: color.edge, borderRadius: radius.box, padding: space.s12,
    marginTop: space.s8,
  },
  hint: { ...type('note'), color: color.fog, marginTop: space.s8, marginBottom: space.s4 },
  warning: { ...type('note'), color: color.ember, marginTop: space.s8, marginBottom: space.s8 },
  alert: { ...type('body'), color: color.ember, marginTop: space.s8, marginBottom: space.s8 },
  actions: { marginTop: space.s16 },
}));

export const sendReviewStyles = s;
