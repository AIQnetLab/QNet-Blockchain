'use client';

// A transaction: its short hash as the title with its type and status above, the whole hash with Copy and
// its time; readouts for its status, block, amount and fee; its sides, nonce and signature as rows; a token transfer,
// a batch's recipients or the transaction's data under them. The server renders the record into the page (page.tsx),
// so those groups are there from the first paint; while the route loads, a row the list already showed paints from the
// tab's cache. A transaction not in a block yet is asked for again as the chain moves.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getCache, setCache } from '@/lib/explorer-cache';
import { readRecord, txPath } from '@/lib/explorer-reads';
import { formatTokenAmount } from '@/lib/token-format';
import { useActivationContent } from '@/contexts/AppContext';
import { useT } from '@/i18n/client';
import { txDataEntries, txDataLabel, txTypeLabel } from '@/lib/tx-labels';
import OnHead from '@/components/explorer/OnHead';
import { HashRow, Row, Rows, Whole } from '@/components/explorer/Detail';
import { Party, QncAmount } from '@/components/explorer/cells';
import { amountCol, amountsWidth, partyCol, textCol } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink, { Amount, type AmountToken } from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { Status, TxType } from '@/components/ui/Status';
import { isAddressShape, isHeight } from '@/lib/entity';
import { signatureName, splitAmount, txStatusView } from '@/lib/explorer-view';
import { epochMs, int, qnc, short, when } from '@/lib/format';
import { siteRequest } from '@/lib/site-request';
import type { T } from '@/lib/texts';
import type { FirstAnswer } from '@/server/first-answer';

// Decoded QRC-20 ContractCall: the contract is the tx `to`, the method + args live in the tx `data` JSON
// ({"method","args":[...]}). Decimals come from the token itself (each token has its own), never the QNC formatter.
interface DecodedTokenCall {
  method: string;
  contract: string;
  to: string;
  amountRaw: string;
}

// Parse tx.data for QRC-20 value-moving methods; null for anything else, which keeps the generic data rows.
function decodeTokenCall(dataStr: string | null | undefined, contract: string): DecodedTokenCall | null {
  if (!dataStr) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(dataStr); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { method?: unknown; args?: unknown };
  const method = typeof obj.method === 'string' ? obj.method : '';
  const args = Array.isArray(obj.args) ? obj.args : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  if (method === 'transfer') return { method, contract, to: str(args[0]), amountRaw: str(args[1]) };
  if (method === 'transferFrom') return { method, contract, to: str(args[1]), amountRaw: str(args[2]) };
  return null;
}

interface TransactionData {
  hash: string;
  type: string;
  tx_type?: string;
  status: 'confirmed' | 'pending';
  block: number | string;
  block_height?: number | string;
  timestamp: number;
  // The server's first answer asked no node for a time only a node keeps (the genesis block's): read again at once.
  nodeUnread?: true;
  from: string;
  to: string;
  // Nano QNC, exact digit strings.
  amount_raw?: string;
  fee_raw?: string;
  nonce?: number | string;
  signature_type?: string;
  tx_type_data?: Record<string, unknown> | null;
  data?: string | null;
}

interface TokenMeta {
  symbol: string;
  decimals: number;
  logo: string;
}

type Phase = 'loading' | 'ready' | 'missing' | 'failed';

// A data row's label: the page's words for a fact the indexer records, else the record's field name as code, which
// keeps its own direction (i18n.css .mono) and is never machine-translated.
function DataLabel({ name, t }: { name: string; t: T }) {
  const key = txDataLabel(name);
  return key ? <>{t(key)}</> : <span className="mono" translate="no">{name}</span>;
}

// A data value: an address or a block as its link, a count grouped, anything else as written.
function DataValue({ name, value }: { name: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null;
  if (isAddressShape(value)) return <EntityLink kind="address" value={value} />;
  if (/block|height/i.test(name) && isHeight(value)) return <EntityLink kind="block" value={Number(value)} />;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return <span className="num">{int(value)}</span>;
  if (typeof value === 'object') return <span className="ex-val">{JSON.stringify(value)}</span>;
  return <span className="ex-val">{String(value)}</span>;
}

// The token a call moves: its symbol, decimals and icon, from the token's own record.
function useTokenMeta(contract: string | null): TokenMeta | null {
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  useEffect(() => {
    if (!contract) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/token/${contract}`, siteRequest());
        const result = await res.json();
        if (active && result?.success && result.data) {
          setMeta({ symbol: result.data.symbol || '', decimals: typeof result.data.decimals === 'number' ? result.data.decimals : 9, logo: result.data.logo || '' });
        }
      } catch {
        // Without the token's record the amount stays in base units.
      }
    })();
    return () => { active = false; };
  }, [contract]);
  return meta;
}

// The amount as wide as the batch's longest (columns.tsx amountsWidth).
const BATCH_COLUMNS = (t: T, full: boolean, recipients: readonly { amount: string }[]) => [
  textCol<{ i: number; to: string; amount: string }>('n', '#', (r) => int(r.i + 1), 64),
  partyCol<{ i: number; to: string; amount: string }>('to', t('tx_recipient'), (r) => r.to, full),
  amountCol<{ i: number; to: string; amount: string }>(t, (r) => <QncAmount nano={r.amount} />, t('col_amount'),
    amountsWidth(recipients.map((r) => splitAmount(`${qnc(r.amount)} QNC`)), false, 220)),
];

// `first` is the server's answer (null: it had none, the client reads it); absent while the route loads (loading.tsx):
// the page's shape with the list's row from this tab if it has one, and no reads.
export default function TransactionClient({ first }: { first?: FirstAnswer | null }) {
  const t = useT();
  const params = useParams();
  const hash = params.hash as string;
  // The app's view names reward and activation types by what they change (src/lib/tx-labels.ts).
  const full = useActivationContent();
  const [initial] = useState(() => (first ? readRecord<TransactionData>(first.status, first.body) : null));
  // A row from the list, if this tab has it, paints the loading state at once.
  const [tx, setTx] = useState<TransactionData | null>(() => initial?.record ?? (hash ? getCache<TransactionData>('tx', hash) : null));
  const [phase, setPhase] = useState<Phase>(initial?.phase ?? 'loading');

  const load = useCallback(async () => {
    try {
      const res = await fetch(txPath(hash), siteRequest());
      const read = readRecord<TransactionData>(res.status, await res.json());
      if (read.record) {
        setTx(read.record);
        setCache('tx', hash, read.record);
      }
      setPhase(read.phase);
    } catch {
      setPhase('failed');
    }
  }, [hash]);

  useEffect(() => {
    if (!hash || first === undefined) return;
    if (initial?.record) setCache('tx', hash, initial.record);
    if (!first || initial?.record?.nodeUnread) void load();
  }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = tx ? decodeTokenCall(tx.data, tx.to) : null;
  const meta = useTokenMeta(call?.contract ?? null);
  const block = tx ? (tx.block_height ?? tx.block) : null;
  const ts = tx && Number(tx.timestamp) > 0 ? epochMs(Number(tx.timestamp)) : 0;
  const recipients = tx?.tx_type_data?.recipients as Array<{ to: string; amount: string }> | undefined;
  const status = txStatusView(tx?.status, tx !== null && phase === 'ready', t);

  // The amount readout: a token transfer's token amount, else the exact QNC from nano QNC (from a listed row until the
  // record arrives).
  let amount: { value: string | null; token?: AmountToken; sub: string } = { value: null, sub: t('tx_moved') };
  if (call && meta) {
    amount = { value: formatTokenAmount(call.amountRaw, meta.decimals), token: { token: call.contract, symbol: meta.symbol, logo: meta.logo }, sub: t('tx_token_moved') };
  } else if (tx) {
    const moved = qnc(tx.amount_raw ?? '0');
    amount = { value: moved, token: {}, sub: moved === '0' ? t('tx_no_qnc') : t('tx_moved') };
  }
  const entries = txDataEntries(tx?.tx_type_data, full).filter(([key]) => key !== 'recipients');

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={(
          <span className="ex-kicker">
            {tx ? <TxType type={tx.type} label={txTypeLabel(tx.type, full, t)} /> : '\u00a0'}
            {status && <Status tone={status.done ? 'done' : 'quiet'}>{status.value}</Status>}
          </span>
        )}
        title={t('tx_title_n', { hash: short('hash', hash) })}
        more={(
          <div className="ex-ro ex-ro-amount" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label={t('tx_this')}>
              <Readout label={t('col_status')} value={status?.value ?? null} sub={status?.sub} />
              <Readout label={t('col_block')} value={block !== null && block !== '' ? int(Number(block)) : null} href={block !== null && block !== '' ? `/explorer/block/${Number(block)}` : undefined} sub={t('tx_block_sub')} />
              <Readout label={t('col_amount')} value={amount.value} amount={amount.token} sub={amount.sub} wide />
              <Readout label={t('tx_fee')} value={tx && phase === 'ready' ? qnc(tx.fee_raw ?? '0') : null} amount={{}} sub={t('tx_fee_sub')} />
            </Readouts>
          </div>
        )}
      >
        <Whole value={hash} name={t('tx_hash')} />
        <p className="ex-facts"><span className="ex-when">{ts ? when(ts, t) : '—'}</span></p>
        {phase === 'missing' && (
          <p className="ex-error" role="status">{t('tx_missing')}</p>
        )}
        {phase === 'missing' && <OnHead every={3000} max={20} onHead={load} />}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">{t('tx_unreadable')} <Action kind="act" onClick={() => void load()}>{t('try_again')}</Action></p>
        )}
      </PageHead>

      <div className="wrap ex-body">
        <section className="ex-group" aria-labelledby="tx-details">
          <h2 id="tx-details" className="tbl-title">{t('details')}</h2>
          <Rows label={t('tx_details')}>
            <Row label={t('tx_from')}>{tx ? <Party value={tx.from} full={full} whole copyName={t('tx_from_address')} /> : null}</Row>
            <Row label={t('tx_to')}>{tx ? <Party value={tx.to} full={full} whole copyName={t('tx_to_address')} /> : null}</Row>
            <Row label={t('tx_nonce')}>{tx && phase === 'ready' && tx.nonce !== undefined && tx.nonce !== null ? int(Number(tx.nonce)) : null}</Row>
            <Row label={t('blk_sig')}>{phase === 'ready' ? signatureName(tx?.signature_type) : null}</Row>
          </Rows>
        </section>

        {call && (
          <section className="ex-group" aria-labelledby="tx-token">
            <h2 id="tx-token" className="tbl-title">{t('tx_token_transfer')}</h2>
            <Rows label={t('tx_token_transfer')}>
              <Row label={t('col_amount')}>
                {meta
                  ? <Amount value={formatTokenAmount(call.amountRaw, meta.decimals)} token={call.contract} symbol={meta.symbol} logo={meta.logo} />
                  : <span className="num">{t('tx_base_units', { amount: /^\d+$/.test(call.amountRaw) ? formatTokenAmount(call.amountRaw, 0) : call.amountRaw })}</span>}
              </Row>
              <Row label={t('tx_recipient')}><Party value={call.to} full={full} whole copyName={t('tx_recipient_address')} /></Row>
              <Row label={t('col_token')}><EntityLink kind="token" value={call.contract} symbol={meta?.symbol} /></Row>
              <HashRow label={t('tx_contract')} value={call.contract} />
              <Row label={t('tx_method')}><span className="ex-val">{call.method}</span></Row>
            </Rows>
          </section>
        )}

        {!call && Array.isArray(recipients) && recipients.length > 0 && (
          <DataTable
            title={t('tx_batch')}
            meta={<span className="label">{t('tx_batch_count', { count: int(recipients.length) })}</span>}
            caption={t('tx_batch_caption')}
            columns={BATCH_COLUMNS(t, full, recipients)}
            rows={recipients.map((r, i) => ({ i, to: r.to, amount: r.amount }))}
            rowKey={(r) => String(r.i)}
          />
        )}

        {!call && entries.length > 0 && (
          <section className="ex-group" aria-labelledby="tx-data">
            <h2 id="tx-data" className="tbl-title">{t('tx_data')}</h2>
            <Rows label={t('tx_data')}>
              {entries.map(([key, value]) => <Row key={key} label={<DataLabel name={key} t={t} />}><DataValue name={key} value={value} /></Row>)}
            </Rows>
          </section>
        )}
      </div>
    </div>
  );
}
