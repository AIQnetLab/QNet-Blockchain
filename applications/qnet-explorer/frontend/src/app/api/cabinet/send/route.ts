import { query } from '../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';
import { solanaProxy } from '@/server/cabinet/solana-proxy';

// The node cabinet: forwards a payment key's burn, announced first under the wallet's reservation with the payment key's
// owner bind of that wallet, or its refund, and nothing else (src/server/cabinet/solana-proxy.ts, activation-api.ts). A
// refund earns a read pass only from a payment address a reservation named.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const api = activationApi((text, values) => query(text, values));
  return solanaProxy().send(
    request,
    (reservation, burner, amount, burnTx, ownerSig) => api.announcePayment(reservation, burner, amount, burnTx, ownerSig),
    (payer) => api.knowsPaymentBurner(payer),
  );
}
