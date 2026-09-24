import type { Metadata } from 'next';

// One page per chain record: crawlable for its links, kept out of the index.
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}