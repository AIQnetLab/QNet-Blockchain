import type { MetadataRoute } from 'next';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';
import { SITE_ORIGIN } from '@/lib/hosts';
import { DEFAULT_LOCALE, LOCALES, alternates } from '@/lib/languages';

// The pages reachable from the site's navigation. Block, transaction, address and token pages are left
// out: there are as many of them as there are chain records, and they are not indexed. The Testnet page only in a
// testnet release, as the header shows it.
const PAGES = ['', '/explorer', '/explorer/tokens', '/explorer/qnc', '/wallet', '/node', '/docs', '/docs/how-it-works', '/dao', '/privacy', '/terms', '/support'];

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ACTIVATION_NETWORK === 'testnet' ? [...PAGES.slice(0, 9), '/testnet', ...PAGES.slice(9)] : PAGES;
  // Each page in every language, each entry naming the page's address in all of them (hreflang).
  return pages.flatMap((path) => {
    const { languages } = alternates(DEFAULT_LOCALE, path || '/', SITE_ORIGIN);
    return LOCALES.map((locale) => ({ url: languages[locale], alternates: { languages } }));
  });
}
