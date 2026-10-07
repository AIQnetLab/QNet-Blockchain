import "./globals.css";
import "./mobile-fixes.css";

import { headers } from 'next/headers';
import { ThemeProvider } from "@/components/theme/theme-provider";
import SiteShell from '@/components/SiteShell';
import { LINK_HOST, requestHost } from '@/lib/hosts';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'QNet - Post-Quantum Blockchain',
  description: 'An experimental blockchain designed by one person and built with AI assistance. No funding. No team. No corporate backing. The architecture and every protocol decision are one person\'s; the code is written with AI tools under that direction.',
  keywords: 'blockchain, quantum-resistant, post-quantum, cryptocurrency, decentralized, QNet',
  authors: [{ name: 'Orrery Group LLC', url: 'https://aiqnet.io' }],
  creator: 'Orrery Group LLC',
  publisher: 'Orrery Group LLC',
  robots: 'index, follow',
  // The QNet icon at the sizes browsers ask for (each file is that size): /favicon.ico (16, 32 and 48) first, which every
  // browser also requests by itself, then the PNGs; the 180 px one for iPhone and iPad home screens.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/icon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icon-128.png', sizes: '128x128', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  metadataBase: new URL('https://aiqnet.io'),
  // './' resolves against each page's own path, so every page names itself without its query string.
  alternates: { canonical: './' },
  openGraph: {
    title: 'QNet - Post-Quantum Blockchain',
    description: 'The next generation of decentralized technology with quantum resistance.',
    url: 'https://aiqnet.io',
    siteName: 'QNet',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QNet - Post-Quantum Blockchain',
    description: 'The next generation of decentralized technology with quantum resistance.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reading the request renders every page per request, so each response carries its own CSP nonce
  // (src/proxy.ts), which Next.js puts on its scripts. The site has no inline scripts of its own.
  // Any page rendered for the link host renders without the site's shell (SiteShell): the link page, and
  // any other page a request there could reach past the proxy's host rule (SITE-R4-CSP-01).
  const onLinkHost = requestHost((await headers()).get('host')) === LINK_HOST;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body suppressHydrationWarning className="font-sans antialiased quantum-bg">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {/* The wallet context, header and footer for the site's pages; the link page and the link host alone (SiteShell). */}
          <SiteShell onLinkHost={onLinkHost}>{children}</SiteShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
