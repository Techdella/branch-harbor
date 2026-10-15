import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { ReviewForm, type ReviewPageData } from '@/components/reviews/ReviewForm';
import { apiGet, isNotFound } from '@/lib/api';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Hosted review page (`/{brand}/{location}/review?t=…`), opened from a review request. Token-gated; no account needed.
 * The customer rates 1–5 and may comment (private feedback to the location), then sees the location's public review
 * links. The public links are shown to every customer whatever their rating — no review gating (Google policy).
 */
export default async function ReviewPage({ params, searchParams }: { params: Promise<{ brand: string; location: string }>; searchParams: Promise<{ t?: string }> }) {
  const { brand, location } = await params;
  const { t: token } = await searchParams;
  const t = await getTranslations('reviewPage');
  let data: ReviewPageData | null = null;
  if (token && /^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    try {
      data = await apiGet<ReviewPageData>(`/v1/public/reviews/${encodeURIComponent(brand)}/${encodeURIComponent(location)}?t=${encodeURIComponent(token)}`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  if (!data) return <MessagePage icon="lock" title={t('invalidTitle')} body={t('invalidBody')} />;
  return <ReviewForm brand={brand} location={location} token={token!} data={data} />;
}
