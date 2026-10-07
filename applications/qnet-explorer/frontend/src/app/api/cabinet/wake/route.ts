import { cabinetWake } from '@/server/cabinet/wake';

// The node cabinet: "I'm back", one silent push to the device linked to a light node (src/server/cabinet/wake.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return cabinetWake().wake(request);
}
