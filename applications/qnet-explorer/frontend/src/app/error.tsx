'use client';

// A page that throws in the browser shows this instead of a blank screen; the header and footer stay.

import Action from '@/components/ui/Action';
import PageHead from '@/components/ui/PageHead';

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pg">
      <PageHead
        title="This page could not be shown"
        lead="Something in the browser stopped it from loading, often another extension. Try again, or reload the page."
      >
        <div className="pg-act" data-field-clear>
          <Action kind="solid" onClick={() => reset()}>Try again</Action>
          <Action onClick={() => window.location.reload()}>Reload</Action>
        </div>
      </PageHead>
    </div>
  );
}
