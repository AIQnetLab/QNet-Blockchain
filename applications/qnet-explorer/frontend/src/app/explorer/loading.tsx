'use client';

// The explorer while the server renders it (client navigation): the page's own geometry with nothing in it yet (B-SPEC
// 3.13): the same title band, field and search, six readouts reading "—", the Latest blocks strip with empty cells and
// fifty empty transaction rows at their final height, so the page moves nothing when it arrives.

import ExplorerSearch from '@/components/explorer/ExplorerSearch';
import LatestBlocks from '@/components/explorer/LatestBlocks';
import DataTable from '@/components/ui/DataTable';
import PageHead from '@/components/ui/PageHead';
import { Readout, Readouts } from '@/components/ui/Readouts';
import { listColumns } from './ExplorerClient';

// The real columns (cells are never drawn: there are no rows yet).
const TX_COLUMNS = listColumns(false);
const READOUTS = ['Block height', 'Epoch', 'Server nodes', 'Light nodes', 'QNC supply', 'Last block'];

export default function Loading() {
  return (
    <div className="ex ex-list">
      <PageHead
        title="QNet Blockchain Explorer"
        lead="All transactions from Genesis to Now"
        strength={0.55}
        more={(
          <div className="ex-ro ex-ro-net">
            <Readouts cols={3} size="tool" label="QNet Blockchain now">
              {READOUTS.map((label) => <Readout key={label} label={label} value={null} progress={label === 'Epoch' ? null : undefined} />)}
            </Readouts>
          </div>
        )}
      >
        <ExplorerSearch />
      </PageHead>
      <div className="wrap ex-main" aria-busy="true">
        <LatestBlocks seed={[]} />
        <section className="ex-txs">
          <DataTable className="ex-txs-tbl" title="All transactions" caption="All transactions, newest first" columns={TX_COLUMNS} rows={null} rowKey={() => ''} loadingRows={50} tools={<div className="ex-filters" aria-hidden="true" />} />
        </section>
      </div>
    </div>
  );
}
