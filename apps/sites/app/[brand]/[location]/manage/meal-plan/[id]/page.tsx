import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { MealPlanManage } from '@/components/foods/Extras';
import { apiGet, isNotFound } from '@/lib/api';
import type { SubscriptionX } from '@/lib/foods-ext';
import { loadLocation } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ManageMealPlanPage({ params, searchParams }: { params: Promise<{ brand: string; location: string; id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { brand, location, id } = await params;
  const { token } = await searchParams;
  const data = await loadLocation(brand, location);
  const t = await getTranslations();
  let s: SubscriptionX | null = null;
  if (token && token.length >= 10 && /^[0-9a-f-]{36}$/i.test(id)) {
    try { s = await apiGet<SubscriptionX>(`/v1/public/foods/meal-plans/subscriptions/${id}?token=${encodeURIComponent(token)}`); } catch (err) { if (!isNotFound(err)) throw err; }
  }
  if (!s) return <MessagePage icon="lock" title={t('foodsite.mealTitle')} body={t('manage.invalidLink')} />;
  return <main id="main" className="mx-auto max-w-2xl px-4 py-10"><MealPlanManage initial={s} token={token!} timeZone={data.location.timeZone} /></main>;
}
