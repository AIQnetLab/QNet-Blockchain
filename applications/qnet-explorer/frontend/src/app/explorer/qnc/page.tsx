import { GET as activityRoute } from '@/app/api/activity/route';
import { GET as qncRoute } from '@/app/api/qnc/route';
import { QNC_PATH, QNC_TRANSFERS_PATH } from '@/lib/explorer-reads';
import { firstAnswer, nodeAnswer } from '@/server/first-answer';
import QncClient from './QncClient';

// The page renders with the transfers' first answer from the explorer's index and the node's rich list as last kept
// (never waited for), so its readouts and tables have their final rows from the first paint; the client keeps them
// current.
export const dynamic = 'force-dynamic';

export default async function QncPage() {
  return <QncClient first={{ qnc: nodeAnswer(qncRoute, QNC_PATH), transfers: await firstAnswer(activityRoute, QNC_TRANSFERS_PATH) }} />;
}
