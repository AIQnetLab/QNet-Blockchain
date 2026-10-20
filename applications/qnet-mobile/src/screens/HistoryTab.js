/**
 * History: the wallet's transactions split by network exactly as Assets is (QNet · Solana), one row per transaction
 * under a header for its day (Today, Yesterday, then the date), and a detail screen for the row tapped. A row reads from
 * the start: what happened over whom it was with (and its status after it while it is not final), and at its end the
 * amount with its sign and tone: one line, two for a transaction with two legs (a swap), none for one that moves nothing
 * (a node registration). No icon and no badge: the title, the sign and the tone say what happened. A row holds at 320 dp
 * whatever the amount: the amount is written in the one amount format with few decimals and never cut; one too long to
 * sit beside the title takes a line of its own under it; only names (a token's symbol) may end in an ellipsis. The
 * detail screen shows every field the app holds for the transaction with its exact amount, and opens the explorer for a
 * transaction the network ran: the QNet explorer for a QNet one, the cluster's public explorer for a Solana one; one
 * still pending or not found has no page there, so its hash is copied.
 * Pure views: the wallet screen hands over the entries (utils/txHistory historyEntries and historySections), the
 * hidden-amounts flag and what a tap does.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { FIGURE_LINE, InfoField, InfoRow, ROW_FONT_CAP } from '../components/InfoRow';
import Action from '../components/ui/Action';
import Head from '../components/ui/Head';
import Status from '../components/ui/Status';
import TokenIcon from '../components/TokenIcons';
import { MONO_ADVANCE, color } from '../theme';
import { shortAddress } from '../utils/addressDisplay';
import { amountText, formatNano } from '../utils/amountFormat';
import { pad } from '../utils/timeText';
import { historyBadge, txNodeId, txTypeName } from '../utils/txHistory';
import { contractShortId, destroysTokens, tokenLabel, usesReservedName } from '../utils/tokenSafety';
import styles from './WalletScreen.styles';

// unverified: only the explorer archive lists it; included: received QNC in a block as two genesis nodes list it, not in
// the wallet's live figure yet (utils/txHistory historyBadge).
const BADGE_KEY = {
  pending: 'hist_status_pending', confirmed: 'hist_status_confirmed', failed: 'hist_status_failed', dropped: 'hist_status_dropped',
  moving: 'hist_status_moving', unverified: 'hist_status_unverified', included: 'hist_status_included',
};
// How a status word is toned (components/ui/Status): settled, on its way, or nothing moved.
const STATUS_TONE = {
  confirmed: 'done', pending: 'quiet', moving: 'quiet', unverified: 'quiet', included: 'quiet', failed: 'needs', dropped: 'needs',
};

// The sender of a node balance moved into the wallet (core is_merkle_reward_claim).
export const NODE_BALANCE_SENDER = 'system_rewards_pool';

/**
 * The words the detail screen writes for a sender that is the network itself rather than an account (M-2): the node
 * balance for a move of it into the wallet, Genesis for a genesis credit, "Network" for "system" and any other system_
 * id. null for an account, which is shown and copied as it is. Such an id is never shown, read out or copied raw.
 */
export function systemSenderKey(tx, kind = txKind(tx)) {
  const from = typeof tx.from === 'string' ? tx.from : '';
  if (kind === 'node_claim' || from === NODE_BALANCE_SENDER) return 'tx_detail_from_node_balance';
  if (from === 'genesis') return 'hist_genesis';
  if (/^system(_|$)/i.test(from)) return 'tx_detail_from_network';
  return null;
}

// The amount's tone: incoming in Mint, outgoing and a transfer to this same wallet in Paper, Fog for one that did not
// go through (nothing moved).
const TONE = { in: color.mint, self: color.paper, out: color.paper, void: color.fog };

const trimZeros = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// A plain decimal string of a non-negative amount: a decimal text as it is, a number as its shortest digits (the way it
// prints), its exponent written out ("3.4e+32" is 34 and 31 zeros).
function decimalOf(value) {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return value;
  const text = String(Math.abs(Number(value) || 0));
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const digits = m[1] + (m[2] || '');
  const point = m[1].length + Number(m[3]);
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${'0'.repeat(-point)}${digits}`;
}

/**
 * An amount as a row shows it, in the one amount format (utils/amountFormat), never with a suffix or an exponent: below
 * 100,000 with at most 8 decimals below 1 (a dust amount reads "<0.00000001"), 4 from 1 and 2 from 1,000 (98,765.43);
 * up to a million with at most 2 decimals (123,456.78); from a million the whole number, rounded (12,345,679). The
 * detail screen shows the exact figure.
 */
export function compactAmount(value) {
  const text = decimalOf(value);
  const n = Number(text);
  if (n === 0) return '0';
  if (n < 1e-8) return `<${amountText('0.00000001')}`;
  if (n < 1e6) return amountText(trimZeros(n.toFixed(n >= 1000 ? 2 : (n >= 1 ? 4 : 8))));
  const [whole, fraction = ''] = text.split('.');
  return amountText((BigInt(whole) + (fraction[0] >= '5' ? 1n : 0n)).toString());
}

// A token amount as the history keeps it (utils/txHistory tokenAmountDisplay: grouped with ',') as a canonical decimal.
const keptDecimal = (text) => String(text == null ? '0' : text).replace(/,/g, '');

/** A decimal string (a token amount as the history keeps it, any precision) written as compactAmount writes it. */
export function compactDecimalText(text) {
  const kept = keptDecimal(text);
  return /^\d+(\.\d+)?$/.test(kept) ? compactAmount(kept) : String(text);
}

/** An NFT's token id on a row: whole when short, else its start and end. */
const tokenIdShort = (id) => {
  const s = String(id == null ? '?' : id);
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

/** A node's name on a row: whole up to 20 characters (light_9f3a2c1d0e7b), else its start and end. */
const shortNodeId = (id) => {
  const s = typeof id === 'string' ? id : '';
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s;
};

/** A moment as the history writes it: dd.mm.yyyy, hh:mm (the Assets line of when the figures were read, too). */
export const dateTime = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const hasTime = (ms) => Number(ms) >= 1000000;

/**
 * A day header's words: Today, Yesterday, Earlier (rows without a real time), or the date as the app's language writes
 * it (the phone's language unless another was chosen), with the year only when it is not this year's.
 */
export function dayLabel(item, t, nowMs = Date.now()) {
  if (item.day === 'today') return t('hist_today');
  if (item.day === 'yesterday') return t('hist_yesterday');
  if (item.day === 'earlier' || !hasTime(item.at)) return t('hist_earlier');
  const d = new Date(item.at);
  const options = d.getFullYear() === new Date(nowMs).getFullYear()
    ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' };
  try {
    return d.toLocaleDateString(t.lang || undefined, options);
  } catch (_) {
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
}

/**
 * What a row records: 'send', 'receive', 'self' (to this same wallet), 'burn', 'swap' (one transaction paying one asset
 * and receiving another, or the chain's own swap), 'node_registered' (a registration, or the activation transaction
 * of older blocks that brought a node in the same way: the app speaks of registering a node), 'node_back_online',
 * 'node_checkin', 'node_claim' (the node balance moved into this wallet), 'contract_call' or 'contract_deploy'. The
 * transaction's type decides first (either source names it), the direction of a plain transfer after.
 */
export function txKind(tx) {
  if (tx.nodeEvent || tx.nodeRegistration) return 'node_registered';
  // Only legs that move something decide: a contract call's own 0 QNC row beside the token it paid is no leg of a swap.
  const legs = (Array.isArray(tx.legs) ? tx.legs : []).filter((l) => l.tokenContract || l.chain === 'solana' || Number(l.amount) > 0);
  if (legs.some((l) => l.type === 'send') && legs.some((l) => l.type === 'receive')) return 'swap';
  if (tx.chain !== 'solana' && !tx.tokenContract) {
    const name = txTypeName(tx.txType);
    if (name === 'NodeRegistration' || name === 'NodeActivation' || name === 'BatchNodeActivations') return 'node_registered';
    if (name === 'NodeReactivation') return 'node_back_online';
    if (name === 'Heartbeat' || name === 'HeartbeatCommitment') return 'node_checkin';
    if (name === 'RewardDistribution' || tx.from === NODE_BALANCE_SENDER) return 'node_claim';
    if (name === 'ContractCall') return 'contract_call';
    if (name === 'ContractDeploy') return 'contract_deploy';
    if (name === 'Swap') return 'swap';
  }
  if (tx.tokenKind === 'burn' || destroysTokens(tx.to)) return 'burn';
  if (tx.type === 'self') return 'self';
  return tx.type === 'send' ? 'send' : 'receive';
}

// What each kind is called, its group (a node or a contract action), and whether it moves value (a transfer shows its
// amount even at 0; a node or contract action shows one only when it carried value).
const KINDS = {
  send: { title: 'hist_sent', transfer: true },
  receive: { title: 'hist_received', transfer: true },
  self: { title: 'hist_sent_self', transfer: true },
  burn: { title: 'hist_burn', transfer: true },
  swap: { title: 'hist_swap', transfer: true },
  node_registered: { title: 'hist_node_registered', group: 'node' },
  node_back_online: { title: 'hist_node_back_online', group: 'node' },
  node_checkin: { title: 'hist_node_checkin', group: 'node' },
  node_claim: { title: 'hist_node_claim', group: 'node', transfer: true },
  contract_call: { title: 'hist_contract_call', group: 'contract' },
  contract_deploy: { title: 'hist_contract_deploy', group: 'contract' },
};

/**
 * One value row's amount: its number for the row and exact figure for the detail screen (each with its sign), its
 * symbol, colour and token warning, and whether it is zero. One place, so the row and the detail screen never disagree.
 */
function legOf(tx, settled) {
  const isSelf = tx.type === 'self';
  const isSend = tx.type === 'send';
  const isSolana = tx.chain === 'solana';
  const isToken = !!tx.tokenContract;
  const isNft = tx.tokenStd === 'qrc721';
  // The minus sign (U+2212), as the extension writes it: as wide as the plus, and read as "minus".
  const sign = isSelf ? '' : (isSend ? '−' : '+');
  const tone = !settled ? TONE.void : (isSelf ? TONE.self : (isSend ? TONE.out : TONE.in));
  // A token the wallet did not add is named by its contract id next to whatever symbol its deployer chose, and one named
  // after QNet is marked as not QNC, as on the Assets list (MOBNET-R3-08). Its symbol is written through tokenLabel, so
  // no hidden or format character in it can reorder what is shown (M-5).
  const tokenSymbol = tokenLabel(tx.tokenSymbol);
  const symbol = isSolana ? tx.solSymbol
    : isToken ? (tokenSymbol
      ? (tx.tokenMetaTrusted ? tokenSymbol : `${tokenSymbol} (${contractShortId(tx.tokenContract)})`)
      : contractShortId(tx.tokenContract))
      : 'QNC';
  const reserved = isToken && usesReservedName(tx.tokenSymbol, '');
  let number;
  let exact;
  if (isSolana) {
    number = compactDecimalText(tx.solAmount);
    exact = amountText(String(tx.solAmount));
  } else if (isNft) {
    number = `#${tokenIdShort(tx.tokenId)}`;
    exact = `#${tx.tokenId == null ? '?' : tx.tokenId}`;
  } else if (isToken) {
    number = compactDecimalText(tx.tokenAmountDisplay || '0');
    exact = amountText(keptDecimal(tx.tokenAmountDisplay || '0'));
  } else {
    number = compactAmount(tx.amount);
    // The exact figure from the row's nanoQNC text; through the float only for a row that carries none (a pending send).
    const nano = typeof tx.amountNano === 'string' && /^\d+$/.test(tx.amountNano) ? tx.amountNano : null;
    exact = amountText(nano ? formatNano(nano) : trimZeros((Number(tx.amount) || 0).toFixed(9)));
  }
  const zero = !isNft && Number(keptDecimal(isSolana ? tx.solAmount : (isToken ? tx.tokenAmountDisplay : tx.amount))) === 0;
  // A symbol named after QNet is written in Ember (the detail screen says why).
  // The icon the row wears: a known one only for a network's own asset (components/TokenIcons knownIcon).
  const icon = { network: isSolana ? 'solana' : 'qnet', symbol: isSolana ? tx.solSymbol : (isToken ? tokenSymbol : 'QNC'), contract: isToken ? tx.tokenContract : null };
  return {
    icon, tone, reserved, zero, incoming: !isSend && !isSelf, symbol, symbolTone: reserved ? color.ember : tone,
    number: zero ? '0' : `${sign}${number}`, exact: zero ? '0' : `${sign}${exact}`,
  };
}

/**
 * What a row and its detail say about one history entry (a row of utils/txHistory historyEntries): its kind, title,
 * status, the line of whom it was with (`sub`, a key and its params), its amounts (`legs`: none, one, or a swap's two,
 * incoming first), the fee and the token warning.
 */
export function describeTx(tx) {
  const kind = txKind(tx);
  const spec = KINDS[kind];
  // A move of a node balance in transit (services/ClaimTransit withMoveStates) says so until the wallet holds it.
  const status = tx.nodeEvent ? 'confirmed' : (tx.moving ? 'moving' : historyBadge(tx));
  const settled = status !== 'failed' && status !== 'dropped';
  const rows = Array.isArray(tx.legs) && tx.legs.length > 1 ? tx.legs : [tx];
  // A single transfer shows its amount even at 0; a node or contract action, and a leg among several, only when not 0.
  const legs = tx.nodeEvent || tx.nodeRegistration ? [] : rows.map((r) => legOf(r, settled))
    .filter((l) => (spec.transfer && rows.length === 1) || !l.zero)
    .sort((a, b) => Number(b.incoming) - Number(a.incoming));
  let sub = null;
  const nodeId = tx.nodeId || txNodeId(tx.txType);
  // A swap names no one: its two legs say what went and what came.
  if (kind === 'swap') sub = null;
  else if (kind === 'node_claim') sub = { key: 'hist_sub_node_balance' };
  else if (spec.group === 'node') sub = nodeId ? { key: 'hist_sub_node', params: { id: shortNodeId(nodeId) } } : null;
  else if (spec.group === 'contract') sub = tx.to ? { key: 'tok_contract_id', params: { id: contractShortId(tx.to) } } : null;
  // A transfer to this same wallet names no one (its title says it), as the extension's row.
  else if (kind === 'self') sub = null;
  else if (tx.type === 'send' || tx.type === 'self') sub = tx.to ? { key: 'hist_to', params: { who: shortAddress(tx.to) } } : null;
  // A sender that is the network itself is named in words, as on the detail screen, never by its id.
  else if (systemSenderKey(tx, kind)) sub = { key: systemSenderKey(tx, kind) };
  else sub = tx.from ? { key: 'hist_from', params: { who: shortAddress(tx.from) } } : null;
  const height = Number.isSafeInteger(tx.block) ? tx.block : (Number.isSafeInteger(tx.height) ? tx.height : null);
  if (!sub && kind !== 'self' && kind !== 'swap' && height !== null) sub = { key: 'hist_block', params: { height } };
  const fee = tx.chain === 'solana' ? (tx.solFee != null ? `${amountText(String(tx.solFee))} SOL` : null)
    : (tx.fee > 0 ? `${amountText(trimZeros((Number(tx.fee) || 0).toFixed(9)))} QNC` : null);
  return {
    kind, title: spec.title, status, legs, sub, fee,
    node: spec.group === 'node', isSolana: tx.chain === 'solana', reserved: legs.some((l) => l.reserved),
  };
}

/** The line of whom a row was with, in words. */
const subText = (sub, t) => (!sub ? '' : t(sub.key, sub.params));

// The most characters a row's number and symbol share one line with (−98,765.43 QNC); a longer pair is stacked.
const STACK_CHARS = 13;
// The longest number that sits beside the title: 45% of the narrowest row (288 dp) holds this many mono characters at
// the largest text size a row follows; a longer one takes a line of its own under the title.
export const BESIDE_CHARS = Math.floor((0.45 * 288) / (MONO_ADVANCE.data * 15 * ROW_FONT_CAP));

/**
 * What a screen reader says for a row, in the extension's order: what happened, the amounts (unless hidden), whom with,
 * its status and when.
 */
export function rowA11yLabel(d, tx, t, hideAmounts) {
  const parts = [t(d.title)];
  if (!hideAmounts) for (const l of d.legs) parts.push(`${l.number} ${l.symbol}`);
  const sub = subText(d.sub, t);
  if (sub) parts.push(sub);
  if (d.status !== 'confirmed') parts.push(t(BADGE_KEY[d.status]));
  if (hasTime(tx.timestamp)) parts.push(dateTime(tx.timestamp));
  return parts.join(', ');
}

/** A day's header above its rows. */
export function DayHeader({ item, t }) {
  return (
    <Text style={styles.histDay} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} accessibilityRole="header" testID="history-day">
      {dayLabel(item, t)}
    </Text>
  );
}

/**
 * One transaction: what happened over whom it was with (and its status after it while it is not final), and its
 * amounts at the row's end, or on a line of their own under it when a number is too long to sit beside. The amount's
 * number never ends in an ellipsis; its symbol, a name, may. Tapping opens the detail screen.
 */
export const HistoryRow = React.memo(function HistoryRow({ tx, t, hideAmounts, onOpen }) {
  const d = describeTx(tx);
  const sub = subText(d.sub, t);
  const showStatus = d.status !== 'confirmed';
  const wide = !hideAmounts && d.legs.some((l) => l.number.length > BESIDE_CHARS);
  const amounts = d.legs.length ? (
    <View style={wide ? styles.histWide : styles.histRight}>
      {d.legs.slice(0, 2).map((leg, i) => {
        // A single amount too long to share its line with its symbol (a long symbol, a dust amount) puts the symbol
        // under the number, so the amount never takes the room of whom it was with.
        const stacked = !wide && d.legs.length === 1 && !hideAmounts && leg.number.length + leg.symbol.length > STACK_CHARS;
        return (
          <View key={i} style={[stacked ? styles.histAmountStack : styles.histAmountLine, i > 0 && styles.histAmountLineNext]}>
            <Text
              style={[styles.histAmount, wide && styles.histAmountWide, { color: leg.tone }]}
              {...(wide ? FIGURE_LINE : { numberOfLines: 1, maxFontSizeMultiplier: ROW_FONT_CAP })}
            >
              {hideAmounts ? '••••' : leg.number}
            </Text>
            {hideAmounts ? null : (
              <Text style={[stacked ? styles.histSymbolStacked : styles.histSymbol, { color: leg.symbolTone }]} numberOfLines={1} ellipsizeMode="tail">
                {stacked ? leg.symbol : ` ${leg.symbol}`}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  ) : null;
  return (
    <Pressable
      style={({ pressed }) => [styles.histRow, pressed && styles.histRowPressed]}
      onPress={() => onOpen(tx)}
      accessibilityRole="button"
      accessibilityLabel={rowA11yLabel(d, tx, t, hideAmounts)}
      testID="history-row"
    >
      <View style={styles.histLine}>
        {d.legs.length ? <TokenIcon {...d.legs[0].icon} size={30} style={styles.histIcon} /> : <View style={styles.histIconBlank} />}
        <View style={styles.histMiddle}>
          {/* What happened shrinks a little to fit beside the amount rather than wrap, never below 80% of its size. */}
          <Text style={styles.histTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{t(d.title)}</Text>
          {/* Whom it was with on one line, and after it the status of a row not final; the status goes under it when
              both do not fit, never over it. */}
          {sub || showStatus ? (
            <View style={styles.histSubLine}>
              {sub ? <Text style={[styles.histSub, styles.histParty]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{sub}</Text> : null}
              {showStatus ? (
                <Text style={[styles.histSub, styles.histStatus, styles[`histStatus_${d.status}`]]} numberOfLines={1} testID={`history-badge-${d.status}`}>
                  {t(BADGE_KEY[d.status])}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        {wide ? null : amounts}
      </View>
      {wide ? amounts : null}
    </Pressable>
  );
});

/**
 * The detail screen of one row: what happened, the exact amounts, the status in a word, the fee, both parties
 * (a sender that is the network itself in words: systemSenderKey), the node (a node row), the time, the hash, the
 * block, the memo when the app holds one, and one action: the explorer's
 * page of a transaction the network ran (QNet's for a QNet one in a block, the Solana cluster's for a Solana one that
 * ran), or copying the hash (one still pending or not found, a Solana send that expired unrun). A node event the
 * registry alone reports has no transaction hash, so neither. `onBack` closes it; `onCopy(text, key)` copies;
 * `onExplorer(hash, chain)` opens the explorer of 'qnet' or 'solana'; `copied` names the field copied last.
 */
export function TxDetail({ tx, t, hideAmounts = false, onBack, onCopy, onExplorer, copied = '' }) {
  const d = describeTx(tx);
  const badge = d.status;
  // Each field as every screen draws one (components/InfoRow): a figure, a time or a word beside its label; an id or an
  // address whole on one line under it, a hash shortened in its middle, each copied whole on a tap; a memo wrapping.
  const copyable = (key, label, value, more = {}) => (
    <InfoField key={key} t={t} label={label} value={value} mono fit onCopy={() => onCopy(value, `detail-${key}`)}
      copied={copied === `detail-${key}`} {...more} />
  );
  const fields = [];
  if (d.node && (tx.nodeTypeTitle || tx.nodeType)) {
    fields.push(<InfoRow key="type" label={t('node_type')} value={tx.nodeTypeTitle || String(tx.nodeType || '')} />);
  }
  if (d.node && tx.nodeId) fields.push(copyable('node', t('node_name'), tx.nodeId));
  if (d.fee) fields.push(<InfoRow key="fee" label={t('tx_detail_fee')} value={hideAmounts ? '••••' : d.fee} ltr fit />);
  if (!tx.nodeEvent) {
    const system = systemSenderKey(tx, d.kind);
    if (system) fields.push(<InfoRow key="from" label={t('tx_detail_from')} value={t(system)} />);
    else if (tx.from) fields.push(copyable('from', t('tx_detail_from'), tx.from));
    if (tx.to) fields.push(copyable('to', t('tx_detail_to'), tx.to));
  }
  if (hasTime(tx.timestamp)) fields.push(<InfoRow key="time" label={t('tx_detail_time')} value={dateTime(tx.timestamp)} ltr />);
  if (tx.hash && !tx.nodeEvent) fields.push(copyable('hash', t('tx_label'), tx.hash, { fit: false, middle: true }));
  const block = Number.isSafeInteger(tx.block) ? tx.block : (d.node && Number.isSafeInteger(tx.height) ? tx.height : null);
  if (block !== null) fields.push(<InfoRow key="block" label={t('tx_detail_block')} value={String(block)} ltr fit />);
  if (Number.isSafeInteger(tx.slot)) fields.push(<InfoRow key="slot" label={t('tx_detail_slot')} value={String(tx.slot)} ltr fit />);
  if (typeof tx.memo === 'string' && tx.memo) fields.push(<InfoField key="memo" t={t} label={t('tx_detail_memo')} value={tx.memo} />);
  if (d.reserved) fields.push(<Text key="reserved" style={styles.txDetailWarning}>{t('tok_reserved_warning')}</Text>);
  // A transaction no source reported (not found) has no explorer page either: its hash is copied instead. A Solana send
  // that expired unrun (no fee charged) never reached the cluster's ledger, so it has none either.
  const chain = d.isSolana ? 'solana' : 'qnet';
  const ran = !d.isSolana || badge === 'confirmed' || (badge === 'failed' && tx.solFee != null);
  const hash = tx.nodeEvent ? null : tx.hash;
  const explorer = ran && badge !== 'pending' && badge !== 'dropped' && !!hash;
  return (
    <View>
      <Head onBack={onBack} backLabel={t('common_back')} backTestID="tx-detail-back" title={t(d.title)} />
      {d.legs.map((leg, i) => (
        <View key={i} style={styles.txDetailLeg}>
          <TokenIcon {...leg.icon} size={32} />
          <Text style={[styles.txDetailAmount, styles.txDetailLegText, { color: leg.tone }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.3}>
            {hideAmounts ? '••••' : `${leg.exact} ${leg.symbol}`}
          </Text>
        </View>
      ))}
      <Status tone={STATUS_TONE[badge] || 'quiet'} label={t(BADGE_KEY[badge])} testID={`tx-detail-badge-${badge}`} textStyle={styles.txDetailBadge} />
      <View style={styles.txDetailCard}>{fields}</View>
      {explorer ? (
        <Action kind="text" label={t('tx_detail_explorer')} onPress={() => onExplorer(hash, chain)} testID="tx-detail-explorer" />
      ) : hash ? (
        <Action kind="text" label={t('tx_detail_copy_hash')} onPress={() => onCopy(hash, 'detail-hash')} testID="tx-detail-copy" />
      ) : null}
    </View>
  );
}
