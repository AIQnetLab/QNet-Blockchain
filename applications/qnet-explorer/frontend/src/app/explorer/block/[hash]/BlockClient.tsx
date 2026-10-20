'use client';

// A block (B-SPEC 6.3): its height as the title with its type above, the whole hash with Copy, its time and its
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
import OnHead from '@/components/explorer/OnHead';
import Disclosure from '@/components/explorer/Disclosure';
import { HashRow, Row, Rows, Whole } from '@/components/explorer/Detail';
import { QncAmount } from '@/components/explorer/cells';
import { fromToCol, hashCol, partyCol, textCol, timeCol, typeCol, amountCol } from '@/components/explorer/columns';
import Action from '@/components/ui/Action';
import DataTable from '@/components/ui/DataTable';
import EntityLink from '@/components/ui/EntityLink';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { isAddressShape } from '@/lib/entity';
import { signatureName } from '@/lib/explorer-view';
import { epochMs, int, when } from '@/lib/format';
import type { FirstAnswer } from '@/server/first-answer';

type Phase = 'loading' | 'ready' | 'missing' | 'failed';

const TYPE_NAME: Record<string, string> = { MICROBLOCK: 'Microblock', MACROBLOCK: 'Macroblock' };

// The blocks either side, named in words, once this block is known; the next one only once the chain has it. A height
// the chain has not reached leads to the newest block instead.
function Neighbours({ height, known }: { height: number | null; known: boolean }) {
  const head = useChainHead();
  if (height !== null && !known && head.height > 0 && height > head.height) {
    return <span className="ex-neigh"><span><span className="fog">Newest block </span><EntityLink kind="block" value={head.height} /></span></span>;
  }
  // The empty slot has a link's box, so the line keeps its height and baseline until a neighbour shows (block 0 has no
  // previous one, and its next only once the head is known).
  const slot = <span className="ex-neigh-slot" aria-hidden="true">{'\u00a0'}</span>;
  if (height === null || !known) return <span className="ex-neigh" aria-hidden="true">{slot}</span>;
  const previous = height > 0;
  const next = head.height > height;
  return (
    <span className="ex-neigh">
      {previous && <span><span className="fog">Previous </span><EntityLink kind="block" value={height - 1} /></span>}
      {next && <span><span className="fog">Next </span><EntityLink kind="block" value={height + 1} /></span>}
      {!previous && !next && slot}
    </span>
  );
}

const TX_COLUMNS = (full: boolean) => [
  hashCol<BlockTransaction>((t) => t.hash),
  typeCol<BlockTransaction>((t) => t.type, full),
  fromToCol<BlockTransaction>((t) => t.from, (t) => t.to, full),
  amountCol<BlockTransaction>((t) => <QncAmount nano={t.amount} />),
];

const VALIDATOR_COLUMNS = [
  timeCol<HeartbeatEntry>((v) => v.timestamp),
  textCol<HeartbeatEntry>('node', 'Node', (v) => <EntityLink kind="node" value={v.node_id} address={v.node_address} />, 220),
  partyCol<HeartbeatEntry>('address', 'Address', (v) => v.node_address, true),
  textCol<HeartbeatEntry>('type', 'Type', (v) => v.node_type, 96),
  textCol<HeartbeatEntry>('rep', 'Reputation', (v) => int(v.reputation), 104, 'right'),
];

// `first` is the server's answer (null: it had none, the client reads it); absent while the route loads (loading.tsx):
// the page's shape with this tab's copy of the block if it has one, and no reads.
export default function BlockClient({ first }: { first?: FirstAnswer | null }) {
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
      const res = await fetch(blockPath(id));
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
  const txColumns = useMemo(() => TX_COLUMNS(full), [full]);
  const producerAddress = b && isAddressShape(b.producer_address) ? b.producer_address : undefined;
  // No such block: the page says so and shows no empty readouts or rows that would never fill.
  const absent = phase === 'missing' && !b;

  return (
    <div className="ex ex-detail">
      <PageHead
        kicker={<span className="ex-kicker">{b ? TYPE_NAME[b.block_type] ?? b.block_type : '\u00a0'}</span>}
        title={height !== null ? `Block ${int(height)}` : 'Block'}
        more={absent ? undefined : (
          <div className="ex-ro" data-field-dim="0.1">
            <Readouts cols={4} size="tool" label="This block">
              <Readout label="Transactions" value={b ? int(b.tx_count) : null} sub={pruned ? 'Kept without their bodies' : 'In this block'} />
              <Readout label="Producer" value={b ? b.producer : null} href={producerAddress ? `/explorer/address/${producerAddress}` : undefined} sub="The node that made it" />
              <Readout label="Gas used" value={b ? int(b.total_gas_used ?? 0) : null} sub="By its transactions" />
              <Readout label="Size" value={b && Number(b.size_bytes) > 0 ? int(Number(b.size_bytes)) : null} unit="bytes" sub={b && !(Number(b.size_bytes) > 0) ? 'Not recorded' : 'As stored'} />
            </Readouts>
          </div>
        )}
      >
        <Whole value={b?.hash ?? (askedHeight === null ? id : null)} name="block hash" />
        <p className="ex-facts">
          <span className="ex-when">{b ? (b.height === 0 ? 'Genesis' : when(epochMs(Number(b.timestamp)))) : '—'}</span>
          <Neighbours height={height} known={b !== null} />
        </p>
        {phase === 'missing' && (
          <p className="ex-error" role="status">
            {askedHeight !== null ? 'This block is not in the explorer yet. The page shows it once the chain reaches it.' : 'No block has this hash.'}
          </p>
        )}
        {phase === 'missing' && askedHeight !== null && <OnHead from={askedHeight} every={3000} max={20} onHead={load} />}
        {phase === 'failed' && (
          <p className="ex-error" role="alert">Could not read this block. <Action kind="act" onClick={() => void load()}>Try again</Action></p>
        )}
      </PageHead>

      <div className="wrap ex-body">
        {!absent && <section className="ex-group" aria-labelledby="blk-details">
          <h2 id="blk-details" className="tbl-title">Details</h2>
          <Rows label="Block details">
            <Row label="Previous block">
              {b ? (b.height === 0 ? 'Genesis' : <EntityLink kind="block" value={b.previous_hash} copy copyName="previous block hash" />) : null}
            </Row>
            <HashRow label="Merkle root" value={b?.merkle_root} />
            <HashRow label="State root" value={b?.state_root} />
            <HashRow label="VTS hash" value={b?.poh_hash} />
            <Row label="VTS counter">{b ? int(b.poh_count) : null}</Row>
            <Row label="Signature type">{signatureName(b?.signature_type)}</Row>
            <HashRow label="Signature" value={b?.signature} />
            <Row label="Certificate">{b?.cert_serial ? <span className="ex-val">{b.cert_serial}</span> : null}</Row>
            <HashRow label="QRB output" value={b?.qrb_output} />
            <Row label="Version">{b ? int(b.version || 1) : null}</Row>
          </Rows>
        </section>}

        {isMacro && cd && (
          <section className="ex-group" aria-labelledby="blk-consensus">
            <h2 id="blk-consensus" className="tbl-title">{full ? 'Consensus data (emission window)' : 'Consensus data'}</h2>
            <Rows label="Consensus data">
              <Row label="Commits">{int(cd.commits_count)}</Row>
              <Row label="Reveals">{int(cd.reveals_count)}</Row>
              <Row label="Next leader">{cd.next_leader ? <EntityLink kind="node" value={cd.next_leader} /> : null}</Row>
              <Row label="Eligible nodes">{int(cd.eligible_nodes_count)}</Row>
              {cd.fees_collected !== undefined && <Row label="Fees collected"><QncAmount nano={cd.fees_collected} /></Row>}
              {cd.pool3_total_activations !== undefined && (
                <Row label={full ? 'Pool 3 Activations' : 'Pool 3 total'}><QncAmount nano={cd.pool3_total_activations} /></Row>
              )}
            </Rows>
          </section>
        )}

        {pruned && (
          <section className="ex-group" aria-labelledby="blk-txs">
            <h2 id="blk-txs" className="tbl-title">Transactions</h2>
            <p className="ex-line">The network pruned this block&apos;s {int(b!.tx_count)} transactions before the explorer read them, so only the block itself is kept.</p>
          </section>
        )}
        {b && !pruned && b.transactions.length > 0 && (
          <DataTable
            title="Transactions"
            caption={`Transactions in block ${int(b.height)}`}
            columns={txColumns}
            rows={b.transactions}
            rowKey={(t) => t.hash}
          />
        )}

        {isMacro && cd?.heartbeat_entries && cd.heartbeat_entries.length > 0 && (
          <Disclosure title="Validators" count={cd.heartbeat_entries.length}>
            <DataTable caption="Validators of this macroblock" columns={VALIDATOR_COLUMNS} rows={cd.heartbeat_entries} rowKey={(v) => `${v.node_id}:${v.timestamp}`} />
          </Disclosure>
        )}
        {isMacro && b?.micro_blocks && b.micro_blocks.length > 0 && (
          <Disclosure title="Included microblocks" count={b.micro_blocks.length}>
            <DataTable
              caption="Microblocks this macroblock includes"
              columns={[
                textCol<{ i: number; hash: string }>('n', '#', (m) => int(m.i + 1), 72),
                textCol<{ i: number; hash: string }>('block', 'Block', (m) => <EntityLink kind="block" value={m.hash} copy />),
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
