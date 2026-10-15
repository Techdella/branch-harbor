import type { ReactNode } from 'react';
import { MarketingNav } from '@/components/marketing/MarketingNav';

/** Marketing workspace: section navigation above every marketing screen. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <MarketingNav />
      {children}
    </>
  );
}
