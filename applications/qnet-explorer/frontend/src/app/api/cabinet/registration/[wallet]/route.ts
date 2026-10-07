import { query } from '../../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';
import type { BurnChecker } from '@/server/cabinet/activation-registry';
import { checkBurn } from '@/server/cabinet/burn-scan';
import { RECORD_SQL, cabinetRecordReader, type BurnRowReader } from '@/server/cabinet/registration-record';
import { sharedSolanaRpc } from '@/server/solana-endpoint';

// The node cabinet: a wallet's light node registration (or with ?type=super its super node's) as the explorer archived
// it, its burn facts, and whose burn it is: the wallet's row in the activation registry, else the burn on Solana
// (src/server/cabinet/registration-record.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const lookup = async (from: string) => (await query<{ block: string; data: unknown }>(RECORD_SQL, [from])).rows;
const row: BurnRowReader = (wallet) => activationApi((text, values) => query(text, values)).paymentRecord(wallet);
const check: BurnChecker = (burnTx, expect) => checkBurn(sharedSolanaRpc(), burnTx, expect);

export async function GET(request: Request, { params }: { params: Promise<{ wallet: string }> }): Promise<Response> {
  const { wallet } = await params;
  return cabinetRecordReader(lookup, { row, check }).read(request, wallet, new URL(request.url).searchParams.get('type'));
}
