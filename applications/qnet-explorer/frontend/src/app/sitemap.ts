import type { MetadataRoute } from 'next';
import { ACTIVATION_NETWORK } from '@/lib/one-dev';

// The pages reachable from the site's navigation. Block, transaction, address and token pages are left
// out: there are as many of them as there are chain records, and they are not indexed. The Testnet page only in a
// testnet release, as the header shows it (SITE-F14).
const PAGES = ['', '/explorer', '/explorer/tokens', '/explorer/qnc', '/wallet', '/node', '/docs', '/docs/how-it-works', '/dao', '/privacy', '/terms', '/support'];

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ACTIVATION_NETWORK === 'testnet' ? [...PAGES.slice(0, 9), '/testnet', ...PAGES.slice(9)] : PAGES;
  return pages.map((path) => ({ url: `https://aiqnet.io${path}` }));
}
