import './globals.css';

/** Requests outside any locale (rare — the proxy adds a prefix) land here. */
export default function RootNotFound() {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink">
        <main className="rounded-2xl bg-surface p-10 text-center">
          <h1 className="text-h1 font-extrabold">Page not found</h1>
          <p className="mt-3 text-stone">
            <a className="font-bold underline" href="/en">
              Go to BranchHarbor
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
