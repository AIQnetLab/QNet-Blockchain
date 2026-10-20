'use client';

// The Overview's two pictures of the latest epochs (B-SPEC 5.19), from the history's first page, the read the epochs
// table shares: the last 12 as a strip of cells in the readouts (each cell names its epoch and result in the line under
// it on hover, focus or tap; at rest that line names the newest epoch not counted, or the newest one), and the node
// balance each of the latest 16 added, as bars with a marker at the newest one moved to the wallet. Labels are text at
// fixed sizes; each picture has its words for a screen reader.

import { useState, type CSSProperties } from 'react';
import { EpochNumber } from '@/components/ui/EntityLink';
import { Readout } from '@/components/ui/Readouts';
import { useNodeHistory } from '@/hooks/useNodeStatus';
import { BAR_EPOCHS, STRIP_EPOCHS, lastEpochs, perEpochBars, stripRest, type StripCell } from '@/lib/cabinet/epoch-strip';
import { rich } from '@/lib/rich';
import { number, t } from '@/lib/texts';
import { useCabinet } from './CabinetProvider';
import { resultText } from './NodeHistory';
import { Group } from './parts';

const cellWords = (cell: StripCell) => t('strip_epoch', { epoch: number(cell.epoch), result: resultText(cell.result) });

export function LastEpochsReadout({ nodeId }: { nodeId: string | null }) {
  const { viewOnly } = useCabinet();
  const { state } = useNodeHistory(nodeId, viewOnly);
  const cells = state.phase === 'ok' ? lastEpochs(state.value.rows) : [];
  const [pointed, setPointed] = useState<StripCell | null>(null);
  const shown = pointed ?? stripRest(cells);
  // The line names its epoch as a link; the cells' own names stay words.
  const epoch = shown === null ? null : <EpochNumber epoch={shown.epoch} />;
  const line = shown === null ? undefined : !pointed && shown.tone === 'missed' ? rich('strip_missed', { epoch }) : rich('strip_epoch', { epoch, result: resultText(shown.result) });
  return (
    <Readout label={t('ro_last_epochs')} value={null} sub={line} subTone={shown?.tone === 'missed' ? 'needs' : undefined} wide>
      <div className="cab-strip" role="group" aria-label={t('strip_label', { count: STRIP_EPOCHS })} onPointerLeave={() => setPointed(null)}>
        {Array.from({ length: STRIP_EPOCHS - cells.length }, (_, i) => <i key={`pad-${i}`} className="cab-cell" aria-hidden="true" />)}
        {cells.map((cell) => (
          <button
            key={cell.epoch}
            type="button"
            className="cab-cell"
            data-tone={cell.tone}
            aria-label={cellWords(cell)}
            onPointerEnter={() => setPointed(cell)}
            onFocus={() => setPointed(cell)}
            onBlur={() => setPointed(null)}
            onClick={() => setPointed(cell)}
          />
        ))}
      </div>
      {/* The strip's first and last epoch, each a link to its epoch. */}
      <span className="cab-strip-x">
        <span>{cells.length > 0 ? <EpochNumber epoch={cells[0].epoch} /> : ' '}</span>
        <span>{cells.length > 0 ? <EpochNumber epoch={cells[cells.length - 1].epoch} /> : ' '}</span>
      </span>
    </Readout>
  );
}

// An axis value with at most three significant digits: 1.13, 5,000.
const tick = (v: number) => number(Number(v.toPrecision(3)));

export function PerEpochChart({ nodeId }: { nodeId: string }) {
  const { viewOnly } = useCabinet();
  const { state } = useNodeHistory(nodeId, viewOnly);
  const data = state.phase === 'ok' ? perEpochBars(state.value.rows, BAR_EPOCHS) : null;
  // While the epochs are read the chart stands as an empty frame of its final height, so the rows under it do not move
  // when it fills (a tablet in portrait shows both at once); an answer with no amount to draw leaves it out.
  if (!data && state.phase !== 'loading') return null;
  const bars = data?.bars ?? [];
  const marker = data?.marker ?? null;
  const cols = { '--n': data ? bars.length : BAR_EPOCHS } as CSSProperties;
  const axis = data ? rich('per_epoch_axis', { from: <EpochNumber epoch={bars[0].epoch} />, to: <EpochNumber epoch={bars[bars.length - 1].epoch} /> }) : ' ';
  const label = data ? t('per_epoch_label', { from: number(bars[0].epoch), to: number(bars[bars.length - 1].epoch) }) : t('per_epoch_title');
  return (
    <Group title={t('per_epoch_title')} meta={<p className="label">{axis}</p>}>
      <figure className="cab-pe" aria-busy={data ? undefined : true}>
        <div className="cab-pe-y" aria-hidden="true">
          {data && (
            <>
              <span style={{ top: 0 }}>{tick(data.max)}</span>
              <span style={{ top: '50%' }}>{tick(data.max / 2)}</span>
              <span style={{ top: '100%' }}>0</span>
            </>
          )}
        </div>
        <div className="cab-pe-bars" style={cols} role="img" aria-label={label}>
          {bars.map((b) => (
            <span key={b.epoch} className="cab-pe-b" data-kind={b.kind} style={b.amount === null ? undefined : ({ '--h': `${(b.height * 100).toFixed(2)}%` } as CSSProperties)} />
          ))}
          {marker !== null && (
            <span className="cab-pe-mark" data-flip={marker + 1 > bars.length * 0.75 || undefined} style={{ '--at': ((marker + 1) / bars.length).toFixed(4) } as CSSProperties}>
              <span>{t('per_epoch_moved')}</span>
            </span>
          )}
        </div>
        {/* Each bar's epoch under it, a link to that epoch. */}
        <div className="cab-pe-x" style={cols}>
          {data ? bars.map((b) => <span key={b.epoch}><EpochNumber epoch={b.epoch} /></span>) : <span>{' '}</span>}
        </div>
        <figcaption className="cab-pe-key">
          <span><i data-kind="balance" />{t('per_epoch_balance')}</span>
          <span><i data-kind="moved" />{t('per_epoch_moved')}</span>
          <span><i data-kind="missed" />{t('history_missed')}</span>
          <span><i data-kind="quiet" />{t('history_unchecked')}</span>
        </figcaption>
      </figure>
    </Group>
  );
}
