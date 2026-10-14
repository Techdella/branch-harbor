import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { CateringQuoteView } from '@/components/foods/Extras';
import { apiGet, isNotFound } from '@/lib/api';
import type { CateringEnquiryX } from '@/lib/foods-ext';
import { loadLocation } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Private enquiry link: status, the business's quote, accept and pay the deposit. */
export default async function CateringEnquiryPage({ params, searchParams }: { params: Promise<{ brand: string; location: string; id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { brand, location, id } = await params;
  const { token } = await searchParams;
  const data = await loadLocation(brand, location);
  const t = await getTranslations();
  let e: CateringEnquiryX | null = null;
  if (token && token.length >= 10 && /^[0-9a-f-]{36}$/i.test(id)) {
    try { e = await apiGet<CateringEnquiryX>(`/v1/public/foods/catering/enquiries/${id}?token=${encodeURIComponent(token)}`); } catch (err) { if (!isNotFound(err)) throw err; }
  }
  if (!e) return <MessagePage icon="lock" title={t('foodsite.cateringTitle')} body={t('manage.invalidLink')} />;
  return <main id="main" className="mx-auto max-w-2xl px-4 py-10"><CateringQuoteView initial={e} token={token!} timeZone={data.location.timeZone} /></main>;
}
