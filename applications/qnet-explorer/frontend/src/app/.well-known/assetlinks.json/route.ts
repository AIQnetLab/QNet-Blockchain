import { assetLinks, wellKnownResponse } from '@/lib/app-links';

// Android App Links: the apps allowed to open https://link.aiqnet.io/l (src/lib/app-links.ts).
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return wellKnownResponse(assetLinks());
}
