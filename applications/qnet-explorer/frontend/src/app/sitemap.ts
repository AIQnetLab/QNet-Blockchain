import type { MetadataRoute } from 'next';

// The pages reachable from the site's navigation. Block, transaction, address and token pages are left
// out: there are as many of them as there are chain records, and they are not indexed.
const PAGES = ['', '/explorer', '/explorer/tokens', '/explorer/qnc', '/wallet', '/docs', '/dao', '/testnet', '/privacy', '/terms', '/support'];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((path) => ({ url: `https://aiqnet.io${path}` }));
}
