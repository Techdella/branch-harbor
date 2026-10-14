import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { MealPlanSubscribe } from '@/components/foods/Extras';
import { apiGet } from '@/lib/api';
import type { MealPlanX } from '@/lib/foods-ext';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('foodsite');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('mealTitle')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/meal-plans') } };
}

/** Weekly meal-plan subscription (skip any week before its cut-off from the manage link). */
export default async function MealPlansPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'foods' || data.module.mode === 'external') notFound();
  const t = await getTranslations('foodsite');
  const r = await apiGet<{ enabled: boolean; timeZone: string; plans: MealPlanX[] }>(`/v1/public/foods/${data.location.id}/meal-plans?lang=${encodeURIComponent(data.location.locale ?? 'en')}`);
  if (!r.enabled || !r.plans.length) return <MessagePage icon="repeat" title={t('mealTitle')} body={t('mealOff')} />;
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('mealTitle')}</h1>
      <p className="mt-1 text-graphite">{t('mealIntro', { location: data.location.name })}</p>
      <MealPlanSubscribe locationId={data.location.id} brandName={data.brand.name} plans={r.plans} timeZone={r.timeZone} manageBase={links.location(location, '/manage/meal-plan')} />
    </main>
  );
}
