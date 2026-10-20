import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { explorerTxUrl } from '../config/nodes';
import { tr } from '../i18n';
import { amountText } from '../utils/amountFormat';
import styles from '../screens/WalletScreen.styles';
import { InfoField } from './InfoRow';
import Action from './ui/Action';

/**
 * The outcome of one submitted transaction — a send, a token transfer, a reward claim, an activation.
 * Callers pass the outcome, never a layout, so every flow reports itself the same way on the same
 * full-screen surface.
 *
 * Three outcomes, because a transaction really has three: it applied, it was refused, or nobody
 * answered and the chain has not decided yet. `pending` exists so an unanswered submit is never
 * reported as a refusal — it still shows its amount, since it may well have gone through. The title says which, in
 * Ember for a refusal; the amount comes as a canonical figure and is shown as every screen writes amounts
 * (utils/amountFormat). The hash's Copy act answers Copied; a tap on the hash opens the explorer, a long press copies.
 */
export default function TxResultCard({
  state = 'success', title, amount, symbol, counterparty, counterpartyLabel, note, hash, error,
  actionLabel, onAction, explorer = true, t = tr,
}) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const failed = state === 'failed';
  const copy = () => {
    if (!hash) return;
    Clipboard.setString(hash);
    setCopied(true);
  };
  // Opening can fail (no browser, blocked scheme); the hash is still worth keeping, so fall back to it. A transaction
  // of another network (a Solana send: `explorer` false) has no page in the QNet explorer, so a tap copies it.
  const open = () => {
    if (!hash) return;
    if (!explorer) { copy(); return; }
    Linking.openURL(explorerTxUrl(hash)).catch(copy);
  };

  return (
    <View style={styles.txResultContainer} testID={`tx-result-${state}`}>
      {title ? <Text style={[styles.txResultTitle, failed && styles.txResultTitleFailed]} accessibilityRole="header">{title}</Text> : null}

      {!failed && amount !== undefined && amount !== null && amount !== '' ? (
        <Text style={[styles.txResultAmount, styles.ltr]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.3}>
          {amountText(amount)}{symbol ? ` ${symbol}` : ''}
        </Text>
      ) : null}

      {/* The recipient whole on one line under its label, and the hash shortened in its middle, as every screen shows
          them (components/InfoRow). */}
      {counterparty ? (
        <View style={styles.txResultTo}>
          <InfoField label={counterpartyLabel || t('tx_to')} value={counterparty} mono fit divider={false} t={t} />
        </View>
      ) : null}

      {note ? <Text style={styles.txResultNote}>{note}</Text> : null}
      {failed && error ? <Text style={styles.txErrorMessage}>{String(error)}</Text> : null}

      {hash ? (
        <View style={styles.txHashContainer}>
          <Pressable onPress={open} onLongPress={copy} accessibilityRole="button" accessibilityHint={t(explorer ? 'tx_hash_hint' : 'common_tap_to_copy')}>
            <InfoField label={t('tx_label')} value={hash} mono middle t={t} />
          </Pressable>
          <Action kind="act" label={copied ? t('common_copied') : t('common_copy')} labels={[t('common_copy'), t('common_copied')]}
            done={copied} onPress={copy} testID="tx-result-copy" />
          {explorer ? <Action kind="text" label={t('tx_detail_explorer')} onPress={open} testID="tx-result-explorer" /> : null}
        </View>
      ) : null}

      {onAction ? <Action kind="solid" label={actionLabel || t('common_done')} onPress={onAction} testID="tx-result-done" /> : null}
    </View>
  );
}
