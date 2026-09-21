import React from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { explorerTxUrl } from '../config/nodes';
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
  state = 'success', title, amount, symbol, counterparty, counterpartyLabel = 'To', note, hash, error,
  actionLabel = 'Done', onAction, onCopied,
}) {
  const icon = ICON[state] || ICON.failed;
  const failed = state === 'failed';
  const copy = () => {
    if (!hash) return;
    Clipboard.setString(hash);
    if (onCopied) onCopied();
  };
  // Opening can fail (no browser, blocked scheme); the hash is still worth keeping, so fall back to it.
  const open = () => { if (hash) Linking.openURL(explorerTxUrl(hash)).catch(copy); };

  return (
    <View style={styles.txResultContainer}>
      <View style={styles[icon.box]}>
        <Text style={styles[icon.text]}>{icon.glyph}</Text>
      </View>
      {title ? <Text style={styles.txResultTitle}>{title}</Text> : null}

      {!failed && amount !== undefined && amount !== null && amount !== '' ? (
        <Text style={styles.txResultAmount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {amount}{symbol ? ` ${symbol}` : ''}
        </Text>
      ) : null}

      {counterparty ? (
        <Text style={styles.txResultTo}>{counterpartyLabel}: {shortMiddle(counterparty, 12, 8)}</Text>
      ) : null}

      {note ? <Text style={styles.txResultNote}>{note}</Text> : null}
      {failed && error ? <Text style={styles.txErrorMessage}>{String(error)}</Text> : null}

      {hash ? (
        <TouchableOpacity style={styles.txHashContainer} activeOpacity={0.7} onPress={open} onLongPress={copy}>
          <Text style={styles.txHashLabel}>Transaction</Text>
          <Text style={styles.txHashValue} numberOfLines={1}>{shortMiddle(hash, 20, 12)}</Text>
          <Text style={styles.txHashHint}>Tap to open in Explorer · hold to copy</Text>
        </TouchableOpacity>
      ) : null}

      {onAction ? (
        <TouchableOpacity style={styles.txDoneButton} onPress={onAction}>
          <Text style={styles.txDoneButtonText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
