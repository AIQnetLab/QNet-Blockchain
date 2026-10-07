/**
 * History (owner, 04.10; rows redrawn 06.10): the wallet's transactions split by network exactly as Assets is (QNet ·
 * Solana), one row per transaction under a header for its day (Today, Yesterday, then the date), and a detail screen for
 * the row tapped. A row reads from the start: the asset's icon with a small badge for what happened (sent, received,
 * swap, a node action, a contract call, burn, failed), what happened over whom it was with (and its status after it
 * while it is not final), and the amount with its sign and colour: one line, two for a transaction with two legs (a swap), none
 * for one that moves nothing (a node registration). A row holds at 320 dp whatever the amount: the amount is written
 * compactly (K, M, B, T past 100,000; at most a few decimals) and never cut, and only names (a token's symbol) may end in
 * an ellipsis. The detail screen opens with the same icon and badge, shows every field the app holds for the
 * transaction with its exact amount, and opens the explorer for a transaction the network ran: the QNet explorer for a
 * QNet one, the cluster's public explorer for a Solana one; one still pending or not found has no page there, so its
 * hash is copied.
 * Pure views: the wallet screen hands over the entries (utils/txHistory historyEntries and historySections), the
 * hidden-amounts flag and what a tap does.
 */
import React from 'react';
import { Image, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { tokenIconSource } from '../components/TokenIcons';
import { historyBadge, txNodeId, txTypeName } from '../utils/txHistory';
import { contractShortId, destroysTokens, tokenLabel, usesReservedName } from '../utils/tokenSafety';
import styles from './WalletScreen.styles';

const BADGE_KEY = {
  pending: 'hist_status_pending', confirmed: 'hist_status_confirmed', failed: 'hist_status_failed', dropped: 'hist_status_dropped',
};
const SUFFIXES = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
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

// The amount's colour: incoming green, a transfer to this same wallet the app's blue, outgoing plain white, and grey for
// one that did not go through (nothing moved).
const TONE = { in: '#00ff88', self: '#00d4ff', out: '#ffffff', void: '#8a8fa3' };

const trimZeros = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * An amount as a row shows it: below 100,000 grouped, with at most 8 decimals below 1 (a dust amount reads
 * "<0.00000001"), 4 from 1 and 2 from 1,000 (98,765.43); from 100,000 with a suffix and at most 2 decimals (123.46K,
 * 1.5M, 4200T); from 10^18 (a token of 128-bit supply) in powers of ten (3.4e32). Never longer than 11 characters
 * before its sign, so a short symbol after it stays whole at 320 dp; the detail screen shows the exact figure. The
 * extension's History writes its rows by the same rule (popup.js compactAmount).
 */
export function compactAmount(value) {
  const n = Math.abs(Number(value) || 0);
  if (n === 0) return '0';
  if (n < 1e-8) return '<0.00000001';
  if (n >= 1e18) {
    const [mantissa, exponent] = n.toExponential(2).split('e');
    return `${trimZeros(mantissa)}e${Number(exponent)}`;
  }
  if (n >= 1e5) {
    for (const [unit, suffix] of SUFFIXES) {
      if (n >= unit) {
        const scaled = n / unit;
        return `${trimZeros(scaled.toFixed(scaled >= 1000 ? 0 : 2))}${suffix}`;
      }
    }
  }
  const text = trimZeros(n.toFixed(n >= 1000 ? 2 : (n >= 1 ? 4 : 8)));
  const [int, frac] = text.split('.');
  return frac ? `${group(int)}.${frac}` : group(int);
}

/** A decimal string (a token amount with thousands separators, any precision) written as compactAmount writes it. */
export function compactDecimalText(text) {
  const n = Number(String(text == null ? '0' : text).replace(/,/g, ''));
  return Number.isFinite(n) ? compactAmount(n) : String(text);
}

/** An NFT's token id on a row: whole when short, else its start and end. */
const tokenIdShort = (id) => {
  const s = String(id == null ? '?' : id);
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

/** An address on a row: its first and last four characters ("02dc…23e"), whole when that is no shorter. */
export const shortAddress = (a) => {
  const s = typeof a === 'string' ? a : '';
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};
/** A node's name on a row: whole up to 20 characters (light_9f3a2c1d0e7b), else its start and end. */
const shortNodeId = (id) => {
  const s = typeof id === 'string' ? id : '';
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s;
};

const pad = (n) => String(n).padStart(2, '0');
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

// What each kind is called, the badge its icon carries, and whether it moves value (a transfer shows its amount even at
// 0; a node or contract action shows one only when it carried value).
const KINDS = {
  send: { title: 'hist_sent', badge: 'sent', transfer: true },
  receive: { title: 'hist_received', badge: 'received', transfer: true },
  self: { title: 'hist_sent_self', badge: 'self', transfer: true },
  burn: { title: 'hist_burn', badge: 'burn', transfer: true },
  swap: { title: 'hist_swap', badge: 'swap', transfer: true },
  node_registered: { title: 'hist_node_registered', badge: 'node' },
  node_back_online: { title: 'hist_node_back_online', badge: 'node' },
  node_checkin: { title: 'hist_node_checkin', badge: 'node' },
  node_claim: { title: 'hist_node_claim', badge: 'node', transfer: true },
  contract_call: { title: 'hist_contract_call', badge: 'contract' },
  contract_deploy: { title: 'hist_contract_deploy', badge: 'contract' },
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
    exact = String(tx.solAmount);
  } else if (isNft) {
    number = `#${tokenIdShort(tx.tokenId)}`;
    exact = `#${tx.tokenId == null ? '?' : tx.tokenId}`;
  } else if (isToken) {
    number = compactDecimalText(tx.tokenAmountDisplay || '0');
    exact = tx.tokenAmountDisplay || '0';
  } else {
    number = compactAmount(tx.amount);
    exact = (Number(tx.amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 9 });
  }
  const zero = !isNft && Number(String(isSolana ? tx.solAmount : (isToken ? tx.tokenAmountDisplay : tx.amount) || 0).replace(/,/g, '')) === 0;
  return {
    tone, reserved, zero, incoming: !isSend && !isSelf,
    symbol: reserved ? `⚠ ${symbol}` : symbol,
    number: zero ? '0' : `${sign}${number}`, exact: zero ? '0' : `${sign}${exact}`,
  };
}

// The icon of the asset a row moved: its own image (QNC, SOL, 1DEV, the icons Assets draws), else a token's letter. The
// app's mark sits inside a clear margin of its image (its disc is 70% of it), so a row draws it enlarged to fill the
// same round as every other asset's icon.
const QNC_ZOOM = 1.4;
const iconOf = (tx) => {
  if (tx.chain === 'solana') return { source: tokenIconSource(tx.solSymbol), letter: String(tx.solSymbol || 'S').slice(0, 1) };
  if (tx.tokenContract) return { source: null, letter: (tokenLabel(tx.tokenSymbol) || 'T').slice(0, 1).toUpperCase(), seed: tx.tokenContract, logo: tx.tokenLogo };
  return { source: tokenIconSource('QNC'), letter: 'Q', zoom: QNC_ZOOM };
};

/**
 * What a row and its detail say about one history entry (a row of utils/txHistory historyEntries): its kind, title,
 * badge, status, the line of whom it was with (`sub`, a key and its params, or plain text), its amounts (`legs`: none,
 * one, or a swap's two, incoming first), the icon, the fee and the token warning.
 */
export function describeTx(tx) {
  const kind = txKind(tx);
  const spec = KINDS[kind];
  const status = tx.nodeEvent ? 'confirmed' : historyBadge(tx);
  const settled = status !== 'failed' && status !== 'dropped';
  const rows = Array.isArray(tx.legs) && tx.legs.length > 1 ? tx.legs : [tx];
  // A single transfer shows its amount even at 0; a node or contract action, and a leg among several, only when not 0.
  const legs = tx.nodeEvent || tx.nodeRegistration ? [] : rows.map((r) => legOf(r, settled))
    .filter((l) => (spec.transfer && rows.length === 1) || !l.zero)
    .sort((a, b) => Number(b.incoming) - Number(a.incoming));
  let sub = null;
  const nodeId = tx.nodeId || txNodeId(tx.txType);
  if (kind === 'swap' && legs.length > 1) sub = { text: `${legs[legs.length - 1].symbol} → ${legs[0].symbol}` };
  else if (kind === 'node_claim') sub = { key: 'hist_sub_node_balance' };
  else if (spec.badge === 'node') sub = nodeId ? { key: 'hist_sub_node', params: { id: shortNodeId(nodeId) } } : null;
  else if (spec.badge === 'contract') sub = tx.to ? { key: 'tok_contract_id', params: { id: contractShortId(tx.to) } } : null;
  // A transfer to this same wallet names no one (its title says it), as the extension's row.
  else if (kind === 'self') sub = null;
  else if (tx.type === 'send' || tx.type === 'self') sub = tx.to ? { key: 'hist_to', params: { who: shortAddress(tx.to) } } : null;
  // A sender that is the network itself is named in words, as on the detail screen, never by its id.
  else if (systemSenderKey(tx, kind)) sub = { key: systemSenderKey(tx, kind) };
  else sub = tx.from ? { key: 'hist_from', params: { who: shortAddress(tx.from) } } : null;
  const height = Number.isSafeInteger(tx.block) ? tx.block : (Number.isSafeInteger(tx.height) ? tx.height : null);
  if (!sub && kind !== 'self' && height !== null) sub = { key: 'hist_block', params: { height } };
  const fee = tx.chain === 'solana' ? (tx.solFee != null ? `${tx.solFee} SOL` : null)
    : (tx.fee > 0 ? `${trimZeros((Number(tx.fee) || 0).toFixed(9))} QNC` : null);
  const iconRow = kind === 'swap' && Array.isArray(tx.legs) ? (tx.legs.find((l) => l.type === 'receive') || tx) : tx;
  return {
    // Nothing moved (failed, or not found): the red mark, as the extension's row.
    kind, title: spec.title, badge: settled ? spec.badge : 'failed', status, legs, sub, fee,
    node: spec.badge === 'node', isSolana: tx.chain === 'solana', reserved: legs.some((l) => l.reserved), icon: iconOf(iconRow),
  };
}

/** The line of whom a row was with, in words. */
const subText = (sub, t) => (!sub ? '' : sub.text != null ? sub.text : t(sub.key, sub.params));

// A logo is drawn as-is only when it is a short emoji; text gets the one-letter avatar (as on the Assets list).
const glyphLogo = (logo) => {
  const s = typeof logo === 'string' ? logo.trim() : '';
  return s.length > 0 && s.length <= 8 && !/[A-Za-z0-9]/.test(s) ? s : null;
};

/**
 * The asset's icon: its own image (QNC, SOL, 1DEV, the icons Assets draws), an emoji logo, or a letter on a colour taken
 * from the contract, the same colour the Assets list gives that token. A token's logo is never loaded from a URL a node or a deployer named (that would tell its host the
 * device's address and when the list was opened): only an inert emoji is drawn as it is.
 */
export function AssetIcon({ icon, size = 40 }) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (icon && icon.source && icon.zoom) {
    const inner = Math.round(size * icon.zoom);
    return (
      <View style={[round, styles.histIconZoom]}>
        <Image source={icon.source} style={{ width: inner, height: inner }} resizeMode="contain" />
      </View>
    );
  }
  if (icon && icon.source) return <Image source={icon.source} style={round} resizeMode="contain" />;
  const logo = icon ? glyphLogo(icon.logo) : null;
  let h = 0;
  const seed = String((icon && (icon.seed || icon.letter)) || '?');
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (
    <View style={[round, { backgroundColor: logo ? '#0b1a22' : `hsl(${h % 360}, 60%, 42%)`, alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ color: '#ffffff', fontSize: size * 0.42, fontWeight: '700' }}>{logo || (icon && icon.letter) || '?'}</Text>
    </View>
  );
}

// The badge glyphs, drawn as the app's other icons are (react-native-svg, a 24 box, round strokes): a disc in the
// action's colour with a dark glyph. The colours are the amounts' (outgoing white, incoming green, the app's blue for a
// transfer to itself, a swap and a node action), grey for a contract, amber for a burn and red for a failure.
const INK = '#11131f';
export const BADGES = {
  sent: { fill: '#ffffff', d: 'M8 16L16 8M10 8h6v6' },
  received: { fill: '#00ff88', d: 'M12 6v12M7 13l5 5 5-5' },
  self: { fill: '#00d4ff', d: 'M17 12a5 5 0 1 1-1.8-3.85M17 5.5v3.2h-3.2' },
  swap: { fill: '#00d4ff', d: 'M6 9.5h11.5L14.5 6.5M18 14.5H6.5l3 3' },
  node: { fill: '#00d4ff', d: 'M12 5.5l5.6 3.25v6.5L12 18.5l-5.6-3.25v-6.5z', dot: true },
  contract: { fill: '#b0b0b0', d: 'M9.5 8l-4 4 4 4M14.5 8l4 4-4 4' },
  burn: { fill: '#ffaa00', d: 'M12 4.5c.5 2.4 2.2 3.6 3.3 5.2.9 1.3 1.2 2.4 1.2 3.6a4.5 4.5 0 0 1-9 0c0-1.7.8-3 1.8-4 .1 1.2.6 2.1 1.5 2.5-.2-2.6.4-5 1.2-7.3z', solid: true },
  failed: { fill: '#ff4444', d: 'M8.5 8.5l7 7M15.5 8.5l-7 7', ink: '#ffffff' },
};

// A screen laid out right to left points the sent arrow the way that screen reads (the extension does the same).
const MIRRORED = new Set(['sent']);
// The most characters a row's number and symbol share one line with (−98,765.43 QNC); a longer pair is stacked.
const STACK_CHARS = 13;

/** A badge: the disc and glyph of `name` (BADGES), `size` across, its arrow turned for a right-to-left screen (`rtl`). */
export function BadgeGlyph({ name, size, rtl = false }) {
  const b = BADGES[name] || BADGES.sent;
  const ink = b.ink || INK;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={rtl && MIRRORED.has(name) ? styles.histBadgeMirrored : undefined}>
      <Circle cx={12} cy={12} r={12} fill={b.fill} />
      <Path d={b.d} stroke={b.solid ? 'none' : ink} strokeWidth={2.6} fill={b.solid ? ink : 'none'} strokeLinecap="round" strokeLinejoin="round" />
      {b.dot ? <Circle cx={12} cy={12} r={1.9} fill={ink} /> : null}
    </Svg>
  );
}

/** The asset's icon with the action's badge at its lower end corner, ringed in the card's colour. */
export function TxIcon({ icon, badge, size = 40, rtl = false }) {
  const b = Math.round(size * 0.45);
  return (
    <View style={{ width: size, height: size }} testID={`history-icon-${badge}`}>
      <AssetIcon icon={icon} size={size} />
      <View style={[styles.histBadge, { width: b + 4, height: b + 4, borderRadius: (b + 4) / 2 }]} testID={`history-badge-glyph-${badge}`}>
        <BadgeGlyph name={badge} size={b} rtl={rtl} />
      </View>
    </View>
  );
}

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
 * One transaction: its icon and badge, what happened over whom it was with (and its status after it while it is not
 * final), and its amounts. The amount's number never shrinks or ends in an ellipsis; its symbol, a name, may. Tapping opens the
 * detail screen.
 */
export const HistoryRow = React.memo(function HistoryRow({ tx, t, hideAmounts, onOpen }) {
  const d = describeTx(tx);
  const sub = subText(d.sub, t);
  const showStatus = d.status !== 'confirmed';
  return (
    <TouchableOpacity
      style={styles.histRow}
      onPress={() => onOpen(tx)}
      accessibilityRole="button"
      accessibilityLabel={rowA11yLabel(d, tx, t, hideAmounts)}
      testID="history-row"
    >
      <TxIcon icon={d.icon} badge={d.badge} rtl={!!t.rtl} />
      <View style={styles.histMiddle}>
        {/* What happened shrinks a little to fit beside the amount rather than wrap, never below 80% of its size; the
            amount itself never shrinks and takes at most 45% of the row (styles.histRight). */}
        <Text style={styles.histTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{t(d.title)}</Text>
        {/* Whom it was with on one line (shrinking a little rather than end in an ellipsis), and after it the status of
            a row not final, as the extension writes it: the status goes under it when both do not fit, never over it. */}
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
      {d.legs.length ? (
        <View style={styles.histRight}>
          {d.legs.slice(0, 2).map((leg, i) => {
            // A single amount too long to share its line with its symbol (a long symbol, a dust amount) puts the symbol
            // under the number, as the extension does, so the amount never takes the room of whom it was with.
            const stacked = d.legs.length === 1 && !hideAmounts && leg.number.length + leg.symbol.length > STACK_CHARS;
            return (
              <View key={i} style={[stacked ? styles.histAmountStack : styles.histAmountLine, i > 0 && styles.histAmountLineNext]}>
                <Text style={[styles.histAmount, { color: leg.tone }]} numberOfLines={1}>{hideAmounts ? '••••' : leg.number}</Text>
                {hideAmounts ? null : (
                  <Text style={[stacked ? styles.histSymbolStacked : styles.histSymbol, { color: leg.tone }]} numberOfLines={1} ellipsizeMode="tail">
                    {stacked ? leg.symbol : ` ${leg.symbol}`}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

// One field of the detail screen: its label, and its value (an address or a hash stays left to right and copies).
function Field({ label, value, mono = false, onCopy = null, copied = false, t }) {
  const body = (
    <>
      <Text style={styles.txDetailLabel}>{copied ? t('common_copied') : label}</Text>
      <Text style={[styles.txDetailValue, mono && styles.txDetailMono]} selectable>{value}</Text>
    </>
  );
  return onCopy ? (
    <TouchableOpacity style={styles.txDetailField} onPress={onCopy} accessibilityRole="button" accessibilityHint={t('common_tap_to_copy')}>
      {body}
    </TouchableOpacity>
  ) : <View style={styles.txDetailField}>{body}</View>;
}

/**
 * The detail screen of one row: the icon and badge, what happened, the exact amounts, the status, the fee, both parties
 * (a sender that is the network itself in words: systemSenderKey), the node (a node row), the time, the hash, the
 * block, the memo when the app holds one, and one action: the explorer's
 * page of a transaction the network ran (QNet's for a QNet one in a block, the Solana cluster's for a Solana one that
 * ran), or copying the hash (one still pending or not found, a Solana send that expired unrun). A node event the
 * registry alone reports has no transaction hash, so neither. `onBack` closes it; `onCopy(text, key)` copies;
 * `onExplorer(hash, chain)` opens the explorer of 'qnet' or 'solana'; `copied` names the field copied last.
 */
export function TxDetail({ tx, t, hideAmounts = false, onBack, onCopy, onExplorer, copied = '', backArrow = '←' }) {
  const d = describeTx(tx);
  const badge = d.status;
  const fields = [];
  if (d.node && (tx.nodeTypeTitle || tx.nodeType)) {
    fields.push(<Field key="type" t={t} label={t('node_type')} value={tx.nodeTypeTitle || String(tx.nodeType || '')} />);
  }
  if (d.node && tx.nodeId) {
    fields.push(<Field key="node" t={t} label={t('node_name')} value={tx.nodeId} mono onCopy={() => onCopy(tx.nodeId, 'detail-node')} copied={copied === 'detail-node'} />);
  }
  if (d.fee) fields.push(<Field key="fee" t={t} label={t('tx_detail_fee')} value={hideAmounts ? '••••' : d.fee} />);
  if (!tx.nodeEvent) {
    const system = systemSenderKey(tx, d.kind);
    if (system) fields.push(<Field key="from" t={t} label={t('tx_detail_from')} value={t(system)} />);
    else if (tx.from) fields.push(<Field key="from" t={t} label={t('tx_detail_from')} value={tx.from} mono onCopy={() => onCopy(tx.from, 'detail-from')} copied={copied === 'detail-from'} />);
    if (tx.to) fields.push(<Field key="to" t={t} label={t('tx_detail_to')} value={tx.to} mono onCopy={() => onCopy(tx.to, 'detail-to')} copied={copied === 'detail-to'} />);
  }
  if (hasTime(tx.timestamp)) fields.push(<Field key="time" t={t} label={t('tx_detail_time')} value={dateTime(tx.timestamp)} />);
  if (tx.hash && !tx.nodeEvent) fields.push(<Field key="hash" t={t} label={t('tx_label')} value={tx.hash} mono onCopy={() => onCopy(tx.hash, 'detail-hash')} copied={copied === 'detail-hash'} />);
  const block = Number.isSafeInteger(tx.block) ? tx.block : (d.node && Number.isSafeInteger(tx.height) ? tx.height : null);
  if (block !== null) fields.push(<Field key="block" t={t} label={t('tx_detail_block')} value={String(block)} />);
  if (Number.isSafeInteger(tx.slot)) fields.push(<Field key="slot" t={t} label={t('tx_detail_slot')} value={String(tx.slot)} />);
  if (typeof tx.memo === 'string' && tx.memo) fields.push(<Field key="memo" t={t} label={t('tx_detail_memo')} value={tx.memo} />);
  if (d.reserved) fields.push(<Text key="reserved" style={styles.txDetailWarning}>{t('tok_reserved_warning')}</Text>);
  // A transaction no source reported (not found) has no explorer page either: its hash is copied instead. A Solana send
  // that expired unrun (no fee charged) never reached the cluster's ledger, so it has none either.
  const chain = d.isSolana ? 'solana' : 'qnet';
  const ran = !d.isSolana || badge === 'confirmed' || (badge === 'failed' && tx.solFee != null);
  const hash = tx.nodeEvent ? null : tx.hash;
  const explorer = ran && badge !== 'pending' && badge !== 'dropped' && !!hash;
  return (
    <View>
      <View style={styles.txDetailHeader}>
        <TouchableOpacity onPress={onBack} accessibilityRole="button" accessibilityLabel={t('common_back')} style={styles.txDetailBack} testID="tx-detail-back">
          <Text style={styles.txDetailBackText} numberOfLines={1}>{`${backArrow} ${t('common_back')}`}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.txDetailCard}>
        <View style={styles.txDetailIcon}><TxIcon icon={d.icon} badge={d.badge} size={56} rtl={!!t.rtl} /></View>
        <Text style={styles.txDetailHeading} numberOfLines={2}>{t(d.title)}</Text>
        {d.legs.map((leg, i) => (
          <Text key={i} style={[styles.txDetailAmount, { color: leg.tone }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.3}>
            {hideAmounts ? '••••' : `${leg.exact} ${leg.symbol}`}
          </Text>
        ))}
        <View style={[styles.historyBadge, styles[`historyBadge_${badge}`], styles.txDetailBadge]} testID={`tx-detail-badge-${badge}`}>
          <Text style={[styles.historyBadgeText, styles[`historyBadgeText_${badge}`]]} numberOfLines={1}>{t(BADGE_KEY[badge])}</Text>
        </View>
        {fields}
      </View>
      {explorer ? (
        <TouchableOpacity style={styles.button} onPress={() => onExplorer(hash, chain)} accessibilityRole="button" testID="tx-detail-explorer">
          <Text style={styles.buttonText}>{t('tx_detail_explorer')}</Text>
        </TouchableOpacity>
      ) : hash ? (
        <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={() => onCopy(hash, 'detail-hash')} accessibilityRole="button" testID="tx-detail-copy">
          <Text style={[styles.buttonText, styles.secondaryButtonText]}>{t('tx_detail_copy_hash')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
