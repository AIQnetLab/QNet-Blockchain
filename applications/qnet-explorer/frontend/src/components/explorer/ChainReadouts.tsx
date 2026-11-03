'use client';

// The network readings the home page, the explorer and My node share, so each is written once and reads the same
// everywhere: this epoch (its number linked to its first block, the time left, the line of its blocks done) and the
// active light and server nodes of the last settled epoch, light first, two readings of equal weight.

import type { ReactNode } from 'react';
import { EpochNumber } from '@/components/ui/EntityLink';
import { Readout } from '@/components/ui/Readouts';
import type { NodeCounts } from '@/hooks/useNodeCounts';
import { useT } from '@/i18n/client';
import { epochProgress } from '@/lib/cabinet/epochs';
import { epochHref } from '@/lib/entity';
import { endsIn, int } from '@/lib/format';

// `reading`: My node's form, the node's word for this epoch as the value and the epoch's number, linked, in the label.
export function EpochReadout({ height, reading }: { height: number; reading?: { label: (epoch: ReactNode) => ReactNode; value: string | null } }) {
  const t = useT();
  const at = epochProgress(height);
  const epoch = at ? int(at.epoch) : null;
  return (
    <Readout
      label={reading ? reading.label(at ? <EpochNumber epoch={at.epoch} /> : '—') : t('ro_epoch_label')}
      value={reading ? reading.value : epoch}
      href={!reading && at ? epochHref(at.epoch) : undefined}
      sub={at ? endsIn(at.left, t) : undefined}
      progress={at ? at.done : null}
    />
  );
}

export function NodeCountReadouts({ nodes }: { nodes: NodeCounts | null }) {
  const t = useT();
  return (
    <>
      <Readout label={t('ro_light_nodes')} value={nodes ? int(nodes.lightNodes) : null} sub={t('ro_light_nodes_sub')} />
      <Readout label={t('ro_server_nodes')} value={nodes && nodes.superNodes !== null ? int(nodes.superNodes) : null} sub={t('ro_server_nodes_sub')} />
    </>
  );
}
