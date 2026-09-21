import React from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { explorerTxUrl } from '../config/nodes';
import styles from '../screens/WalletScreen.styles';

const shortMiddle = (s, head, tail) =>
  !s || s.length <= head + tail + 3 ? String(s || '') : `${s.slice(0, head)}...${s.slice(-tail)}`;

/**
 * The outcome of one submitted transaction — a send, a token transfer, a reward claim, an activation.
 * Callers pass the outcome, never a layout, so every flow reports success and failure the same way,
 * inline on the send screen or as the body of the alert modal. Inside the modal the title and the
 * button belong to the modal, so both props are left out there.
 */
export default function TxResultCard({
  ok, title, amount, symbol, counterparty, counterpartyLabel = 'To', note, hash, error,
  actionLabel = 'Done', onAction, onCopied,
}) {
  const copy = () => {
    if (!hash) return;
    Clipboard.setString(hash);
    if (onCopied) onCopied();
  };
  // Opening can fail (no browser, blocked scheme); the hash is still worth keeping, so fall back to it.
  const open = () => { if (hash) Linking.openURL(explorerTxUrl(hash)).catch(copy); };

  return (
    <View style={styles.txResultContainer}>
      <View style={ok ? styles.txSuccessIcon : styles.txErrorIcon}>
        <Text style={ok ? styles.txSuccessIconText : styles.txErrorIconText}>{ok ? '✓' : '✕'}</Text>
      </View>
      {title ? <Text style={styles.txResultTitle}>{title}</Text> : null}

      {ok && amount !== undefined && amount !== null && amount !== '' ? (
        <Text style={styles.txResultAmount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {amount}{symbol ? ` ${symbol}` : ''}
        </Text>
      ) : null}

      {counterparty ? (
        <Text style={styles.txResultTo}>{counterpartyLabel}: {shortMiddle(counterparty, 12, 8)}</Text>
      ) : null}

      {note ? <Text style={styles.txResultNote}>{note}</Text> : null}
      {!ok && error ? <Text style={styles.txErrorMessage}>{String(error)}</Text> : null}

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
