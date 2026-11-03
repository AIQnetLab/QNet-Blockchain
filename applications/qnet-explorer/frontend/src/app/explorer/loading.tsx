'use client';

// The explorer while the server renders it (client navigation): the page's own geometry with nothing in it yet:
// the same title band, field and search, six readouts reading "—", the Latest blocks strip with empty cells and
// fifty empty transaction rows at their final height, so the page moves nothing when it arrives.

import { useMemo } from 'react';
import ExplorerSearch from '@/components/explorer/ExplorerSearch';
import LatestBlocks from '@/components/explorer/LatestBlocks';
import DataTable from '@/components/ui/DataTable';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { useI18n } from '@/i18n/client';
import type { MessageKey } from '@/lib/texts';
import { listColumns } from './ExplorerClient';

const READOUTS: MessageKey[] = ['ro_height', 'ro_epoch_label', 'ro_server_nodes', 'ro_light_nodes', 'ro_supply', 'ro_last_block'];

export default function Loading() {
  const { t, say } = useI18n();
  // The real columns (cells are never drawn: there are no rows yet).
  const columns = useMemo(() => listColumns(t, false), [t]);
  return (
    <div className="ex ex-list">
      <PageHead
        title={say('ex_title')}
        lead={t('ex_lead')}
        strength={0.55}
        more={(
          <div className="ex-ro ex-ro-net">
            <Readouts cols={3} size="tool" label={t('ro_now')}>
              {READOUTS.map((key) => <Readout key={key} label={say(key)} value={null} progress={key === 'ro_epoch_label' ? null : undefined} />)}
            </Readouts>
          </div>
        )}
      >
        <ExplorerSearch />
      </PageHead>
      <div className="wrap ex-main" aria-busy="true">
        <LatestBlocks seed={[]} />
        <section className="ex-txs">
          <DataTable className="ex-txs-tbl" title={t('ex_all_txs')} caption={t('ex_all_txs_newest')} columns={columns} rows={null} rowKey={() => ''} loadingRows={50} tools={<div className="ex-filters" aria-hidden="true" />} />
        </section>
      </div>
    </div>
  );
}
