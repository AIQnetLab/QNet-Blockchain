import BlocksClient from './BlocksClient';

// While the route loads, the page itself in its loading state (its final geometry, fifty empty rows), never the list's
// skeleton of /explorer/loading.tsx.
export default function Loading() {
  return <BlocksClient />;
}
