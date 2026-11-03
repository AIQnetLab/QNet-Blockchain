'use client';

// An address: its short form as the title, the whole address spaced at its structure with Copy; readouts
// for its balance, transactions, first and last activity; its other tokens, its transactions (newest first, the first
// page live) and its token transfers. The server renders the first answer into the page (page.tsx), so its notes and
// tables are there from the first paint; it follows the chain (read again as the head moves, at most every 3 s, only
// while shown).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getCache, setCache } from '@/lib/explorer-cache';
import { addressPath, readRecord } from '@/lib/explorer-reads';
import { useActivationContent } from '@/contexts/AppContext';
import { useI18n } from '@/i18n/client';
import { txPartyLabel } from '@/lib/tx-labels';
import OnHead from '@/components/explorer/OnHead';
import { Row, Rows, Whole } from '@/components/explorer/Detail';
import { TxAmount } from '@/components/explorer/cells';
import { amountCol, amountsWidth, blockCol, fromToCol, hashCol, textCol, timeCol, typeCol, useSteadyWidth } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink, { AddressParts, Amount } from '@/components/ui/EntityLink';
import Copy from '@/components/ui/Copy';
import PageHead from '@/components/ui/PageHead';
import Pager from '@/components/ui/Pager';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { isAddressShape } from '@/lib/entity';
import { ageText, rowAmount, splitAmount, type AmountParts } from '@/lib/explorer-view';
import { day, int, qnc, short, when } from '@/lib/format';
import { amountWidth } from '@/lib/geometry';
import { named } from '@/lib/rich';
import { siteRequest } from '@/lib/site-request';
import type { FirstAnswer } from '@/server/first-answer';
import { number } from '@/lib/texts';

interface AddressTx {
  hash: string;
  type: string;
  from: string;
  to: string;
  amount_raw: string; // nano QNC
  timestamp: number;
  block: number;
  status: 'confirmed' | 'pending';
}

interface TokenTransfer {
  hash: string;
  from: string;
  to: string;
  kind: string;
  direction: 'in' | 'out';
  symbol: string;
  contract: string;
  logo: string;
  std: string;        // qrc20 | qrc721
  token_id: string;   // NFT id (qrc721); '' for qrc20
  amount: string;     // qrc20: decimal amount; qrc721: "#<token_id>"
  block: number;
  timestamp: number;
}

interface AddressToken {
  symbol: string;
  name: string;
  contract_address: string;
  decimals: number;
  balance: string;
}

interface AddressData {
  address: string;
  balance_raw: string | null; // nano QNC; null for a system account and while no node has answered
  nodeUnread?: true;              // no node answered in time: the balance and tokens are read again at once
  txCount: number;
  txCountCapped?: boolean;
  firstSeen: number;
  lastActive: number;
  isSystem?: boolean;
  historyUnavailable?: boolean;   // balance is authoritative; TX history read failed (DB down/resync)
  genesisAllocation?: boolean;    // load-test account funded in the genesis block (public key)
  tokens: AddressToken[];
  transactions: AddressTx[];
  tokenTransfers: TokenTransfer[];
}

// The balance check's answer (/api/address/[address]/balance-proof): verified against the committee certificate of a
// checkpoint, or why it is not. The figure is shown from the exact nano QNC.
interface BalanceProofResult {
  verified: boolean;
  balanceNano: string;
  exists: boolean;
  macroblockIndex: number;
  stateHeight: number;
  stateRoot: string;
  verificationTime: number;
  error?: string;
}

const BalanceVerification = ({ address }: { address: string }) => {
  const { t, say } = useI18n();
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<BalanceProofResult | null>(null);

  const verifyBalance = async () => {
    setVerifying(true);
    setResult(null);
    const startTime = performance.now();
    const failed = (error: string): BalanceProofResult => ({
      verified: false, balanceNano: '', exists: false, macroblockIndex: 0, stateHeight: 0, stateRoot: '',
      verificationTime: Math.round(performance.now() - startTime), error,
    });
    try {
      const response = await fetch(`/api/address/${address}/balance-proof`, siteRequest());
      const data = await response.json();
      if (data.success && data.verified === true && typeof data.stateRoot === 'string' && typeof data.balanceNano === 'string' && /^\d+$/.test(data.balanceNano)) {
        setResult({
          verified: true,
          balanceNano: data.balanceNano,
          exists: data.exists === true,
          macroblockIndex: Number(data.macroblockIndex) || 0,
          stateHeight: Number(data.stateHeight) || 0,
          stateRoot: data.stateRoot,
          verificationTime: Math.round(performance.now() - startTime),
        });
      } else {
        // The route's reason or status in the page's language; its own error text is English, for API readers.
        const why = data.reason === 'not_confirmed_yet' ? t('proof_not_confirmed') : data.reason === 'network_unavailable' ? t('proof_network_down')
          : response.status === 429 ? t('link_rate_limited', { minutes: 1 }) : t('proof_failed');
        setResult(failed(why));
      }
    } catch {
      setResult(failed(t('proof_failed')));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="ex-group" aria-labelledby="addr-proof">
      <h2 id="addr-proof" className="tbl-title">{t('proof_title')}</h2>
      <div className="actions">
        <Action kind="text" onClick={() => void verifyBalance()} busy={verifying}>
          {verifying ? t('proof_checking') : result?.verified ? t('proof_verified') : t('proof_verify')}
        </Action>
      </div>
      {result && (
        <Rows label={t('proof_title')}>
          <Row label={t('col_status')}>{result.verified ? t('proof_proven') : <span className="em">{result.error ? named(result.error) : t('proof_failed')}</span>}</Row>
          {result.verified && (
            <>
              <Row label={t('proof_balance')}>{t(result.exists ? 'proof_amount' : 'proof_amount_new', { amount: qnc(result.balanceNano) })}</Row>
              <Row label={t('proof_checkpoint')}>{number(result.macroblockIndex)}</Row>
              <Row label={t('proof_state_at')}><EntityLink kind="block" value={result.stateHeight} /></Row>
              <Row label={t('blk_state_root')}><span className="ex-val">{short('hash', result.stateRoot)}</span></Row>
              <Row label={t('proof_time')}>{t('proof_ms', { ms: number(result.verificationTime) })}</Row>
            </>
          )}
        </Rows>
      )}
      <p className="note">{say('proof_note')}</p>
    </section>
  );
};

type Phase = 'loading' | 'ready' | 'missing' | 'failed';
// A token transfer's amount (exact from the server, in the token's decimals) with the token its unit links to.
const tokenParts = (x: TokenTransfer, unnamed: string): AmountParts | null => {
  const parts = splitAmount(`${x.amount} ${x.symbol || unnamed}`);
  return parts && { ...parts, token: x.contract };
};
const TX_PER_PAGE = 25;

// `first` is the server's answer (null: it had none, the client reads it); absent while the route loads (loading.tsx):
// the page's shape with this tab's copy of the address if it has one, and no reads.
export default function AddressClient({ first }: { first?: FirstAnswer | null }) {
  const { t, say } = useI18n();
  const params = useParams();
  const address = params.address as string;
  // The app's view names reward and activation types by what they change (src/lib/tx-labels.ts).
  const full = useActivationContent();
  const [initial] = useState(() => (first ? readRecord<AddressData>(first.status, first.body, [400]) : null));
  const [data, setData] = useState<AddressData | null>(() => initial?.record ?? (address ? getCache<AddressData>('address', address) : null));
  const [phase, setPhase] = useState<Phase>(initial?.phase ?? (data ? 'ready' : 'loading'));
  const [txPage, setTxPage] = useState(1);
  const shown = useRef(Boolean(initial?.record));

  const fetchAddress = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(addressPath(address), siteRequest());
      const read = readRecord<AddressData>(res.status, await res.json(), [400]);
      if (read.record) {
        setData(read.record);
        setCache('address', address, read.record);
        setPhase('ready');
        shown.current = true;
      } else if (!shown.current) {
        // A refresh that fails keeps what is shown; only a first read says why it has nothing.
        setPhase(read.phase);
      }
    } catch {
      if (!shown.current) setPhase('failed');
    }
  }, [address]);

  useEffect(() => {
    if (!address || first === undefined) return;
    if (initial?.record) setCache('address', address, initial.record);
    // The server rendered what it knew; what no node told it in time is read here.
    if (!first || initial?.record?.nodeUnread) void fetchAddress();
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps


  const d = data;
  const system = d?.isSystem === true || (!isAddressShape(address) && /^system_|^genesis$/.test(address));
  // A system account's name reads differently in the app's view (src/lib/tx-labels.ts): on the site the app's name stays
  // under the chain's, unseen, so the title keeps the lines it had before the wallet check ended (never the other way round).
  const inAppName = txPartyLabel(address, false);
  const name = !system ? null : full && inAppName !== address ? (
    <span className="swap">
      <span data-on="true">{address}</span>
      <span data-on="false" aria-hidden="true">{inAppName}</span>
    </span>
  ) : txPartyLabel(address, full);
  const otherTokens = useMemo(() => (d?.tokens ?? []).filter((x) => x.symbol !== 'QNC'), [d?.tokens]);
  const txs = useMemo(() => d?.transactions ?? [], [d?.transactions]);
  const pages = Math.max(1, Math.ceil(txs.length / TX_PER_PAGE));
  const pageRows = d ? txs.slice((txPage - 1) * TX_PER_PAGE, txPage * TX_PER_PAGE) : null;

  // Each amount column as wide as its longest value (columns.tsx amountsWidth): a token's amount to 18 decimals never
  // runs into the next column. Kept for the address while its rows refresh, so From / To never moves under the reader.
  const transfers = useMemo(() => d?.tokenTransfers ?? [], [d?.tokenTransfers]);
  const txAmountW = useSteadyWidth(useMemo(() => amountsWidth(txs.map((x) => rowAmount(x, t('token_unnamed'))), true), [txs, t]), address);
  const transferAmountW = useSteadyWidth(useMemo(() => amountsWidth(transfers.map((x) => (x.std === 'qrc721' ? { value: x.amount, unit: '' }
    : tokenParts(x, t('token_unnamed')))), true), [transfers, t]), address);
  const txColumns = useMemo(() => [
    hashCol<AddressTx>(t, (x) => x.hash),
    typeCol<AddressTx>(t, (x) => x.type, full),
    fromToCol<AddressTx>(t, (x) => x.from, (x) => x.to, full, () => ({ self: address })),
    amountCol<AddressTx>(t, (x) => <TxAmount parts={rowAmount(x, t('token_unnamed'))} sign={x.from === address ? '−' : '+'} />, t('col_amount'), txAmountW),
    blockCol<AddressTx>(t, (x) => x.block),
    timeCol<AddressTx>(t, (x) => x.timestamp),
  ], [t, full, address, txAmountW]);

  const transferColumns = useMemo(() => [
    hashCol<TokenTransfer>(t, (x) => x.hash),
    textCol<TokenTransfer>('token', t('col_token'), (x) => <EntityLink kind="token" value={x.contract} symbol={x.symbol} />, 136),
    // Tokens the contract issued have no sender, tokens destroyed no recipient.
    fromToCol<TokenTransfer>(t, (x) => x.from, (x) => x.to, full, () => ({ self: address, fromWord: t('addr_issued'), toWord: t('addr_destroyed') })),
    amountCol<TokenTransfer>(t, (x) => (x.std === 'qrc721'
      ? <span className="amount-v num">{x.amount}</span>
      : <TxAmount parts={tokenParts(x, t('token_unnamed'))} sign={x.direction === 'out' ? '−' : '+'} logo={x.logo} />), t('col_amount'), transferAmountW),
    blockCol<TokenTransfer>(t, (x) => x.block),
    timeCol<TokenTransfer>(t, (x) => x.timestamp),
  ], [t, full, address, transferAmountW]);

  const tokenColumns = useMemo(() => [
    textCol<AddressToken>('token', t('col_token'), (x) => <EntityLink kind="token" value={x.contract_address} symbol={x.symbol} />, 160),
    textCol<AddressToken>('name', t('col_name'), (x) => x.name || null),
    amountCol<AddressToken>(t, (x) => <Amount value={x.balance} token={x.contract_address} symbol={x.symbol} />, t('col_balance'),
      amountWidth(otherTokens.map((x) => ({ value: x.balance, unit: x.symbol || t('token_unnamed') })), 260)),
  ], [t, otherTokens]);

  const capped = d && d.txCount > txs.length;
  // Not an address: the page says so and shows no empty readouts or rows that would never fill.
  const absent = phase === 'missing' && !d;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={system ? t('addr_system') : isAddressShape(address) ? undefined : t('sugg_address')}
        // The whole address under the word, in its groups, with Copy under it.
        title={name ?? (isAddressShape(address) ? <>{t('sugg_address')}<span className="ex-title-addr" translate="no"><AddressParts value={address} /></span></> : address)}
        more={absent ? undefined : (
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label={t('addr_this')}>
              <Readout label={t('col_balance')} value={system || !d || d.balance_raw === null ? null : qnc(d.balance_raw)} amount={{}} sub={system ? t('addr_balance_system') : t('addr_balance_sub')} />
              <Readout label={t('col_transactions')} value={d && !system ? `${int(d.txCount)}${d.txCountCapped ? '+' : ''}` : null} sub={t('addr_txs_sub')} />
              <Readout label={t('addr_first')} value={d && d.firstSeen && !system ? day(d.firstSeen, t) : null} sub={d && d.firstSeen && !system ? when(d.firstSeen, t) : t('addr_first_sub')} />
              <Readout label={t('addr_last')} value={d && d.lastActive && !system ? ageText(d.lastActive, Date.now(), t) : null} sub={d && d.lastActive && !system ? when(d.lastActive, t) : t('addr_last_sub')} />
            </Readouts>
          </div>
        )}
      >
        {system ? <p className="ex-facts"><span>{say('addr_system_note')}</span></p> : (
          isAddressShape(address) ? <Copy value={address} ariaLabel={t('account_copy')} /> : <Whole value={null} name={t('addr_name')} length={46} />
        )}
        {d?.genesisAllocation && <p className="note">{t('addr_load_test')}</p>}
        {phase === 'missing' && <p className="ex-error" role="status">{say('wallet_enter_invalid')}</p>}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">{t('addr_unreadable')} <Action kind="act" onClick={() => void fetchAddress()}>{t('try_again')}</Action></p>
        )}
      </PageHead>

      <div className="wrap ex-body">
        {/* Read again as the chain head moves, at most every 3 s and only while the tab is shown. */}
        {first !== undefined && <OnHead every={3000} onHead={fetchAddress} />}
        {/* v3.11: Merkle proof verification — temporarily hidden
        <BalanceVerification address={address} />
        */}

        {otherTokens.length > 0 && (
          <DataTable title={t('addr_other_tokens')} caption={t('addr_other_tokens_caption')} columns={tokenColumns} rows={otherTokens} rowKey={(x) => x.contract_address} />
        )}

        {!system && !absent && (
          <section className="ex-group">
            <DataTable
              title={t('col_transactions')}
              caption={t('addr_txs_caption')}
              columns={txColumns}
              rows={pageRows}
              rowKey={(x) => `${x.hash}:${x.from === address ? 'out' : 'in'}`}
              live={txPage === 1}
              loadingRows={3}
              empty={d?.historyUnavailable ? t('addr_history_unavailable') : t('addr_no_txs')}
            />
            {txs.length > TX_PER_PAGE && <Pager page={txPage} pages={pages} onPage={(n) => setTxPage(Math.min(Math.max(1, n), pages))} />}
            {capped && <p className="note">{t('addr_capped', { shown: int(txs.length), total: `${int(d!.txCount)}${d!.txCountCapped ? '+' : ''}` })}</p>}
          </section>
        )}

        {(d?.tokenTransfers?.length ?? 0) > 0 && (
          <DataTable title={t('addr_token_transfers')} caption={t('addr_token_transfers_caption')} columns={transferColumns} rows={d!.tokenTransfers} rowKey={(x) => `${x.hash}:${x.contract}:${x.direction}:${x.token_id}`} />
        )}
      </div>
    </div>
  );
}
