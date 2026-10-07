/**
 * The Solana Send screen: SOL or a Solana token the wallet lists, from the wallet's Solana address, laid out like the
 * QNet Send screen. The token, the recipient and the amount are the wallet screen's state (a QR scan fills them in from
 * outside this form); the form checks nothing the network decides. Send runs runSolanaSend: the quote read now
 * (services/SolanaSend), the review of everything the send does (components/SendReview: token, amount, recipient,
 * network fee, the SOL a new token account takes, a request's memo, the total), the fresh check of whoever holds the
 * device that every send asks for (the recipient on the prompt), then the signature and the submit. The wallet screen
 * shows the outcome and lists the send in History until the network settles it (useSolanaSends).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import styles from './WalletScreen.styles';
import { ScanIcon } from '../components/QrScanSheet';
import { looksLikeKnownAddress } from '../browser/DappSheet';
import { errorText } from '../i18n';
import { decodeKey, fromBaseUnits, toBaseUnits, SOL_DECIMALS } from '../crypto/SolanaTx';
import {
  BASE_FEE_LAMPORTS, SOLANA_TOKENS, loadSolanaSends, maxSendable, quoteSolanaSend, recordSolanaSend, solanaSendStatus,
  solanaToken, submitSolanaSend, updateSolanaSend,
} from '../services/SolanaSend';

const solText = (lamports) => `${fromBaseUnits(BigInt(lamports), SOL_DECIMALS)} SOL`;

/**
 * One send, from the form's values to its outcome: { outcome: 'cancelled' } (the review or the fresh check declined),
 * { outcome: 'refused', error } (nothing was sent: the error carries its code), or { outcome: 'sent' | 'unknown',
 * entry } with the History entry of the submitted transfer ('unknown': no endpoint answered the submit, so it may or may
 * not have reached the network; its signature tells). `request` is a scanned payment request's { address, references,
 * memo }: it counts only while the recipient is still the address it was for.
 */
export async function runSolanaSend({
  t, from, to, symbol, amount, request = null, known = [], reviewSend, confirmFresh, sign,
  quote = quoteSolanaSend, submit = submitSolanaSend, now = Date.now,
}) {
  const recipient = String(to || '').trim();
  if (!decodeKey(recipient)) return { outcome: 'refused', error: { code: 'SOL_ADDRESS' } };
  const forRecipient = request && request.address === recipient ? request : null;
  let q;
  try {
    q = await quote({ from, to: recipient, symbol, amount, request: forRecipient });
  } catch (error) {
    return { outcome: 'refused', error };
  }
  const fee = BigInt(q.feeLamports);
  const rent = BigInt(q.rentLamports);
  // The warnings of the QNet review, from the recipients this wallet paid on Solana from this device.
  const lookAlike = looksLikeKnownAddress(recipient, known);
  const warnings = recipient === from || known.includes(recipient) ? {} : { firstTime: !lookAlike, lookAlike };
  const reviewed = await reviewSend({
    to: recipient,
    network: t('solana_devnet'),
    amount: `${q.amountText} ${q.symbol}`,
    fee: solText(fee),
    account: q.createDestination ? solText(rent) : null,
    memo: q.memo,
    total: q.mint ? `${q.amountText} ${q.symbol} + ${solText(fee + rent)}` : solText(BigInt(q.amountBase) + fee),
    warnings,
  });
  if (!reviewed) return { outcome: 'cancelled' };
  if (!(await confirmFresh(t('send_confirm_reason', { amount: `${q.amountText} ${q.symbol}` }), null, recipient))) {
    return { outcome: 'cancelled' };
  }
  let sent;
  try {
    sent = await submit(q, sign);
  } catch (error) {
    return { outcome: 'refused', error, submitted: true };
  }
  const entry = {
    signature: sent.signature, symbol: q.symbol, amount: q.amountText, to: recipient, fee: q.feeLamports,
    rent: q.rentLamports, status: 'pending', at: now(), lastValidBlockHeight: sent.lastValidBlockHeight,
  };
  return { outcome: sent.status === 'unknown' ? 'unknown' : 'sent', entry };
}

/**
 * This Solana address's sends made on this device, as History lists them, with each pending one asked about until the
 * network settles it: `onSettled(entry)` gets it as confirmed or failed (`expired`: its blockhash passed unrun).
 */
export function useSolanaSends(owner, onSettled) {
  const [sends, setSends] = useState([]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const reload = useCallback(async () => {
    const o = ownerRef.current;
    const list = await loadSolanaSends(o);
    if (ownerRef.current === o) setSends(list);
  }, []);

  useEffect(() => {
    setSends([]);
    if (owner) reload();
  }, [owner, reload]);

  const record = useCallback(async (entry) => {
    const o = ownerRef.current;
    if (!o || !entry) return;
    setSends((prev) => [entry, ...prev.filter((e) => e.signature !== entry.signature)]);
    const list = await recordSolanaSend(o, entry).catch(() => null);
    if (list && ownerRef.current === o) setSends(list);
  }, []);

  const pendingKey = sends.filter((e) => e.status === 'pending').map((e) => e.signature).join(',');
  useEffect(() => {
    if (!pendingKey || !owner) return undefined;
    let live = true;
    let timer = null;
    let ticks = 0;
    const tick = async () => {
      ticks += 1;
      const list = await loadSolanaSends(owner);
      for (const e of list.filter((x) => x.status === 'pending')) {
        let state;
        try {
          state = await solanaSendStatus(e.signature, e.lastValidBlockHeight);
        } catch (_) {
          continue; // unreachable now: asked again on the next tick
        }
        if (!live) return;
        if (state === 'pending') continue;
        const patch = state === 'confirmed' ? { status: 'confirmed' } : { status: 'failed', expired: state === 'expired' };
        const next = await updateSolanaSend(owner, e.signature, patch).catch(() => null);
        if (!live) return;
        if (next && ownerRef.current === owner) setSends(next);
        if (settledRef.current) settledRef.current({ ...e, ...patch });
      }
      if (live) timer = setTimeout(tick, ticks < 40 ? 3000 : 15000);
    };
    timer = setTimeout(tick, 2000);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [pendingKey, owner]);

  return { sends, record, reload };
}

// Digits and one decimal point, no more decimal places than the token has; a leading point gets its zero (".5" is 0.5).
export function cleanAmountInput(text, decimals) {
  let s = String(text || '').replace(/,/g, '.').replace(/[^0-9.]/g, '');
  if (s.startsWith('.')) s = `0${s}`;
  const dot = s.indexOf('.');
  if (dot >= 0) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '').slice(0, decimals)}`;
  return s.slice(0, 32);
}

/** The form. `balances`: the figures on the Assets list by symbol (null while unknown). */
export default function SolanaSendForm({
  t, rtl, owner, symbol, onSymbol, address, onAddress, amount, onAmount, request, balances, mask = (s) => s,
  backArrow, onBack, onScan, known, reviewSend, confirmFresh, sign, onResult, onSent,
}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const token = solanaToken(symbol) || SOLANA_TOKENS[0];
  const balance = balances ? balances[token.symbol] : null;

  let amountBase = null;
  try { amountBase = amount ? toBaseUnits(amount, token.decimals) : null; } catch (_) { amountBase = null; }
  const total = amountBase === null ? null
    : (token.mint ? `${fromBaseUnits(amountBase, token.decimals)} ${token.symbol} + ${solText(BASE_FEE_LAMPORTS)}`
      : solText(amountBase + BASE_FEE_LAMPORTS));

  const setMax = async () => {
    const max = await maxSendable(owner, token.symbol).catch(() => null);
    if (max !== null && alive.current) onAmount(max === '0' ? '' : max);
  };

  const send = async () => {
    if (busy || !address || !amount) return;
    Keyboard.dismiss();
    setBusy(true);
    try {
      const out = await runSolanaSend({
        t, from: owner, to: address, symbol: token.symbol, amount, request, known, reviewSend, confirmFresh, sign,
      });
      if (out.outcome === 'refused') {
        const code = out.error && out.error.code;
        onResult({
          success: false,
          title: t(out.submitted && code === 'SOL_REFUSED' ? 'tx_failed_title' : 'send_cannot_title'),
          error: errorText(t, out.error, 'tx_failed'),
        });
      } else if (out.outcome !== 'cancelled') {
        onSent(out.entry, out.outcome);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
      <ScrollView
        style={[styles.content, styles.subScreen]}
        contentContainerStyle={[styles.scrollContentContainer, styles.sendScreenContainer]}
        keyboardShouldPersistTaps="handled"
        testID="solana-send"
      >
        {/* One compact row: Back, the title centred, and a spacer as wide as Back. */}
        <View style={styles.sendScreenHeader}>
          <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityRole="button">
            <Text style={styles.backButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{`${backArrow} ${t('common_back')}`}</Text>
          </TouchableOpacity>
          <Text style={styles.sendScreenTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('send_title', { symbol: token.symbol })}</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* The token sent: SOL or a token the Assets list shows. */}
        <View style={styles.historyFilterRow} accessibilityRole="tablist">
          {SOLANA_TOKENS.map((tk) => (
            <TouchableOpacity
              key={tk.symbol}
              style={[styles.historyChip, tk.symbol === token.symbol && styles.historyChipActive]}
              onPress={() => onSymbol(tk.symbol)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tk.symbol === token.symbol }}
              testID={`solana-token-${tk.symbol}`}
            >
              <Text style={[styles.historyChipText, tk.symbol === token.symbol && styles.historyChipTextActive]}>{tk.symbol}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.sendBalanceInfo}>
          <Text style={styles.sendBalanceLabel}>{t('send_available')}</Text>
          <Text style={styles.sendBalanceAmount}>{mask(balance === null || balance === undefined ? '—' : String(balance))} {token.symbol}</Text>
        </View>

        {/* The recipient; the scan icon at the field's end reads a Solana address or a payment request from a QR code. */}
        <View style={styles.formGroup}>
          <Text style={styles.label}>{t('send_to_address')}</Text>
          <View style={styles.recipientField}>
            <TextInput
              style={[styles.input, styles.recipientInput, styles.recipientInputScan]}
              placeholder={t('send_placeholder_solana')}
              placeholderTextColor="#888"
              value={address}
              onChangeText={onAddress}
              autoCapitalize="none"
              autoCorrect={false}
              testID="solana-send-address"
            />
            <TouchableOpacity
              style={styles.scanButton}
              onPress={() => { Keyboard.dismiss(); onScan(); }}
              accessibilityRole="button"
              accessibilityLabel={t('scan_title_solana')}
              hitSlop={{ top: 8, bottom: 8, [rtl ? 'left' : 'right']: 8 }}
              testID="send-scan"
            >
              <ScanIcon color="#00d4ff" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>{t('send_amount')}</Text>
          <TextInput
            style={styles.input}
            placeholder="0.00"
            placeholderTextColor="#888"
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={(text) => onAmount(cleanAmountInput(text, token.decimals))}
            maxLength={32}
            testID="solana-send-amount"
          />
          <View style={styles.percentageButtons}>
            <TouchableOpacity style={styles.percentButton} onPress={setMax} accessibilityRole="button" testID="solana-send-max">
              <Text style={styles.percentButtonText}>{t('send_max')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* The fee of a one-signature transfer; the review shows the exact one the network charges. */}
        <View style={styles.sendFeeContainer}>
          <Text style={styles.sendFeeLabel}>{t('send_network_fee')}</Text>
          <Text style={styles.sendFeeValue}>{solText(BASE_FEE_LAMPORTS)}</Text>
        </View>

        {total ? (
          <View style={styles.sendTotalContainer}>
            <Text style={styles.sendTotalLabel}>{t('send_total')}</Text>
            <Text style={styles.sendTotalValue}>{total}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.button, (!address || !amount || busy) && styles.buttonDisabled]}
          onPress={send}
          disabled={!address || !amount || busy}
          accessibilityRole="button"
          testID="solana-send-button"
        >
          <Text style={styles.buttonText}>{busy ? t('sending') : t('send_button')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
