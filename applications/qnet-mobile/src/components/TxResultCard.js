import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { tr } from '../i18n';
import { amountText } from '../utils/amountFormat';
import { masked } from '../utils/privacy';
import styles from '../screens/WalletScreen.styles';
import { BADGE_KEY } from '../screens/HistoryTab';
import { InfoField, InfoRow } from './InfoRow';
import Action from './ui/Action';
import Section from './ui/Section';
import Status from './ui/Status';

// The state at the top (components/ui/Status): the live dot while no block has taken it, settled in Mint as History's
// detail writes it, a move no block took in Ember. The words are History's.
const STATUS_TONE = Object.freeze({ pending: 'live', moving: 'live', confirmed: 'ok', failed: 'needs' });

/**
 * The outcome of one submitted transaction — a send, a token transfer, a move of a node balance — on one full screen,
 * in three parts: what happened (the chain's `status` in a word, the title, the amount, the note), one card of its
 * details (the fee, where it came from, whom it went to, the hash, the block), and the explorer and Done at the foot,
 * always in reach. Callers pass the outcome, never a layout, so every flow reports itself the same way.
 *
 * `state` is what the submit got: it applied, it was refused, or nobody answered and the chain has not decided yet.
 * `pending` exists so an unanswered submit is never reported as a refusal; it still shows its amount, since it may well
 * have gone through. A refusal's title, in Ember, says it alone. `status` ('pending' | 'moving' | 'confirmed' | 'failed')
 * follows the chain afterwards. The amount comes as a canonical figure and is shown as every screen writes amounts
 * (utils/amountFormat); the recipient and the hash are copied by a tap, as every value is (components/ui/Copyable).
 * `onExplorer(hash, 'qnet')` opens the hash's explorer page (the wallet screen's one handler); without it, no Explorer.
 * `hideAmounts`: the amount and the fee show masked, as History's detail shows them (utils/privacy). `parts`: how many
 * transactions a move in parts took so far (its amount what they put in the wallet, its hash and block those of the last
 * part that counts).
 */
export default function TxResultCard({
  state = 'success', status = null, title, amount, symbol, counterparty, counterpartyLabel, source, note, hash, fee, block,
  error, actionLabel, onAction, onExplorer = null, hideAmounts = false, parts = null, t = tr,
}) {
  const failed = state === 'failed';
  const tone = failed ? null : STATUS_TONE[status];
  const hasAmount = !failed && amount !== undefined && amount !== null && amount !== '';

  // Each field as every screen draws one (components/InfoRow), in the order of a transaction's detail screen
  // (screens/HistoryTab TxDetail): a word or a figure beside its label, the recipient whole on one line under it, the
  // hash shortened in its middle. A refused or expired transaction took no fee.
  const details = [];
  if (fee && !failed) {
    details.push(<InfoRow key="fee" label={t('tx_detail_fee')} value={masked(fee, hideAmounts)} ltr fit testID="tx-result-fee" />);
  }
  if (source) details.push(<InfoRow key="from" label={t('tx_detail_from')} value={source} />);
  if (Number.isSafeInteger(parts)) {
    details.push(<InfoRow key="parts" label={t('tx_detail_parts')} value={String(parts)} ltr fit testID="tx-result-parts" />);
  }
  if (counterparty) {
    details.push(
      <InfoField key="to" label={counterpartyLabel || t('tx_to')} value={counterparty} mono fit copy={counterparty} t={t}
        copyTestID="tx-result-to" />,
    );
  }
  if (hash) {
    details.push(<InfoField key="hash" label={t('tx_label')} value={hash} mono middle copy={hash} t={t} copyTestID="tx-result-hash" />);
  }
  if (Number.isSafeInteger(block)) {
    details.push(<InfoRow key="block" label={t('tx_detail_block')} value={String(block)} ltr fit testID="tx-result-block" />);
  }

  return (
    <View style={styles.txResultScreen} testID={`tx-result-${state}`}>
      <ScrollView style={styles.txResultScroll} contentContainerStyle={styles.txResultBody}>
        <View style={styles.txResultHead} testID="tx-result-head">
          {tone ? (
            <View style={styles.txResultStatus}>
              <Status tone={tone} label={t(BADGE_KEY[status])} testID={`tx-result-status-${status}`} />
            </View>
          ) : null}
          {title ? <Text style={[styles.txResultTitle, failed && styles.txResultTitleFailed]} accessibilityRole="header">{title}</Text> : null}
          {hasAmount ? (
            <Text style={[styles.txResultAmount, styles.ltr]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.3}
              testID="tx-result-amount">
              {masked(`${amountText(amount)}${symbol ? ` ${symbol}` : ''}`, hideAmounts)}
            </Text>
          ) : null}
          {note ? <Text style={styles.txResultNote}>{note}</Text> : null}
          {failed && error ? <Text style={styles.txResultError}>{String(error)}</Text> : null}
        </View>
        {details.length ? <Section testID="tx-result-details">{details}</Section> : null}
      </ScrollView>

      {/* Out of the scroll, so Done never moves off screen; the inset counts only where the foot meets the screen's edge
          (the bottom bar hidden). */}
      <SafeAreaView edges={['bottom']} style={styles.txResultFoot} testID="tx-result-actions">
        <View style={styles.txResultActions}>
          {hash && onExplorer ? (
            <Action kind="text" align="center" label={t('tx_detail_explorer')} onPress={() => onExplorer(hash, 'qnet')} testID="tx-result-explorer" />
          ) : null}
          {onAction ? <Action kind="solid" label={actionLabel || t('common_done')} onPress={onAction} testID="tx-result-done" /> : null}
        </View>
      </SafeAreaView>
    </View>
  );
}
