// The site's 404 page, in the document layout: the explorer's search in the title band (a mistyped hash or address is
// the usual reason) and the explorer itself, a page of the QNet app's view too (the header's wordmark already leads
// home). It brings no part of the shell with it and reads no wallet state: the root layout decides the shell by host.

import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';
import ExplorerSearch from '@/components/explorer/ExplorerSearch';
import { getI18n, pageMetadata } from '@/i18n/server';

// The tab names the page in its language, as every page's title does.
export const generateMetadata = () => pageMetadata(['notfound_title'], 'notfound_lead');

export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <div className="pg">
      <PageHead title={t('notfound_title')} lead={t('notfound_lead')}>
        <ExplorerSearch />
      </PageHead>
      <div className="wrap pg-body">
        <Action href="/explorer">{t('notfound_explorer')}</Action>
      </div>
    </div>
  );
}
