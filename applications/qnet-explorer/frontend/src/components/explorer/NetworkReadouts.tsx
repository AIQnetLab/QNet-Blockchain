'use client';

// The explorer's readouts (light and server nodes as two readings of equal weight): the
// block height, the epoch, light nodes, server nodes, the QNC supply and the last block's age with the node that made
// it. The server's snapshot gives the first values, the head stream the next; only this strip renders again on a new head.

import EntityLink from '@/components/ui/EntityLink';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { useChainHead, type HeadBlockFacts } from '@/hooks/useChainHead';
import { useNodeCounts } from '@/hooks/useNodeCounts';
import { useI18n, useT } from '@/i18n/client';
import { int } from '@/lib/format';
import { formatQncTruncated } from '@/lib/token-format';
import { useEffect, useState } from 'react';
import { ageText } from '@/lib/explorer-view';
import { useClock } from './Ago';
import { EpochReadout, NodeCountReadouts } from './ChainReadouts';

export interface HeadFacts {
  height: number;
  timestamp: number;
  emissionNano: string;
  // The head block's producer and transaction count, when known.
  block: HeadBlockFacts | null;
}

// The last block's age counts on by itself; before the page runs it is "—" (the server cannot know the visitor's now).
// Under it the node that made it, a link to its address when the index knows it.
function LastBlock({ ts, block }: { ts: number; block: HeadBlockFacts | null }) {
  const { t, rich } = useI18n();
  useClock();
  const [running, setRunning] = useState(false);
  useEffect(() => setRunning(true), []);
  const by = block ? rich('ro_last_block_by', { node: <EntityLink kind="node" value={block.producer} address={block.producerAddress} /> }) : t('ro_last_block_since');
  return <Readout label={t('ro_last_block')} value={running && ts ? ageText(ts, Date.now(), t) : null} sub={by} />;
}

export default function NetworkReadouts({ initial }: { initial: HeadFacts }) {
  const t = useT();
  const head = useChainHead();
  const live = head.height > 0;
  const height = live ? head.height : initial.height;
  const emission = live ? head.emissionTotal : initial.emissionNano;
  const ts = live ? head.timestamp : initial.timestamp;
  const block = live ? head.block : initial.block;
  const nodes = useNodeCounts(height);
  const known = height > 0;
  return (
    <div className="ex-ro ex-ro-net" data-field-dim="0.1">
      <Readouts cols={3} size="tool" label={t('ro_now')}>
        <Readout label={t('ro_height')} value={known ? int(height) : null} href={known ? `/explorer/block/${height}` : undefined} flash sub={t('ro_height_sub')} />
        <EpochReadout height={height} />
        <NodeCountReadouts nodes={nodes} />
        <Readout label={t('ro_supply')} value={known ? formatQncTruncated(emission, 2) : null} amount={{}} href="/explorer/qnc" sub={t('ro_supply_sub')} />
        <LastBlock ts={ts} block={block} />
      </Readouts>
    </div>
  );
}
