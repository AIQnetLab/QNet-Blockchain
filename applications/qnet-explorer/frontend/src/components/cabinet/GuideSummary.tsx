// How it works in short, beside the connect screen: the three ways in three or four big steps each (a light node from a
// phone, only while the site pays from a phone; a light node from a computer; a super node, only with the QNet
// extension), and the full guide (in the header's Docs menu too).

import Link from 'next/link';
import { t, type MessageKey } from '@/lib/texts';
import { SHORT_COMPUTER, SHORT_PHONE, SHORT_SUPER } from '@/lib/cabinet/guide';
import { GUIDE_HREF } from '@/lib/cabinet/tabs';

function Way({ title, steps, closed }: { title: MessageKey; steps: MessageKey[]; closed?: MessageKey }) {
  return (
    <div className="guide-short-way">
      <h4 className="guide-short-title">{t(title)}</h4>
      {closed ? (
        <p className="activate-note">{t(closed)}</p>
      ) : (
        <ol className="guide-short-steps">
          {steps.map((step, i) => (
            <li key={step}>
              <span className="guide-number" aria-hidden="true">{i + 1}</span>
              <span>{t(step)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function GuideSummary({ phoneFlows }: { phoneFlows: boolean }) {
  return (
    <aside className="activate-card guide-short" aria-labelledby="guide-short-heading">
      <h3 className="activate-step" id="guide-short-heading">{t('guide_title')}</h3>
      <Way title="guide_path_phone" steps={SHORT_PHONE} closed={phoneFlows ? undefined : 'guide_phone_closed'} />
      <Way title="guide_path_computer" steps={SHORT_COMPUTER} />
      <Way title="guide_path_super" steps={SHORT_SUPER} />
      <Link href={GUIDE_HREF} className="qnet-button secondary">{t('guide_full')}</Link>
    </aside>
  );
}
