import { recordMetadata } from '@/i18n/server';

export const generateMetadata = () => recordMetadata('col_token');

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}