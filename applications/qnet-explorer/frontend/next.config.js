const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // The workspace root, stated: with several lockfiles in the repository Next guesses the repository
  // root instead, and then bundles `pg` from the workspace's node_modules rather than leaving it
  // external — which breaks every page in development with "Can't resolve 'fs'".
  outputFileTracingRoot: path.join(__dirname, '..'),
  // Client-side Router Cache: reuse a visited route's payload on back-navigation
  // (instant tab-switch). Live data is refreshed by each page's own client polling.
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
  },
  compiler: {
    // Server logs ([LEVEL][SUBSYSTEM] lines) go through console; keep them in the build.
    removeConsole: false,
  },
  // Server-side packages that should not be bundled
  serverExternalPackages: ['ws', 'pg'],
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "source.unsplash.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "ext.same-assets.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "ugc.same-assets.com",
        pathname: "/**",
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  poweredByHeader: false,
  compress: true,
  // Old links to removed pages land somewhere real: the old node page goes to the explorer, and the old activation
  // page (named in the extension's texts) to the node cabinet's (308). My node's sections before 29.09
  // (src/lib/cabinet/tabs.ts MOVED_PAGES): Devices is the Device tab, Node balance and Activation code are on the
  // Overview (307, personal pages that may move again), and How it works moved to the Docs menu (308, an indexed page).
  // A query, such as the guide's ?way=, goes along.
  async redirects() {
    return [
      { source: '/nodes', destination: '/explorer', permanent: true },
      { source: '/activate', destination: '/node/activate', permanent: true },
      { source: '/node/devices', destination: '/node/device', permanent: false },
      { source: '/node/claim', destination: '/node?tab=overview', permanent: false },
      { source: '/node/code', destination: '/node?tab=overview', permanent: false },
      { source: '/node/guide', destination: '/docs/how-it-works', permanent: true },
    ];
  },
  // Pages get their Content-Security-Policy, with a per-request nonce, from src/proxy.ts.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
      {
        // API responses are data, never documents: nothing in them may load or run.
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
