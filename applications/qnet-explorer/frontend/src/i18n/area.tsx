// A part of the site's texts for the pages below it, in the page's language (src/i18n/areas.ts): sent with the page's
// data once, kept while the visitor moves between that part's pages.

import { I18nArea } from './client';
import { areaTexts, type Area } from './areas';
import { CATALOGS } from './catalogs';
import { getLocale } from './server';

// React.ReactNode is the children type Next.js checks a layout against; a fragment takes it as it is, a component typed
// with react's own ReactNode does not.
export default async function AreaTexts({ area, children }: { area: Area; children: React.ReactNode }) {
  return <I18nArea messages={areaTexts(CATALOGS[await getLocale()], area)}><>{children}</></I18nArea>;
}
