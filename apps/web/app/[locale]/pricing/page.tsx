import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Icon } from '@/components/ui';
import { FaqList, H2, PageHero, Panel } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { PricingPlans } from '@/components/pricing/PricingPlans';
import { buildMetadata } from '@/lib/seo';
import { visitorPricing } from '@/lib/geo';
import { DEMO_URL } from '@/lib/links';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'pricing');

/** Rendered per request: the currency follows the visitor's location (hosting geolocation headers). */
export const dynamic = 'force-dynamic';

export default async function PricingPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('pricing');
  const tc = await getTranslations('common');
  const { currency, country } = await visitorPricing();

  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="card" title={t('headline')} intro={t('intro')} />
      <Panel labelledBy="plans-title">
        <h2 id="plans-title" className="sr-only">
          {t('kicker')}
        </h2>
        <PricingPlans currency={currency} country={country} />
        <ul className="mt-6 flex flex-col gap-2 text-sm text-graphite">
          {(['listPriceNote', 'taxNote', 'proposedNote', 'ctaNote'] as const).map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-stone" />
              {t(k)}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel tone="aqua" labelledBy="pricing-demo" className="flex flex-col items-start gap-5 md:flex-row md:items-center md:justify-between">
        <div className="flex max-w-2xl flex-col gap-2">
          <H2 id="pricing-demo">{t('demoTitle')}</H2>
          <p className="text-base leading-relaxed text-graphite">{t('demoBody')}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <LinkButton href={DEMO_URL} external size="lg" iconRight="arrow-up-right">
            {tc('tryDemo')}
          </LinkButton>
          <LinkButton href="/demo" size="lg" variant="secondary">
            {tc('requestDemo')}
          </LinkButton>
        </div>
      </Panel>
      <Panel labelledBy="pricing-faq" className="grid gap-8 lg:grid-cols-[1fr_2fr]">
        <H2 id="pricing-faq">{t('faqTitle')}</H2>
        <FaqList items={t.raw('faqs') as { q: string; a: string }[]} />
      </Panel>
    </>
  );
}
