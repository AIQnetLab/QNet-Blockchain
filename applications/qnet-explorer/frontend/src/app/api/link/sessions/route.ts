import { linkRelay } from '@/server/link-relay';

// QNet Link relay: the page opens a session (docs/protocols/qnet-link-v1.md section 5.1). The store is
// this process's memory, so the route runs on Node.js and never statically.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return linkRelay().createSession(request);
}
