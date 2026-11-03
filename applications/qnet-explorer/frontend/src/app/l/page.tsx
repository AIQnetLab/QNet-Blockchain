import type { Metadata } from 'next';
import { SITE_ORIGIN } from '@/lib/hosts';
import { getI18n, pageMetadata } from '@/i18n/server';
import LinkButtons from './LinkButtons';

// https://link.aiqnet.io/l#v1.… is a request for the QNet app (docs/protocols/qnet-link-v1.md sections 4 and 14.3). A
// browser shows this page when it keeps the link itself, when the app is not installed, or as the
// fallback of the site's Android button. The request is in the fragment, which never reaches the server;
// only LinkButtons reads it, to offer the Android button, and sends it nowhere. The page renders outside
// the site's shell (src/components/SiteShell.tsx): no wallet context, wallet control or navigation runs here.
// It names the three reasons a browser shows it: no app, an app too old for the request,
// another app's browser. Its texts are the l_ keys (src/i18n/locales/en.ts), in the visitor's language
// (src/lib/locale-route.ts).
export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMetadata(['l_title'])), robots: { index: false, follow: false } };
}

export default async function LinkPage() {
  const { t, say, rich, href } = await getI18n();
  const nodePage = <a href={`${SITE_ORIGIN}${href('/node')}`} translate="no">aiqnet.io/node</a>;
  return (
    <div className="pg pg-bare">
      {/* The title band without the field: these pages render alone, with no script of the site's around them. */}
      <div className="page-head">
        <div className="wrap page-head-in">
          <h1 className="page-title">{say('l_title')}</h1>
          <p className="lead">{say('l_subtitle')}</p>
        </div>
      </div>
      <div className="wrap pg-body">
        <LinkButtons lead={say('l_button_lead')} button={say('link_open_app')} note={say('l_button_note')} />
        <div className="prose">
          <p>{say('l_lead')}</p>
          <ul>
            <li>{rich('l_reason_missing', { walletPage: <a href={`${SITE_ORIGIN}${href('/wallet')}`}>{t('l_wallet_page')}</a>, nodePage })}</li>
            <li>{rich('l_reason_update', { nodePage })}</li>
            <li>{t('l_reason_embedded')}</li>
          </ul>
          <p className="note">{t('l_only_yours')}</p>
        </div>
      </div>
    </div>
  );
}
