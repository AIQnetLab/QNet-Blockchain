import React from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { explorerTxUrl } from '../config/nodes';
import { tr } from '../i18n';
import styles from '../screens/WalletScreen.styles';

const shortMiddle = (s, head, tail) =>
  !s || s.length <= head + tail + 3 ? String(s || '') : `${s.slice(0, head)}...${s.slice(-tail)}`;

const ICON = {
  success: { box: 'txSuccessIcon', text: 'txSuccessIconText', glyph: '✓' },
  pending: { box: 'txPendingIcon', text: 'txPendingIconText', glyph: '⧗' },
  failed: { box: 'txErrorIcon', text: 'txErrorIconText', glyph: '✕' },
};

/**
 * The outcome of one submitted transaction — a send, a token transfer, a reward claim, an activation.
 * Callers pass the outcome, never a layout, so every flow reports itself the same way on the same
 * full-screen surface.
 *
 * Three outcomes, because a transaction really has three: it applied, it was refused, or nobody
 * answered and the chain has not decided yet. `pending` exists so an unanswered submit is never
 * reported as a refusal — it still shows its amount, since it may well have gone through.
 */
export default function TxResultCard({
  state = 'success', title, amount, symbol, counterparty, counterpartyLabel, note, hash, error,
  actionLabel, onAction, onCopied, explorer = true, t = tr,
}) {
  const icon = ICON[state] || ICON.failed;
  const failed = state === 'failed';
  const copy = () => {
    if (!hash) return;
    Clipboard.setString(hash);
    if (onCopied) onCopied();
  };
  // Opening can fail (no browser, blocked scheme); the hash is still worth keeping, so fall back to it. A transaction
  // of another network (a Solana send: `explorer` false) has no page in the QNet explorer, so a tap copies it.
  const open = () => {
    if (!hash) return;
    if (!explorer) { copy(); return; }
    Linking.openURL(explorerTxUrl(hash)).catch(copy);
  };

  return (
    <View style={styles.txResultContainer}>
      <View style={styles[icon.box]}>
        <Text style={styles[icon.text]}>{icon.glyph}</Text>
      </View>
      {title ? <Text style={styles.txResultTitle}>{title}</Text> : null}

      {!failed && amount !== undefined && amount !== null && amount !== '' ? (
        <Text style={[styles.txResultAmount, styles.ltr]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.3}>
          {amount}{symbol ? ` ${symbol}` : ''}
        </Text>
      ) : null}

      {counterparty ? (
        <Text style={styles.txResultTo}>{counterpartyLabel || t('tx_to')}: {shortMiddle(counterparty, 12, 8)}</Text>
      ) : null}

      {note ? <Text style={styles.txResultNote}>{note}</Text> : null}
      {failed && error ? <Text style={styles.txErrorMessage}>{String(error)}</Text> : null}

      {hash ? (
        <TouchableOpacity style={styles.txHashContainer} activeOpacity={0.7} onPress={open} onLongPress={copy}>
          <Text style={styles.txHashLabel}>{t('tx_label')}</Text>
          <Text style={[styles.txHashValue, styles.ltr]} numberOfLines={1}>{shortMiddle(hash, 20, 12)}</Text>
          <Text style={styles.txHashHint}>{t(explorer ? 'tx_hash_hint' : 'common_tap_to_copy')}</Text>
        </TouchableOpacity>
      ) : null}

      {onAction ? (
        <TouchableOpacity style={styles.txDoneButton} onPress={onAction}>
          <Text style={styles.txDoneButtonText}>{actionLabel || t('common_done')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
