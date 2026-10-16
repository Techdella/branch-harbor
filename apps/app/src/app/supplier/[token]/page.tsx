import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SupplierConfirmPage } from '@/components/supply/SupplierConfirmPage';

/** The supplier's magic-link page (no login): view, download and confirm a purchase order. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('supply'))('public.pageTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SupplierConfirmPage token={token} />;
}
