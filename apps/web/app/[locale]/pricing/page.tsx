import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Icon } from '@/components/ui';
import { FaqList, H2, PageHero, Panel } from '@/components/site/Blocks';
import { PricingPlans } from '@/components/pricing/PricingPlans';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  return { title: t('metaTitle'), description: t('intro') };
}

export default async function PricingPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('pricing');

  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="card" title={t('headline')} intro={t('intro')} />
      <Panel labelledBy="plans-title">
        <h2 id="plans-title" className="sr-only">
          {t('kicker')}
        </h2>
        <PricingPlans />
        <ul className="mt-6 flex flex-col gap-2 text-sm text-graphite">
          {(['listPriceNote', 'taxNote', 'proposedNote', 'ctaNote'] as const).map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-stone" />
              {t(k)}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel labelledBy="pricing-faq" className="grid gap-8 lg:grid-cols-[1fr_2fr]">
        <H2 id="pricing-faq">{t('faqTitle')}</H2>
        <FaqList items={t.raw('faqs') as { q: string; a: string }[]} />
      </Panel>
    </>
  );
}
