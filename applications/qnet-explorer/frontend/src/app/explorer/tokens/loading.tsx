import TokensClient from './TokensClient';

// While the route loads, the page itself in its loading state (its final geometry, values "—"), never the list's
// skeleton of /explorer/loading.tsx.
export default function Loading() {
  return <TokensClient />;
}
