import type { ReactNode } from 'react';

/** The real root layout is app/[locale]/layout.tsx; this pass-through exists for the root not-found page. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
