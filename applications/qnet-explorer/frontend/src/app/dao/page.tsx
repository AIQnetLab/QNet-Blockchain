// The DAO page says what exists: no governance runs on QNet Blockchain yet, so there are no proposals to list and no
// votes to take (the vote route refuses every vote unless DAO_ENABLED is set). Protocol changes ship as node releases
// whose activation heights live in the node software. A server component: nothing on it changes in the browser.

import { Link } from '@/i18n/client';
import { getI18n } from '@/i18n/server';
import PageHead from '@/components/ui/PageHead';

const REPO = 'https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet';

export default async function DaoPage() {
  const { t, say, rich } = await getI18n();
  return (
    <div className="pg">
      <PageHead title={say('dao_title')} lead={say('dao_lead')} />
      <div className="wrap pg-body">
        <section className="doc-sec" id="changes">
          <h2>{t('dao_changes_title')}</h2>
          <div className="prose">
            <p>{t('dao_changes_p1')}</p>
            <p>
              {rich('dao_changes_p2', {
                guide: <a href={`${REPO}/docs/operators/maintenance.md#upgrading-a-node`} target="_blank" rel="noopener noreferrer">{t('dao_guide_link')}</a>,
                docs: <Link href="/docs">{t('dao_docs_link')}</Link>,
              })}
            </p>
          </div>
        </section>
        <section className="doc-sec" id="design">
          <h2>{t('dao_design_title')}</h2>
          <div className="prose">
            <p>{rich('dao_design_p', { folder: <a href={`${REPO}/governance`} target="_blank" rel="noopener noreferrer">{t('dao_folder_link')}</a> })}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
