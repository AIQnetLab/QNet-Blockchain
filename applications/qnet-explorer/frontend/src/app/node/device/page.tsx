import type { Metadata } from 'next';
import NodeDevices from '@/components/cabinet/NodeDevices';
import { pageMetadata } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { ...(await pageMetadata(['device_title', 'cabinet_title'])), robots: { index: false, follow: true } };
}

export default function NodeDevicePage() {
  return <NodeDevices />;
}
