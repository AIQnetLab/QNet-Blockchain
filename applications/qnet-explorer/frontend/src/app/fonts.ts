import { Archivo, Martian_Mono } from 'next/font/google';
import '@/styles/fonts.css';

// The site's two faces, self-hosted by next/font from /_next/static/media (font-src 'self'): Archivo for display and
// body, Martian Mono for numbers, hashes, labels and tables. Both carry their width axis, which the type scale uses.
// While they load, text is set in the stand-ins of styles/fonts.css, sized for every width and weight the sheets use, so
// nothing moves when a face arrives. Latin only and no italic, so the two preloaded files stay within about 140 KB (the
// Latin subset carries the accents of the site's texts).
export const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  style: ['normal'],
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['Archivo Stand-in', 'Archivo Stand-in R'],
  variable: '--font-archivo',
});

export const martian = Martian_Mono({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['Martian Stand-in'],
  variable: '--font-martian',
});
