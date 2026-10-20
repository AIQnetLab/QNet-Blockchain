// How it works in short, apart from the connect card and quieter than it: the three ways, each opened by its title to
// three to five steps (a light node from a phone, only while the site pays from a phone; a light node from a computer; a
// super node, only with the QNet extension, which QNet Wallet with the same wallet then shows), and the full guide (in
// the header's Docs menu too).

import Action from '@/components/ui/Action';
import { t, type MessageKey } from '@/lib/texts';
import { SHORT_COMPUTER, SHORT_PHONE, SHORT_SUPER } from '@/lib/cabinet/guide';
import { GUIDE_HREF } from '@/lib/cabinet/tabs';

function Way({ title, steps, closed }: { title: MessageKey; steps: MessageKey[]; closed?: MessageKey }) {
  return (
    <details className="cab-guide">
      <summary className="cab-guide-t">{t(title)}</summary>
      {closed ? <p className="note">{t(closed)}</p> : <ol>{steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>}
    </details>
  );
}

export default function GuideSummary({ phoneFlows }: { phoneFlows: boolean }) {
  return (
    <aside className="cab-guides" aria-labelledby="guide-short-heading">
      <h2 className="label" id="guide-short-heading">{t('guide_title')}</h2>
      <Way title="guide_path_phone" steps={SHORT_PHONE} closed={phoneFlows ? undefined : 'guide_phone_closed'} />
      <Way title="guide_path_computer" steps={SHORT_COMPUTER} />
      <Way title="guide_path_super" steps={SHORT_SUPER} />
      <Action href={GUIDE_HREF}>{t('guide_full')}</Action>
    </aside>
  );
}
