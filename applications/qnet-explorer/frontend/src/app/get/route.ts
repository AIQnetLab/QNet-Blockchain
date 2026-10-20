// GET /get: the one link printed as a QR code. A phone or tablet goes straight to its store; a computer, or an iPad
// in desktop mode (a Mac user agent), to the page that lists every way and tells an iPad from a Mac by touch.

import { NextResponse } from 'next/server';
import { GET_PAGE_PATH, installTarget, storeUrl } from '@/lib/install-target';

export const dynamic = 'force-dynamic';

// The page is named by a relative Location: behind the proxy request.url carries the server's own bind address.
export function GET(request: Request): NextResponse {
  const target = storeUrl(installTarget(request.headers.get('user-agent')));
  return new NextResponse(null, {
    status: 302,
    headers: { Location: target ?? GET_PAGE_PATH, 'Cache-Control': 'no-store', Vary: 'User-Agent' },
  });
}
