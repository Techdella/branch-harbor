'use client';

/** Last-resort error page when even the root layout failed (no translations available here). */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
        <main style={{ maxWidth: 480, textAlign: 'center' }}>
          <h1>This page isn&apos;t available right now</h1>
          <p>We couldn&apos;t load this page. Nothing was booked or charged. Please try again in a moment.</p>
          <button type="button" onClick={reset} style={{ minHeight: 44, padding: '0 20px', borderRadius: 999, border: 0, background: '#141414', color: '#fff', fontWeight: 700 }}>Try again</button>
        </main>
      </body>
    </html>
  );
}
