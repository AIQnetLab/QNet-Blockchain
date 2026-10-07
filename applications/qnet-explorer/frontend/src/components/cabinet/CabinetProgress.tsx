'use client';

// Connect, Activate, then Link a device and Running for a light node, or Run the server and Running for a super node:
// where a wallet is on its way to a running node (src/lib/cabinet/tabs.ts journey, from the wallet's activation view).

import { t, type MessageKey } from '@/lib/texts';
import { journey, journeySteps, type JourneyStep } from '@/lib/cabinet/tabs';
import type { ActivationView } from '@/lib/cabinet/wallet-activation';

const STEP_LABEL: Record<JourneyStep, MessageKey> = {
  connect: 'progress_connect',
  activate: 'progress_activate',
  link: 'progress_link',
  server: 'progress_server',
  running: 'progress_running',
};

// Each step done, the one to do now, or still ahead.
export default function CabinetProgress({ connected, view }: { connected: boolean; view: ActivationView | null }) {
  const { done, current, nodeType } = journey(connected, view);
  return (
    <ol className="cabinet-progress" aria-label={t('progress_label')}>
      {journeySteps(nodeType).map((step, i) => {
        const at = i === current ? 'now' : i < done ? 'done' : 'ahead';
        return (
          <li key={step} className={`cabinet-progress-step ${at}`} aria-current={at === 'now' ? 'step' : undefined}>
            <span className="cabinet-progress-dot" aria-hidden="true">{i + 1}</span>
            <span className="cabinet-progress-name">{t(STEP_LABEL[step])}</span>
            {at !== 'ahead' && <span className="cabinet-hidden-text">{t(at === 'done' ? 'progress_done' : 'progress_now')}</span>}
          </li>
        );
      })}
    </ol>
  );
}
