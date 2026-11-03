'use client';

// A block: its height as the title with its type above, the whole hash with Copy, its time and its
// neighbours; readouts for its transactions, producer, gas and size; its details as rows; a macroblock's consensus
// data, validators and included microblocks. The server renders the block into the page (page.tsx), so its
// transactions and groups are there from the first paint; the loading state has the same head and rows, reading "—".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import type { Block, BlockTransaction, HeartbeatEntry } from '@/lib/types';
import { getCache, isCacheStale, setCache } from '@/lib/explorer-cache';
import { blockPath, readRecord } from '@/lib/explorer-reads';
import { useActivationContent } from '@/contexts/AppContext';
import { useChainHead } from '@/hooks/useChainHead';
import { useI18n, useT } from '@/i18n/client';
import OnHead from '@/components/explorer/OnHead';
import Disclosure from '@/components/explorer/Disclosure';
import { HashRow, Row, Rows, Whole } from '@/components/explorer/Detail';
import { QncAmount } from '@/components/explorer/cells';
import { fromToCol, hashCol, partyCol, textCol, timeCol, typeCol, amountCol, amountsWidth } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { isAddressShape } from '@/lib/entity';
import { signatureName, splitAmount } from '@/lib/explorer-view';
import { epochMs, int, qnc, when } from '@/lib/format';
import { siteRequest } from '@/lib/site-request';
import type { MessageKey, T } from '@/lib/texts';
import type { FirstAnswer } from '@/server/first-answer';

type Phase = 'loading' | 'ready' | 'missing' | 'failed';

const TYPE_NAME: Record<string, MessageKey> = { MICROBLOCK: 'blk_micro', MACROBLOCK: 'blk_macro' };

// The blocks either side, named in words, once this block is known; the next one only once the chain has it. A height
// the chain has not reached leads to the newest block instead.
function Neighbours({ height, known }: { height: number | null; known: boolean }) {
  const t = useT();
  const head = useChainHead();
  if (height !== null && !known && head.height > 0 && height > head.height) {
    return <span className="ex-neigh"><span><span className="fog">{t('blk_newest')} </span><EntityLink kind="block" value={head.height} /></span></span>;
  }
  // The empty slot has a link's box, so the line keeps its height and baseline until a neighbour shows (block 0 has no
  // previous one, and its next only once the head is known).
  const slot = <span className="ex-neigh-slot" aria-hidden="true">{'\u00a0'}</span>;
  if (height === null || !known) return <span className="ex-neigh" aria-hidden="true">{slot}</span>;
  const previous = height > 0;
  const next = head.height > height;
  return (
    <span className="ex-neigh">
      {previous && <span><span className="fog">{t('blk_before')} </span><EntityLink kind="block" value={height - 1} /></span>}
      {next && <span><span className="fog">{t('blk_after')} </span><EntityLink kind="block" value={height + 1} /></span>}
      {!previous && !next && slot}
    </span>
  );
}

// `amountW`: as wide as the block's longest amount (columns.tsx amountsWidth).
const TX_COLUMNS = (t: T, full: boolean, amountW: number) => [
  hashCol<BlockTransaction>(t, (x) => x.hash),
  typeCol<BlockTransaction>(t, (x) => x.type, full),
  fromToCol<BlockTransaction>(t, (x) => x.from, (x) => x.to, full),
  amountCol<BlockTransaction>(t, (x) => <QncAmount nano={x.amount} />, t('col_amount'), amountW),
];

const VALIDATOR_COLUMNS = (t: T) => [
  timeCol<HeartbeatEntry>(t, (v) => v.timestamp),
  textCol<HeartbeatEntry>('node', t('col_node'), (v) => <EntityLink kind="node" value={v.node_id} address={v.node_address} />, 220),
  partyCol<HeartbeatEntry>('address', t('col_address'), (v) => v.node_address, true),
  textCol<HeartbeatEntry>('type', t('col_type'), (v) => v.node_type, 96),
  textCol<HeartbeatEntry>('rep', t('col_reputation'), (v) => int(v.reputation), 104, 'right'),
];

// `first` is the server's answer (null: it had none, the client reads it); absent while the route loads (loading.tsx):
// the page's shape with this tab's copy of the block if it has one, and no reads.
export default function BlockClient({ first }: { first?: FirstAnswer | null }) {
  const { t, say, rich } = useI18n();
  const params = useParams();
  const id = params.hash as string;
  // The app's view names reward and activation types by what they change (src/lib/tx-labels.ts).
  const full = useActivationContent();
  const [initial] = useState(() => (first ? readRecord<Block>(first.status, first.body) : null));
  const [block, setBlock] = useState<Block | null>(() => initial?.record ?? (id ? getCache<Block>('block', id) : null));
  const [phase, setPhase] = useState<Phase>(initial?.phase ?? (block ? 'ready' : 'loading'));
  const askedHeight = /^\d+$/.test(id) ? Number(id) : null;

  const load = useCallback(async () => {
    try {
      const res = await fetch(blockPath(id), siteRequest());
      const read = readRecord<Block>(res.status, await res.json());
      if (read.record) {
        setBlock(read.record);
        setCache('block', id, read.record);
      }
      setPhase(read.phase);
    } catch {
      setPhase('failed');
    }
  }, [id]);

  useEffect(() => {
    if (!id || first === undefined) return;
    // The server's block is kept for the next visit from this tab.
    if (initial?.record) setCache('block', id, initial.record);
    if (first || (block && !isCacheStale('block', id))) return;
    void load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = block;
  const height = b ? b.height : askedHeight;
  const isMacro = b?.block_type === 'MACROBLOCK';
  const cd = b?.consensus_data;
  const pruned = b ? b.body_indexed === false && b.tx_count > 0 : false;
  const amountW = useMemo(() => amountsWidth((b?.transactions ?? []).map((x) => splitAmount(`${qnc(x.amount)} QNC`))), [b?.transactions]);
  const txColumns = useMemo(() => TX_COLUMNS(t, full, amountW), [t, full, amountW]);
  const producerAddress = b && isAddressShape(b.producer_address) ? b.producer_address : undefined;
  // No such block: the page says so and shows no empty readouts or rows that would never fill.
  const absent = phase === 'missing' && !b;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={<span className="ex-kicker">{b ? (TYPE_NAME[b.block_type] ? say(TYPE_NAME[b.block_type]) : b.block_type) : '\u00a0'}</span>}
        title={height !== null ? t('blk_title_n', { height: int(height) }) : t('col_block')}
        more={absent ? undefined : (
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label={t('blk_this')}>
              <Readout label={t('col_transactions')} value={b ? int(b.tx_count) : null} sub={pruned ? t('blk_txs_pruned') : t('blk_txs_in')} />
              <Readout label={t('col_producer')} value={b ? b.producer : null} href={producerAddress ? `/explorer/address/${producerAddress}` : undefined} sub={t('blk_producer_sub')} />
              <Readout label={t('blk_gas')} value={b ? int(b.total_gas_used ?? 0) : null} sub={t('blk_gas_sub')} />
              <Readout label={t('blk_size')} value={b && Number(b.size_bytes) > 0 ? int(Number(b.size_bytes)) : null} unit={t('blk_bytes')} sub={b && !(Number(b.size_bytes) > 0) ? t('blk_size_none') : t('blk_size_sub')} />
            </Readouts>
          </div>
        )}
      >
        <Whole value={b?.hash ?? (askedHeight === null ? id : null)} name={t('blk_hash')} />
        <p className="ex-facts">
          <span className="ex-when">{b ? (b.height === 0 ? t('genesis') : when(epochMs(Number(b.timestamp)), t)) : '—'}</span>
          <Neighbours height={height} known={b !== null} />
        </p>
        {phase === 'missing' && (
          <p className="ex-error" role="status">
            {askedHeight !== null ? t('blk_not_yet') : t('blk_no_hash')}
          </p>
        )}
        {phase === 'missing' && askedHeight !== null && <OnHead from={askedHeight} every={3000} max={20} onHead={load} />}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">{t('blk_unreadable')} <Action kind="act" onClick={() => void load()}>{t('try_again')}</Action></p>
        )}
      </PageHead>

      <div className="wrap ex-body">
        {!absent && <section className="ex-group" aria-labelledby="blk-details">
          <h2 id="blk-details" className="tbl-title">{t('details')}</h2>
          <Rows label={t('blk_details')}>
            <Row label={t('blk_prev_block')}>
              {b ? (b.height === 0 ? t('genesis') : <EntityLink kind="block" value={b.previous_hash} copy copyName={t('blk_prev_hash')} />) : null}
            </Row>
            <HashRow label={t('blk_merkle')} value={b?.merkle_root} />
            <HashRow label={t('blk_state_root')} value={b?.state_root} />
            <HashRow label={t('blk_vts_hash')} value={b?.poh_hash} />
            <Row label={t('blk_vts_counter')}>{b ? int(b.poh_count) : null}</Row>
            <Row label={t('blk_sig_type')}>{signatureName(b?.signature_type)}</Row>
            <HashRow label={t('blk_sig')} value={b?.signature} />
            <Row label={t('blk_cert')}>{b?.cert_serial ? <span className="ex-val">{b.cert_serial}</span> : null}</Row>
            <HashRow label={t('blk_qrb')} value={b?.qrb_output} />
            <Row label={t('blk_version')}>{b ? int(b.version || 1) : null}</Row>
          </Rows>
        </section>}

        {isMacro && cd && (
          <section className="ex-group" aria-labelledby="blk-consensus">
            <h2 id="blk-consensus" className="tbl-title">{full ? t('blk_consensus_emission') : t('blk_consensus')}</h2>
            <Rows label={t('blk_consensus')}>
              <Row label={t('blk_commits')}>{int(cd.commits_count)}</Row>
              <Row label={t('blk_reveals')}>{int(cd.reveals_count)}</Row>
              <Row label={t('blk_next_leader')}>{cd.next_leader ? <EntityLink kind="node" value={cd.next_leader} /> : null}</Row>
              <Row label={t('blk_eligible')}>{int(cd.eligible_nodes_count)}</Row>
              {cd.fees_collected !== undefined && <Row label={t('blk_fees')}><QncAmount nano={cd.fees_collected} /></Row>}
              {cd.pool3_total_activations !== undefined && (
                <Row label={full ? t('blk_pool3_activations') : t('blk_pool3_total')}><QncAmount nano={cd.pool3_total_activations} /></Row>
              )}
            </Rows>
          </section>
        )}

        {pruned && (
          <section className="ex-group" aria-labelledby="blk-txs">
            <h2 id="blk-txs" className="tbl-title">{t('col_transactions')}</h2>
            <p className="ex-line">{say('blk_pruned', { count: int(b!.tx_count) })}</p>
          </section>
        )}
        {b && !pruned && b.transactions.length > 0 && (
          <DataTable
            title={t('col_transactions')}
            caption={t('blk_txs_caption', { height: int(b.height) })}
            columns={txColumns}
            rows={b.transactions}
            rowKey={(t) => t.hash}
          />
        )}

        {isMacro && cd?.heartbeat_entries && cd.heartbeat_entries.length > 0 && (
          <Disclosure title={t('blk_validators')} count={cd.heartbeat_entries.length}>
            <DataTable caption={t('blk_validators_caption')} columns={VALIDATOR_COLUMNS(t)} rows={cd.heartbeat_entries} rowKey={(v) => `${v.node_id}:${v.timestamp}`} />
          </Disclosure>
        )}
        {isMacro && b?.micro_blocks && b.micro_blocks.length > 0 && (
          <Disclosure title={t('blk_micros')} count={b.micro_blocks.length}>
            <DataTable
              caption={t('blk_micros_caption')}
              columns={[
                textCol<{ i: number; hash: string }>('n', '#', (m) => int(m.i + 1), 72),
                textCol<{ i: number; hash: string }>('block', t('col_block'), (m) => <EntityLink kind="block" value={m.hash} copy />),
              ]}
              rows={b.micro_blocks.map((hash, i) => ({ i, hash }))}
              rowKey={(m) => `${m.i}`}
            />
          </Disclosure>
        )}
      </div>
    </div>
  );
}
