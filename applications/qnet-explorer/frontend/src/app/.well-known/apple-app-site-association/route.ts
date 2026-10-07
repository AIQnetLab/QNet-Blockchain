import { appleAppSiteAssociation, wellKnownResponse } from '@/lib/app-links';

// iOS Universal Links: the app allowed to open https://link.aiqnet.io/l (src/lib/app-links.ts).
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return wellKnownResponse(appleAppSiteAssociation());
}
