import { query } from '../../../../../lib/db';
import { activationApi } from '@/server/cabinet/activation-api';
import { cabinetRegister, type OwnBurnScan, type PaymentRecordReader, type WalletNodeReader } from '@/server/cabinet/register';
import { walletNode as sharedWalletNode } from '@/server/cabinet/wallet-node';
import { verifyConsent } from '@/lib/cabinet/consent-verify';

// The node cabinet: a light node's registration with the wallet's consent, completed from the wallet's payment burn in
// the activation registry, or for a burn made from the wallet's own Solana address checked against that address's burns
// and the network's one-node rule, and submitted to one genesis node (src/server/cabinet/register.ts).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const api = () => activationApi((text, values) => query(text, values));
const paymentRecord: PaymentRecordReader = (wallet) => api().paymentRecord(wallet);
// A signed request, like a reservation: the reservation's lane of the search, which anonymous reads cannot starve,
// charged to the register client and the node first.
const scan: OwnBurnScan = (address, clients) => api().scan(address, undefined, 'reserve', clients);
const walletNode: WalletNodeReader = (wallet) => sharedWalletNode().check(wallet, 'reserve');

export async function POST(request: Request): Promise<Response> {
  return cabinetRegister(verifyConsent, paymentRecord, { scan, walletNode }).submit(request);
}
