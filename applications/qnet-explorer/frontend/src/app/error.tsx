'use client';

// A page that throws in the browser shows this instead of a blank screen; the header and footer stay. Its words are the
// shell's texts the page already holds, so it shows at once in the page's language.

import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';
import { useT } from '@/i18n/client';
import { LAST_RESORT } from '@/i18n/last-resort';

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <div className="pg">
      <PageHead title={t('error_title')} lead={t('error_lead')}>
        <div className="pg-act" data-field-clear>
          <Action kind="solid" onClick={() => reset()}>{t('try_again')}</Action>
          <Action onClick={() => window.location.reload()}>{LAST_RESORT[t.locale].reload}</Action>
        </div>
      </PageHead>
    </div>
  );
}
