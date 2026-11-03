// The stylesheets in cascade order: tokens, the base and shared primitives, the rules of areas not yet rebuilt, then
// one sheet per area (shell, home, explorer, My node, the other pages), and last the page's language (i18n.css).
import '@/styles/tokens.css';
import '@/styles/base.css';
import '@/styles/shell.css';
import '@/styles/home.css';
import '@/styles/explorer.css';
import '@/styles/cabinet.css';
import '@/styles/pages.css';
import '@/styles/i18n.css';

import { headers } from 'next/headers';
import { ThemeProvider } from "@/components/theme/theme-provider";
import SiteShell from '@/components/SiteShell';
import { LINK_HOST, requestHost } from '@/lib/hosts';
import { installTarget } from '@/lib/install-target';
import { areaTexts } from '@/i18n/areas';
import { I18nProvider } from '@/i18n/client';
import { getI18n, localeAlternates, ogLocale } from '@/i18n/server';
import { archivo, cyrillic, martian } from './fonts';
import type { Metadata, Viewport } from 'next';

// The site's head in the page's language: its description, its address in every language (hreflang) and its own
// canonical address. A page sets its own title; the icons are the same in every language.
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getI18n();
  return {
    title: 'QNet Blockchain',
    description: t('meta_description'),
    keywords: t('meta_keywords'),
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
    alternates: await localeAlternates(),
    openGraph: {
      title: 'QNet Blockchain',
      description: t('home_deck'),
      url: 'https://aiqnet.io',
      siteName: 'QNet Blockchain',
      locale: ogLocale(locale),
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'QNet Blockchain',
      description: t('home_deck'),
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#05080A',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reading the request renders every page per request, so each response carries its own CSP nonce
  // (src/proxy.ts), which Next.js puts on its scripts. The site has no inline scripts of its own.
  // Any page rendered for the link host renders without the site's shell (SiteShell): the link page, and
  // any other page a request there could reach past the proxy's host rule.
  const request = await headers();
  const onLinkHost = requestHost(request.get('host')) === LINK_HOST;
  // Device-dependent layouts (the store to install from) are decided at first paint from the request; the shell
  // corrects only an iPad in desktop mode, which only the page can tell by its touch points.
  const device = installTarget(request.get('user-agent'));
  // The page's language from its address (src/proxy.ts); Arabic reads right to left. The browser gets that language's
  // shell texts with the page's data (each part of the site adds its own, src/i18n/areas.ts); a move to another page of
  // the site keeps the layout and sends them no second time.
  const { locale, dir, t } = await getI18n();
  return (
    <html lang={locale} dir={dir} data-device={device} className={`${archivo.variable} ${cyrillic.variable} ${martian.variable}`} suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body suppressHydrationWarning>
        {/* data-theme, not class: the class list of <html> carries the font variables. */}
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {/* The wallet context, header and footer for the site's pages; the link page and the link host alone (SiteShell). */}
          <I18nProvider locale={locale} messages={areaTexts(t.catalog, 'shell')}>
            <SiteShell onLinkHost={onLinkHost}>{children}</SiteShell>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
