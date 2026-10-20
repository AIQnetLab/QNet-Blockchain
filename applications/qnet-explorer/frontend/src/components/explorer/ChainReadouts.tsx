// The network readings the home page, the explorer and My node share, so each is written once and reads the same
// everywhere: this epoch (its number linked to its first block, the time left, the line of its blocks done) and the
// active light and server nodes of the last settled epoch, light first, two readings of equal weight (owner 19.10).

import type { ReactNode } from 'react';
import { EpochNumber } from '@/components/ui/EntityLink';
import { Readout } from '@/components/ui/Readouts';
import type { NodeCounts } from '@/hooks/useNodeCounts';
import { epochProgress } from '@/lib/cabinet/epochs';
import { epochHref } from '@/lib/entity';
import { endsIn, int } from '@/lib/format';

// `reading`: My node's form, the node's word for this epoch as the value and the epoch's number, linked, in the label.
export function EpochReadout({ height, reading }: { height: number; reading?: { label: (epoch: ReactNode) => ReactNode; value: string | null } }) {
  const at = epochProgress(height);
  const epoch = at ? int(at.epoch) : null;
  return (
    <Readout
      label={reading ? reading.label(at ? <EpochNumber epoch={at.epoch} /> : '—') : 'Epoch'}
      value={reading ? reading.value : epoch}
      href={!reading && at ? epochHref(at.epoch) : undefined}
      sub={at ? endsIn(at.left) : undefined}
      progress={at ? at.done : null}
    />
  );
}

export function NodeCountReadouts({ nodes }: { nodes: NodeCounts | null }) {
  return (
    <>
      <Readout label="Light nodes" value={nodes ? int(nodes.lightNodes) : null} sub="Phones and tablets, last epoch" />
      <Readout label="Server nodes" value={nodes ? int(nodes.superNodes) : null} sub="Super nodes, last epoch" />
    </>
  );
}
