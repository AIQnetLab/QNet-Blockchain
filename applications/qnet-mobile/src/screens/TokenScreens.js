/**
 * TokenPicker (Send on Assets: every asset held on the network shown, searchable) and TokenDetail (a token's own screen:
 * balance, Information and Security from services/TokenFacts, its transfers). Pure views fed by the wallet screen.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { FIGURE_LINE, InfoField, InfoRow, figureFitsIn } from '../components/InfoRow';
import Action, { ActionPair } from '../components/ui/Action';
import Field from '../components/ui/Field';
import Head, { headStyles } from '../components/ui/Head';
import Press from '../components/ui/Press';
import Section, { sectionStyles } from '../components/ui/Section';
import Sheet from '../components/ui/Sheet';
import TokenIcon from '../components/TokenIcons';
import { CHAIN_NAME } from '../i18n';
import { amountText } from '../utils/amountFormat';
import { contractShortId } from '../utils/tokenSafety';
import { historyRowKey } from '../utils/txHistory';
import { HistoryRow, assetEntries, dateTime } from './HistoryTab';
import styles from './WalletScreen.styles';

// How many of the token's transfers its screen lists before Show all.
export const ACTIVITY_SHOWN = 5;
// A text value up to this many characters sits beside its label; a longer one (a token's name) goes under it, whole.
const BESIDE_CHARS = 12;
// The Security rows (services/TokenFacts): the fact, its row's label and the label of who may. Each Yes is a risk to a
// holder (Ember), each No is not (Mint).
const SECURITY = [
  ['mint', 'tok_mint_open', 'tok_mint_by'],
  ['metadata', 'tok_metadata_open', null],
  ['freeze', 'tok_freeze_open', 'tok_freeze_by'],
];

/** Whether an asset matches a search: its symbol, name, contract or mint holds the text, in any case. */
export function assetMatches(asset, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [asset.symbol, asset.name, asset.contract, asset.mint].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

/** A picker row's id: the symbol of an asset without a contract, the start of a token's contract. */
export const pickId = (asset) => (asset.contract ? asset.contract.slice(0, 12) : asset.symbol);

// A balance stays beside its token while it fits two fifths of the row at its smallest (tokenBalance: 98 dp on a 320 dp
// screen, at the largest text size a row follows); otherwise it takes a line of its own under the token, whole: an exact
// figure (a QRC-20 balance has up to 18 decimals) is never cut.
const TOKEN_FIGURE_ROOM = 98;
const TOKEN_FIGURE_SIZE = 16;

/**
 * One asset as a rounded row, on Assets and in the token picker alike: its icon (a token with a contract wears its
 * letter, never a known icon), its symbol, name and contract, which wrap rather than lose their ends (where a look-alike
 * differs), one named after QNet marked as not QNC, and its balance.
 */
export function AssetRow({ asset, t, onPress, onLongPress, testID }) {
  const beside = figureFitsIn(asset.figure, TOKEN_FIGURE_ROOM, TOKEN_FIGURE_SIZE);
  return (
    <Press
      style={({ pressed }) => [styles.tokenItemClickable, !beside && styles.tokenItemWrap, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      testID={testID}
    >
      <View style={styles.tokenInfo}>
        <TokenIcon network={asset.network} symbol={asset.symbol} contract={asset.contract} style={styles.tokenIcon} />
        <View style={styles.tokenDetails}>
          <Text style={[styles.tokenName, asset.reserved && styles.tokenWarn]}>{asset.symbol}</Text>
          {asset.name ? <Text style={styles.tokenPrice}>{asset.name}</Text> : null}
          {asset.contract ? <Text style={styles.tokenPrice}>{t('tok_contract_id', { id: contractShortId(asset.contract) })}</Text> : null}
          {asset.reserved ? <Text style={[styles.tokenPrice, styles.tokenWarn]}>{t('tok_reserved_warning')}</Text> : null}
        </View>
      </View>
      <View style={beside ? styles.tokenBalance : styles.tokenBalanceUnder}>
        <Text style={styles.tokenAmount} {...(beside ? FIGURE_LINE : null)}>{asset.figure}</Text>
      </View>
    </Press>
  );
}

export function TokenPicker({ t, assets, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const shown = assets.filter((a) => assetMatches(a, query));
  return (
    <Sheet t={t} title={t('tok_pick_title')} onClose={onClose} height="80%" scroll={false} bodyStyle={styles.mgrBody} testID="token-picker">
      <Field
        placeholder={t('tok_search')}
        accessibilityLabel={t('tok_search')}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.mgrSearch}
      />
      <FlatList
        data={shown}
        keyExtractor={(a) => a.key}
        keyboardShouldPersistTaps="handled"
        style={styles.mgrList}
        ListEmptyComponent={<Text style={styles.mgrEmpty}>{t('tok_empty')}</Text>}
        renderItem={({ item }) => <AssetRow asset={item} t={t} onPress={() => onPick(item)} testID={`pick-${pickId(item)}`} />}
      />
    </Sheet>
  );
}

// The facts of the asset on screen, read once per asset, each part on screen as its source answers (`load(asset, shown)`
// hands the parts that came first to `shown`); {} until one comes and when none does.
function useFacts(asset, load) {
  const [facts, setFacts] = useState(null);
  const id = `${asset.network}:${asset.key}`;
  useEffect(() => {
    let live = true;
    setFacts(null);
    const shown = (f) => { if (live) setFacts(f || {}); };
    Promise.resolve().then(() => load(asset, shown)).then(shown, () => { if (live) setFacts((f) => f || {}); });
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return facts || {};
}

export function TokenDetail({
  t, asset, entries, loadFacts, hideAmounts = false, hideNames = false, onBack, onReceive, onSend, onOpenTx, onMore,
}) {
  const facts = useFacts(asset, loadFacts);
  const [all, setAll] = useState(false);
  const activity = useMemo(() => assetEntries(entries, asset.history), [entries, asset.history]);
  const listed = all ? activity : activity.slice(0, ACTIVITY_SHOWN);

  // A short value beside its label, a longer one under it; an address whole on one line, copied by a tap; a figure in
  // the token's units.
  const text = (key, label, value) => ([...String(value)].length <= BESIDE_CHARS
    ? <InfoRow key={key} label={label} value={value} />
    : <InfoField key={key} t={t} label={label} value={value} />);
  const address = (key, label, value) => (
    <InfoField key={key} t={t} label={label} value={value} mono fit copy={value} copyTestID={`token-copy-${key}`} />
  );
  const amount = (key, label, value) => <InfoRow key={key} label={label} value={`${amountText(value)} ${asset.symbol}`} ltr fit />;

  const info = [];
  if (asset.name) info.push(text('name', t('tok_name'), asset.name));
  info.push(text('symbol', t('tok_symbol'), asset.symbol));
  info.push(<InfoRow key="network" label={t('network')} value={asset.network === 'solana' ? t('solana_devnet') : CHAIN_NAME} />);
  if (asset.contract || asset.mint) info.push(address('address', t('tok_address'), asset.contract || asset.mint));
  if (Number.isInteger(asset.decimals)) info.push(<InfoRow key="decimals" label={t('tok_decimals')} value={String(asset.decimals)} ltr fit />);
  if (facts.totalSupply) info.push(amount('supply', t('tok_total_supply'), facts.totalSupply));
  if (facts.circulating) info.push(amount('circulating', t('tok_circulating'), facts.circulating));
  if (Number.isSafeInteger(facts.holders)) info.push(<InfoRow key="holders" label={t('tok_holders')} value={amountText(String(facts.holders))} ltr fit />);
  if (Number.isFinite(facts.createdAt)) info.push(<InfoRow key="created" label={t('tok_created')} value={dateTime(facts.createdAt)} ltr />);
  if (facts.creator) info.push(address('creator', t('tok_creator'), facts.creator));

  // The share the ten largest holders hold (a QNet token's, from the explorer index), then what the token allows, a row
  // for each part its source answered (a QNet token's node, a Solana token's mint) and under it who may, when named.
  const security = [];
  if (facts.top10) security.push(<InfoRow key="top10" label={t('tok_top10')} value={`${amountText(facts.top10)}%`} ltr fit />);
  for (const [key, openKey, byKey] of SECURITY) {
    const fact = facts[key];
    if (!fact || typeof fact.open !== 'boolean') continue;
    security.push(<InfoRow key={`${key}-open`} label={t(openKey)} value={t(fact.open ? 'common_yes' : 'common_no')}
      tone={fact.open ? 'warn' : 'ok'} />);
    if (fact.by && byKey) security.push(address(`${key}-by`, t(byKey), fact.by));
  }

  const head = (
    <>
      <Head onBack={onBack} backLabel={t('common_back')} backTestID="token-back">
        <View style={styles.tokenHead}>
          <TokenIcon network={asset.network} symbol={asset.symbol} contract={asset.contract} size={44} />
          <View style={styles.tokenHeadText}>
            <Text style={[headStyles.title, asset.reserved && styles.tokenWarn]} accessibilityRole="header" testID="token-title">
              {asset.name || asset.symbol}
            </Text>
            {asset.name ? <Text style={styles.tokenHeadSymbol}>{asset.symbol}</Text> : null}
          </View>
        </View>
      </Head>
      <ActionPair
        style={styles.assetActions}
        start={{ label: t('assets_receive'), onPress: onReceive, testID: 'token-receive' }}
        end={{ label: t('assets_send'), onPress: onSend, testID: 'token-send' }}
      />
      {!asset.known || asset.reserved ? (
        <Section testID="token-warning">
          {!asset.known ? <Text style={styles.tokenWarning}>{t('tok_unknown_warning')}</Text> : null}
          {asset.reserved ? <Text style={styles.tokenWarning}>{t('tok_reserved_warning')}</Text> : null}
        </Section>
      ) : null}
      <Section title={t('tok_balance')} testID="token-balance">
        <View style={[styles.tokenBalanceRow, sectionStyles.bleed]}>
          <Text style={styles.tokenBalanceFigure} {...FIGURE_LINE} testID="token-balance-figure">{`${asset.figure} ${asset.symbol}`}</Text>
        </View>
      </Section>
      <Section title={t('tok_information')} testID="token-information">{info}</Section>
      {security.length ? <Section title={t('tok_security')} testID="token-security">{security}</Section> : null}
      <View style={styles.tokenActivityHead}>
        <Text style={[styles.histDay, styles.tokenActivityTitle]} accessibilityRole="header">{t('tok_activity')}</Text>
        {!all && activity.length > ACTIVITY_SHOWN ? (
          <Action kind="quiet" label={t('tok_show_all')} onPress={() => setAll(true)} testID="token-show-all" />
        ) : null}
      </View>
      {asset.network === 'solana' ? <Text style={styles.histScope}>{t('hist_solana_scope')}</Text> : null}
    </>
  );
  return (
    <FlatList
      style={[styles.content, styles.subScreen]}
      contentContainerStyle={styles.scrollContentContainer}
      data={listed}
      keyExtractor={(item, i) => (item.hash ? historyRowKey(item) : String(i))}
      renderItem={({ item }) => <HistoryRow tx={item} t={t} hideAmounts={hideAmounts} hideNames={hideNames} onOpen={onOpenTx} />}
      ListHeaderComponent={head}
      ListEmptyComponent={<View style={styles.histEmptyBox}><Text style={styles.histEmpty}>{t('hist_empty')}</Text></View>}
      onEndReached={all && onMore ? onMore : undefined}
      onEndReachedThreshold={0.5}
      testID="token-detail"
    />
  );
}
