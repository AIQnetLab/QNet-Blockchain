'use client';

// Last resort when the root layout itself fails: a plain page with a reload button, no site styles.

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#000', color: '#e6f7ff', fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <main style={{ maxWidth: '560px', margin: '20vh auto', padding: '0 1rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.4rem' }}>aiqnet.io could not load</h1>
          <p style={{ opacity: 0.8 }}>
            Something in the browser stopped the page, often another extension. Reload the page to try again.
          </p>
          <button
            type="button"
            onClick={() => { reset(); window.location.reload(); }}
            style={{ marginTop: '1rem', padding: '0.6rem 1.2rem', background: '#00ffff', color: '#000', border: 0, borderRadius: '6px', cursor: 'pointer' }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
