import { GET as addressRoute } from '@/app/api/address/[address]/route';
import { addressPath } from '@/lib/explorer-reads';
import { firstAnswer } from '@/server/first-answer';
import AddressClient from './AddressClient';

// The page renders with the address route's answer, so its notes and tables are there from the first paint.
export const dynamic = 'force-dynamic';

export default async function AddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <AddressClient first={await firstAnswer(addressRoute, addressPath(address), { address })} />;
}
