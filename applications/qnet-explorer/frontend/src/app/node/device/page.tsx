import type { Metadata } from 'next';
import NodeDevices from '@/components/cabinet/NodeDevices';
import { pageTitle } from '@/lib/texts';

export const metadata: Metadata = { title: pageTitle('device_title', 'cabinet_title'), robots: { index: false, follow: true } };

export default function NodeDevicePage() {
  return <NodeDevices />;
}
