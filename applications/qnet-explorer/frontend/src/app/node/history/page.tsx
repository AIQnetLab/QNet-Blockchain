import type { Metadata } from 'next';
import NodeHistory from '@/components/cabinet/NodeHistory';
import { pageMetadata } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMetadata(['history_title', 'cabinet_title'])), robots: { index: false, follow: true } };
}

export default function NodeHistoryPage() {
  return <NodeHistory />;
}
