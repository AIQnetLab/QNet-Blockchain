'use client';

// A page that throws in the browser shows this instead of a blank screen; the header and footer stay.

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="explorer-section">
      <div className="content-card" style={{ maxWidth: '640px', margin: '3rem auto', textAlign: 'center' }}>
        <h2 className="section-title">This page could not be shown</h2>
        <p className="section-subtitle">
          Something in the browser stopped it from loading, often another extension. Try again, or reload the page.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.5rem' }}>
          <button type="button" className="qnet-button" onClick={() => reset()}>
            Try again
          </button>
          <button type="button" className="qnet-button secondary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    </section>
  );
}
