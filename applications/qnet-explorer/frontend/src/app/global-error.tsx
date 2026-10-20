'use client';

// Last resort when the root layout itself fails: a plain page with a reload button. The site's stylesheets do not load
// here, so its few rules are written in place with the values of styles/tokens.css (Ink, Paper, Signal, the 2 px radius).

const INK = '#05080A';
const PAPER = '#E8F0F0';
const SIGNAL = '#3CF0DC';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: INK, color: PAPER, fontFamily: "'Helvetica Neue', Arial, system-ui, sans-serif", margin: 0 }}>
        <main style={{ maxWidth: '640px', margin: '20vh auto 0', padding: '0 16px' }}>
          <h1 style={{ margin: 0, fontSize: '36px', fontWeight: 760, lineHeight: 1.05, letterSpacing: '-0.03em' }}>aiqnet.io could not load</h1>
          <p style={{ margin: '18px 0 0', fontSize: '17px', lineHeight: 1.6, color: 'rgb(232 240 240 / .8)' }}>
            Something in the browser stopped the page, often another extension. Reload the page to try again.
          </p>
          <button
            type="button"
            onClick={() => { reset(); window.location.reload(); }}
            style={{ marginTop: '28px', padding: '17px 24px', background: SIGNAL, color: INK, border: 0, borderRadius: '2px', font: 'inherit', fontSize: '15.5px', fontWeight: 600, cursor: 'pointer' }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
