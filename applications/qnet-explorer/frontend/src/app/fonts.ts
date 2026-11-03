import { Archivo, Martian_Mono, Roboto } from 'next/font/google';
import '@/styles/fonts.css';

// The site's faces, self-hosted by next/font from /_next/static/media (font-src 'self'): Archivo for display and body,
// Martian Mono for numbers, hashes, labels and tables. Both carry their width axis, which the type scale uses. While
// they load, text is set in the stand-ins of styles/fonts.css, sized for every width and weight the sheets use, so
// nothing moves when a face arrives; the stacks with the stand-ins and each script's faces are in styles/tokens.css.
// `subsets` names what is preloaded: Latin, no italic, so the two preloaded files stay within about 140 KB (the Latin
// subset carries the accents of the site's texts). next/font self-hosts every subset a face has, each under its
// unicode-range, so Martian Mono's Cyrillic file is fetched only by a page that shows Cyrillic in it.
export const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  style: ['normal'],
  display: 'swap',
  adjustFontFallback: false,
  variable: '--font-archivo',
});

export const martian = Martian_Mono({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  adjustFontFallback: false,
  variable: '--font-martian',
});

// Archivo has no Cyrillic: Russian text takes Roboto's Cyrillic, with a width axis too, after Archivo in the Russian
// stack, so Latin stays Archivo. Not preloaded: its file loads only where Cyrillic is shown.
export const cyrillic = Roboto({
  subsets: ['cyrillic'],
  axes: ['wdth'],
  style: ['normal'],
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  variable: '--font-cyrillic',
});
