import { recordMetadata } from '@/i18n/server';

export const generateMetadata = () => recordMetadata('sugg_address');

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}