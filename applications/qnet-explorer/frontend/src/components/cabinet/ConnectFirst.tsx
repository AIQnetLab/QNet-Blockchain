'use client';

// In place of an action that the wallet itself must confirm, while the page only views a typed address: connect the
// wallet first. My node then shows its connect screen, or the extension's wallet it takes up; this is no Disconnect.

import { t } from '@/lib/texts';
import { useCabinet } from './CabinetProvider';

export default function ConnectFirst() {
  const { leaveView } = useCabinet();
  return (
    <div className="cabinet-choice">
      <p className="activate-note">{t('connect_first')}</p>
      <button type="button" className="qnet-button activate-primary" onClick={leaveView}>{t('connect_first_button')}</button>
    </div>
  );
}
