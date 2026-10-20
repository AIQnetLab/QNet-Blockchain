import type { Metadata } from 'next';
import { SITE_ORIGIN } from '@/lib/hosts';
import { rich } from '@/lib/rich';
import { pageTitle, t } from '@/lib/texts';

// https://link.aiqnet.io/send#… fills a transfer into QNet Wallet's Send (docs/protocols/qnet-link-v1.md section 15). A
// browser shows this page when it keeps the link: no app, an app too old for it, another app's browser, and as the
// fallback of the cabinet's Android button. Static: it never reads its URL, so the transfer in the fragment goes nowhere.
export const metadata: Metadata = { title: pageTitle('send_title'), robots: { index: false, follow: false } };

export default function TransferLinkPage() {
  const activatePage = <a href={`${SITE_ORIGIN}/node/activate`}>aiqnet.io/node/activate</a>;
  return (
    <div className="pg pg-bare">
      {/* The title band without the field: these pages render alone, with no script of the site's around them. */}
      <div className="page-head">
        <div className="wrap page-head-in">
          <h1 className="page-title">{t('send_title')}</h1>
          <p className="lead">{t('send_subtitle')}</p>
        </div>
      </div>
      <div className="wrap pg-body">
        <div className="prose">
          <p>{t('send_lead')}</p>
          <ul>
            <li>{rich('send_reason_missing', { walletPage: <a href={`${SITE_ORIGIN}/wallet`}>{t('l_wallet_page')}</a>, activatePage })}</li>
            <li>{rich('send_reason_update', { activatePage })}</li>
            <li>{rich('send_reason_embedded', { activatePage })}</li>
          </ul>
          <p>{rich('send_by_hand', { activatePage })}</p>
          <p className="note">{t('send_only_yours')}</p>
        </div>
      </div>
    </div>
  );
}
