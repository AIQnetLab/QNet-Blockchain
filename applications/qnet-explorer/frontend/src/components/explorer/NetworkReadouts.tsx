'use client';

// The explorer's readouts (B-SPEC 5.11; owner 19.10: light and server nodes as two readings of equal weight): the
// block height, the epoch, light nodes, server nodes, the QNC supply and the last block's age with the node that made
// it. The server's snapshot gives the first values, the head stream the next; only this strip renders again on a new head.

import EntityLink from '@/components/ui/EntityLink';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { useChainHead, type HeadBlockFacts } from '@/hooks/useChainHead';
import { useNodeCounts } from '@/hooks/useNodeCounts';
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
  useClock();
  const [running, setRunning] = useState(false);
  useEffect(() => setRunning(true), []);
  const by = block ? <>By <EntityLink kind="node" value={block.producer} address={block.producerAddress} /></> : 'Since the newest block';
  return <Readout label="Last block" value={running && ts ? ageText(ts, Date.now()) : null} sub={by} />;
}

export default function NetworkReadouts({ initial }: { initial: HeadFacts }) {
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
      <Readouts cols={3} size="tool" label="QNet Blockchain now">
        <Readout label="Block height" value={known ? int(height) : null} href={known ? `/explorer/block/${height}` : undefined} flash sub="One block a second" />
        <EpochReadout height={height} />
        <NodeCountReadouts nodes={nodes} />
        <Readout label="QNC supply" value={known ? formatQncTruncated(emission, 2) : null} href="/explorer/qnc" sub="Circulating" />
        <LastBlock ts={ts} block={block} />
      </Readouts>
    </div>
  );
}
