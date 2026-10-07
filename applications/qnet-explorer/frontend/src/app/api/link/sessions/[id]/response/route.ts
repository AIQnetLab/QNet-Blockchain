import { linkRelay } from '@/server/link-relay';

// QNet Link relay: the app posts its encrypted answer, the page polls for it
// (docs/protocols/qnet-link-v1.md sections 5.3 and 5.4).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return linkRelay().postAnswer(request, id);
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return linkRelay().getAnswer(request, id);
}
