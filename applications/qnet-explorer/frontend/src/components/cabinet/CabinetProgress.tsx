'use client';

// Connect, Activate, then Link a device and Running for a light node, or Run the server and Running for a super node:
// where a wallet is on its way to a running node (src/lib/cabinet/tabs.ts journey), as four segments with a line on top
// (done Signal, now Ember, ahead a hairline). Shown only while a step after Activate is open (tabs.ts showJourney).

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

export default function CabinetProgress({ connected, view }: { connected: boolean; view: ActivationView | null }) {
  const { done, current, nodeType } = journey(connected, view);
  return (
    <ol className="cab-journey" aria-label={t('progress_label')}>
      {journeySteps(nodeType).map((step, i) => {
        const at = i === current ? 'now' : i < done ? 'done' : 'ahead';
        return (
          <li key={step} data-at={at} aria-current={at === 'now' ? 'step' : undefined}>
            <span className="cab-journey-n" aria-hidden="true">{i + 1}</span>
            <span className="cab-journey-t">{t(STEP_LABEL[step])}</span>
            {at !== 'ahead' && <span className="cab-journey-k">{t(at === 'done' ? 'progress_done' : 'progress_now')}</span>}
          </li>
        );
      })}
    </ol>
  );
}
