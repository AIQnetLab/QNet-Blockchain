import type { Metadata } from 'next';

// A server self-check page, not content.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}