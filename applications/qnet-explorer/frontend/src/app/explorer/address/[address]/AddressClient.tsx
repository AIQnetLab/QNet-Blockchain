'use client';

// An address (B-SPEC 6.5): its short form as the title, the whole address spaced at its structure with Copy; readouts
// for its balance, transactions, first and last activity; its other tokens, its transactions (newest first, the first
// page live) and its token transfers. The server renders the first answer into the page (page.tsx), so its notes and
// tables are there from the first paint; it follows the chain (read again as the head moves, at most every 3 s, only
// while shown).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { getCache, setCache } from '@/lib/explorer-cache';
import { addressPath, readRecord } from '@/lib/explorer-reads';
import { useActivationContent } from '@/contexts/AppContext';
import { txPartyLabel } from '@/lib/tx-labels';
import OnHead from '@/components/explorer/OnHead';
import { Row, Rows, Whole } from '@/components/explorer/Detail';
import { TxAmount } from '@/components/explorer/cells';
import { amountCol, blockCol, fromToCol, hashCol, textCol, timeCol, typeCol } from '@/components/explorer/columns';
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
      const response = await fetch(`/api/address/${address}/balance-proof`);
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
        setResult(failed(typeof data.error === 'string' ? data.error : 'Verification failed'));
      }
    } catch (err) {
      setResult(failed(err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section className="ex-group" aria-labelledby="addr-proof">
      <h2 id="addr-proof" className="tbl-title">Balance check</h2>
      <div className="actions">
        <Action kind="text" onClick={() => void verifyBalance()} busy={verifying}>
          {verifying ? 'Checking…' : result?.verified ? 'Verified by the committee certificate' : 'Verify Balance'}
        </Action>
      </div>
      {result && (
        <Rows label="Balance check">
          <Row label="Status">{result.verified ? 'Proven against the certified state root' : <span className="em">{result.error || 'Verification failed'}</span>}</Row>
          {result.verified && (
            <>
              <Row label="Proven balance">{qnc(result.balanceNano)} QNC{result.exists ? '' : ' (no account yet)'}</Row>
              <Row label="Checkpoint">{number(result.macroblockIndex)}</Row>
              <Row label="State at block"><EntityLink kind="block" value={result.stateHeight} /></Row>
              <Row label="State root"><span className="ex-val">{short('hash', result.stateRoot)}</span></Row>
              <Row label="Verification time">{number(result.verificationTime)} ms</Row>
            </>
          )}
        </Rows>
      )}
      <p className="note">
        The balance is proven against the state root that the validator committee of QNet Blockchain signed for this
        checkpoint. The site checks the committee&apos;s signatures itself, so no single node is trusted. The proven
        balance is the account&apos;s balance at that checkpoint, which is certified about one to two minutes after its
        block; the balance shown above is the latest the explorer read and can be newer.
      </p>
    </section>
  );
};

type Phase = 'loading' | 'ready' | 'missing' | 'failed';
// A token transfer's amount (exact from the server, in the token's decimals) with the token its unit links to.
const tokenParts = (t: TokenTransfer): AmountParts | null => {
  const parts = splitAmount(`${t.amount} ${t.symbol || 'Token'}`);
  return parts && { ...parts, token: t.contract };
};
const TX_PER_PAGE = 25;

// `first` is the server's answer (null: it had none, the client reads it); absent while the route loads (loading.tsx):
// the page's shape with this tab's copy of the address if it has one, and no reads.
export default function AddressClient({ first }: { first?: FirstAnswer | null }) {
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
      const res = await fetch(addressPath(address));
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
  const otherTokens = (d?.tokens ?? []).filter((t) => t.symbol !== 'QNC');
  const txs = d?.transactions ?? [];
  const pages = Math.max(1, Math.ceil(txs.length / TX_PER_PAGE));
  const pageRows = d ? txs.slice((txPage - 1) * TX_PER_PAGE, txPage * TX_PER_PAGE) : null;

  const txColumns = useMemo(() => [
    hashCol<AddressTx>((t) => t.hash),
    typeCol<AddressTx>((t) => t.type, full),
    fromToCol<AddressTx>((t) => t.from, (t) => t.to, full, () => ({ self: address })),
    amountCol<AddressTx>((t) => <TxAmount parts={rowAmount(t)} sign={t.from === address ? '−' : '+'} />),
    blockCol<AddressTx>((t) => t.block),
    timeCol<AddressTx>((t) => t.timestamp),
  ], [full, address]);

  const transferColumns = useMemo(() => [
    hashCol<TokenTransfer>((t) => t.hash),
    textCol<TokenTransfer>('token', 'Token', (t) => <EntityLink kind="token" value={t.contract} symbol={t.symbol} />, 136),
    // Tokens the contract issued have no sender, tokens destroyed no recipient.
    fromToCol<TokenTransfer>((t) => t.from, (t) => t.to, full, () => ({ self: address, fromWord: 'Issued', toWord: 'destroyed' })),
    amountCol<TokenTransfer>((t) => (t.std === 'qrc721'
      ? <span className="amount-v num">{t.amount}</span>
      : <TxAmount parts={tokenParts(t)} sign={t.direction === 'out' ? '−' : '+'} logo={t.logo} />)),
    blockCol<TokenTransfer>((t) => t.block),
    timeCol<TokenTransfer>((t) => t.timestamp),
  ], [full, address]);

  const tokenColumns = useMemo(() => [
    textCol<AddressToken>('token', 'Token', (t) => <EntityLink kind="token" value={t.contract_address} symbol={t.symbol} />, 160),
    textCol<AddressToken>('name', 'Name', (t) => t.name || null),
    amountCol<AddressToken>((t) => <Amount value={t.balance} token={t.contract_address} symbol={t.symbol} />, 'Balance', 260),
  ], []);

  const capped = d && d.txCount > txs.length;
  // Not an address: the page says so and shows no empty readouts or rows that would never fill.
  const absent = phase === 'missing' && !d;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={system ? 'System account' : isAddressShape(address) ? undefined : 'Address'}
        // The whole address under the word, in its groups (owner 20.10), with Copy under it.
        title={name ?? (isAddressShape(address) ? <>Address<span className="ex-title-addr"><AddressParts value={address} /></span></> : address)}
        more={absent ? undefined : (
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label="This address">
              <Readout label="Balance" value={system || !d || d.balance_raw === null ? null : qnc(d.balance_raw)} amount={{}} sub={system ? 'Not read for a system account' : 'As the node reads it now'} />
              <Readout label="Transactions" value={d && !system ? `${int(d.txCount)}${d.txCountCapped ? '+' : ''}` : null} sub="Sent and received" />
              <Readout label="First seen" value={d && d.firstSeen && !system ? day(d.firstSeen) : null} sub={d && d.firstSeen && !system ? when(d.firstSeen) : 'Its oldest listed transaction'} />
              <Readout label="Last active" value={d && d.lastActive && !system ? ageText(d.lastActive, Date.now()) : null} sub={d && d.lastActive && !system ? when(d.lastActive) : 'Its newest transaction'} />
            </Readouts>
          </div>
        )}
      >
        {system ? <p className="ex-facts"><span>A system account of QNet Blockchain: it holds no key, and the explorer does not read its balance.</span></p> : (
          isAddressShape(address) ? <Copy value={address} ariaLabel="Copy address" /> : <Whole value={null} name="address" length={46} />
        )}
        {d?.genesisAllocation && (
          <p className="note">
            Load-test account: funded in the genesis block for stress tests. Its key is public, so anyone can move this
            balance; it is not part of the QNC supply and is not counted among holders.
          </p>
        )}
        {phase === 'missing' && <p className="ex-error" role="status">This is not a QNet Blockchain address.</p>}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">Could not read this address. <Action kind="act" onClick={() => void fetchAddress()}>Try again</Action></p>
        )}
      </PageHead>

      <div className="wrap ex-body">
        {/* Read again as the chain head moves, at most every 3 s and only while the tab is shown. */}
        {first !== undefined && <OnHead every={3000} onHead={fetchAddress} />}
        {/* v3.11: Merkle proof verification — temporarily hidden
        <BalanceVerification address={address} />
        */}

        {otherTokens.length > 0 && (
          <DataTable title="Other tokens" caption="Tokens this address holds" columns={tokenColumns} rows={otherTokens} rowKey={(t) => t.contract_address} />
        )}

        {!system && !absent && (
          <section className="ex-group">
            <DataTable
              title="Transactions"
              caption="Transactions of this address, newest first"
              columns={txColumns}
              rows={pageRows}
              rowKey={(t) => `${t.hash}:${t.from === address ? 'out' : 'in'}`}
              live={txPage === 1}
              loadingRows={3}
              empty={d?.historyUnavailable ? 'The transaction history cannot be read right now; the balance above is current.' : 'No transactions yet.'}
            />
            {txs.length > TX_PER_PAGE && <Pager page={txPage} pages={pages} onPage={(n) => setTxPage(Math.min(Math.max(1, n), pages))} />}
            {capped && <p className="note">The newest {int(txs.length)} of {int(d!.txCount)}{d!.txCountCapped ? '+' : ''} transactions are listed here.</p>}
          </section>
        )}

        {(d?.tokenTransfers?.length ?? 0) > 0 && (
          <DataTable title="Token transfers" caption="Token transfers of this address" columns={transferColumns} rows={d!.tokenTransfers} rowKey={(t) => `${t.hash}:${t.contract}:${t.direction}:${t.token_id}`} />
        )}
      </div>
    </div>
  );
}
