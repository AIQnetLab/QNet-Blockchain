// The wallet's consent to register its light node, as the page posts it to POST /api/cabinet/register (shared contract
// C4). For a payment address's burn: the consent body, with nothing of the payment key, which the site completes with
// the owner bind its record keeps. The activation page posts it from its record (activation.ts), and any other page
// where the wallet is connected posts it with QNet Wallet's fresh consent (NextSteps.tsx FinishLight), with no payment
// key in the browser. For a burn made from the wallet's own Solana address: the own-burn body, the consent with that
// address and the owner bind QNet Wallet signed with its Solana key beside the consent (`consent.ownerSig`). Loads no
// key module.

import { ED25519_SIGNATURE_BYTES, MLDSA65_PUBLIC_KEY_BYTES, MLDSA65_SIGNATURE_BYTES, bytesToHex, decodeB64url, type Consent } from '../qnet-link.ts';
import { SUBMIT_KEYS, buildConsentBody, parseSubmitOutcome, type ConsentBody, type SubmitBody, type SubmitOutcome } from './registration.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// The consent body of `qnet`'s consent {ts, pk, sig} (base64url key and signature) to `burnTx` of `burnAmount`.
export function consentBodyOf(qnet: string, consent: { ts: string | number; pk: string; sig: string }, burnTx: string, burnAmount: number): ConsentBody {
  const pk = decodeB64url(consent.pk, MLDSA65_PUBLIC_KEY_BYTES);
  const sig = decodeB64url(consent.sig, MLDSA65_SIGNATURE_BYTES);
  if (!pk || !sig) throw new Error('consent');
  return buildConsentBody({ qnet, consentTs: Number(consent.ts), consentPk: pk, consentSig: sig, burnTx, burnAmount });
}

// The own-burn body of `qnet`'s consent to `burnTx` of `burnAmount`, made from its own Solana address `burner`: the
// consent body with the burner and the owner bind of `consent.ownerSig` (base64url, as 128 hex), in the node's order.
export function ownBurnBodyOf(qnet: string, consent: Consent, burnTx: string, burnAmount: number, burner: string): SubmitBody {
  const owner = decodeB64url(consent.ownerSig, ED25519_SIGNATURE_BYTES);
  if (!owner) throw new Error('consent');
  const full: Record<string, unknown> = { ...consentBodyOf(qnet, consent, burnTx, burnAmount), burn_wallet: burner, owner_signature: bytesToHex(owner) };
  return Object.fromEntries(SUBMIT_KEYS.map((k) => [k, full[k]])) as unknown as SubmitBody;
}

// POST /api/cabinet/register with the consent or own-burn body; the route's answer as an outcome.
export async function postConsent(body: ConsentBody | SubmitBody, { fetchFn }: { fetchFn: FetchLike }): Promise<SubmitOutcome> {
  let status: number;
  let answer: unknown = null;
  try {
    const res = await fetchFn('/api/cabinet/register', {
      cache: 'no-store', credentials: 'omit', redirect: 'error', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    status = res.status;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
  } catch {
    return { result: 'retry', code: 'network' };
  }
  if (status === 429) return { result: 'retry', code: 'rate_limited' };
  if (status === 400) return { result: 'refused', code: 'bad_request' };
  return (status === 200 && parseSubmitOutcome(answer)) || { result: 'retry', code: `http_${status}` };
}
