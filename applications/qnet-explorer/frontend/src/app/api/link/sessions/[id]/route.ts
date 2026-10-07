import { linkRelay } from '@/server/link-relay';

// QNet Link relay: the app reads the session it was sent (docs/protocols/qnet-link-v1.md section 5.2); the page that
// made it ends it early when it cancels or replaces the request (src/server/link-relay.ts releaseSession).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return linkRelay().getSession(request, id);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return linkRelay().releaseSession(request, id);
}
