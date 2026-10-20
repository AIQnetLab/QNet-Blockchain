import type { Metadata } from 'next';
import { SITE_ORIGIN } from '@/lib/hosts';
import { rich } from '@/lib/rich';
import { pageTitle, t } from '@/lib/texts';
import LinkButtons from './LinkButtons';

// https://link.aiqnet.io/l#v1.… is a request for the QNet app (docs/protocols/qnet-link-v1.md sections 4 and 14.3). A
// browser shows this page when it keeps the link itself, when the app is not installed, or as the
// fallback of the site's Android button. The request is in the fragment, which never reaches the server;
// only LinkButtons reads it, to offer the Android button, and sends it nowhere. The page renders outside
// the site's shell (src/components/SiteShell.tsx): no wallet context, wallet control or navigation runs here.
// It names the three reasons a browser shows it (unified plan SITE-8): no app, an app too old for the request,
// another app's browser. Its texts are the l_ keys (src/lib/texts.ts).
export const metadata: Metadata = { title: pageTitle('l_title'), robots: { index: false, follow: false } };

export default function LinkPage() {
  const nodePage = <a href={`${SITE_ORIGIN}/node`}>aiqnet.io/node</a>;
  return (
    <div className="pg pg-bare">
      {/* The title band without the field: these pages render alone, with no script of the site's around them. */}
      <div className="page-head">
        <div className="wrap page-head-in">
          <h1 className="page-title">{t('l_title')}</h1>
          <p className="lead">{t('l_subtitle')}</p>
        </div>
      </div>
      <div className="wrap pg-body">
        <LinkButtons lead={t('l_button_lead')} button={t('link_open_app')} note={t('l_button_note')} />
        <div className="prose">
          <p>{t('l_lead')}</p>
          <ul>
            <li>{rich('l_reason_missing', { walletPage: <a href={`${SITE_ORIGIN}/wallet`}>{t('l_wallet_page')}</a>, nodePage })}</li>
            <li>{rich('l_reason_update', { nodePage })}</li>
            <li>{t('l_reason_embedded')}</li>
          </ul>
          <p className="note">{t('l_only_yours')}</p>
        </div>
      </div>
    </div>
  );
}
