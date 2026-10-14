import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { OrderTracker } from '@/components/shop/OrderTracker';
import { apiGet, isNotFound } from '@/lib/api';
import type { PublicOrder } from '@/lib/shop';
import { loadLocation } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Order confirmation & status (manage token): payment, fulfilment, tracking, cancellation and return requests. */
export default async function ShopOrderPage({ params, searchParams }: { params: Promise<{ brand: string; location: string; id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { brand, location, id } = await params;
  const { token } = await searchParams;
  await loadLocation(brand, location);
  const t = await getTranslations();
  let order: PublicOrder | null = null;
  if (token && token.length >= 10 && /^[0-9a-f-]{36}$/i.test(id)) {
    try { order = await apiGet<PublicOrder>(`/v1/public/commerce/orders/${id}?token=${encodeURIComponent(token)}`); } catch (err) { if (!isNotFound(err)) throw err; }
  }
  if (!order || order.brand.slug !== brand) return <MessagePage icon="lock" title={t('storefront.orderTitle')} body={t('manage.invalidLink')} />;
  return <main id="main" className="mx-auto max-w-3xl px-4 py-10"><OrderTracker initial={order} token={token!} /></main>;
}
