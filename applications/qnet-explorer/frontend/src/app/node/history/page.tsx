import type { Metadata } from 'next';
import NodeHistory from '@/components/cabinet/NodeHistory';
import { pageTitle } from '@/lib/texts';

export const metadata: Metadata = { title: pageTitle('history_title', 'cabinet_title'), robots: { index: false, follow: true } };

export default function NodeHistoryPage() {
  return <NodeHistory />;
}
