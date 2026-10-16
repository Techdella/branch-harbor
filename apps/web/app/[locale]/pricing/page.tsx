import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DEFAULT_PAYMENT_APPLICATION_FEE_BPS, NETWORK_INCLUDED_LOCATIONS, TRIAL_DAYS } from '@bh/shared';
import type { IconName } from '@bh/icons';
import { Icon } from '@/components/ui';
import { FaqList, H2, PageHero, Panel, PastelIcon } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { PricingPlans } from '@/components/pricing/PricingPlans';
import { PASTEL } from '@/content/images';
import { formatPrice, listPrice } from '@/content/pricing';
import { numberLocale } from '@/lib/intl';
import { buildMetadata } from '@/lib/seo';
import { visitorPricing } from '@/lib/geo';
import { DEMO_URL, signUpUrl } from '@/lib/links';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'pricing');

/** Rendered per request: the currency and regional price list follow the visitor's location (hosting geolocation headers). */
export const dynamic = 'force-dynamic';

const TRIAL_STEPS: { key: 'pay' | 'use' | 'remind' | 'start'; icon: IconName; pastel: string }[] = [
  { key: 'pay', icon: 'card', pastel: PASTEL.butter },
  { key: 'use', icon: 'sparkles', pastel: PASTEL.aqua },
  { key: 'remind', icon: 'bell', pastel: PASTEL.lilac },
  { key: 'start', icon: 'calendar', pastel: PASTEL.sage },
];
const PAYERS: { key: 'hq' | 'franchisee' | 'split'; icon: IconName; pastel: string }[] = [
  { key: 'hq', icon: 'building', pastel: PASTEL.lilac },
  { key: 'franchisee', icon: 'store', pastel: PASTEL.butter },
  { key: 'split', icon: 'layers', pastel: PASTEL.aqua },
];

export default async function PricingPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('pricing');
  const tc = await getTranslations('common');
  const { currency, country, priceList } = await visitorPricing();
  const fmt = (n: number) => formatPrice(n, currency, locale);
  const fmtFee = (n: number) => formatPrice(n, currency, locale, { cents: true });
  const trial = fmt(listPrice(priceList, 'trial'));
  const percent = new Intl.NumberFormat(numberLocale(locale), { style: 'percent', maximumFractionDigits: 2 }).format(DEFAULT_PAYMENT_APPLICATION_FEE_BPS / 10_000);
  const notes = ['listPriceNote', country === 'US' ? 'taxNoteUs' : 'taxNote', 'proposedNote', 'ctaNote'] as const;
  const terms = ['monthly', 'annual', 'noFee', 'export', 'lock'] as const;

  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="card" title={t('headline')} intro={t('intro')}>
        <div className="flex flex-wrap gap-2.5">
          <LinkButton href={signUpUrl()} external size="lg" signal="arrow-right">
            {tc('startPlan')}
          </LinkButton>
          <LinkButton href={DEMO_URL} external size="lg" variant="secondary" iconRight="arrow-up-right">
            {tc('tryDemo')}
          </LinkButton>
        </div>
        <p className="flex max-w-2xl flex-col gap-1 text-sm leading-relaxed" data-testid="trial-line">
          <strong className="text-base font-extrabold">{t('trialLine', { days: TRIAL_DAYS, price: trial })}</strong>
          <span className="text-graphite">
            {t('trialLineSub')}{' '}
            <a href="#trial" className="font-bold underline underline-offset-4">
              {t('trialHow')}
            </a>
          </span>
        </p>
      </PageHero>
      <Panel labelledBy="plans-title">
        <h2 id="plans-title" className="sr-only">
          {t('kicker')}
        </h2>
        <PricingPlans currency={currency} priceList={priceList} country={country} />
        <ul className="mt-6 flex flex-col gap-2 text-sm text-graphite">
          {notes.map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-stone" />
              {t(k)}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel id="trial" tone="aqua" labelledBy="trial-title" className="flex flex-col gap-6">
        <div className="flex max-w-3xl flex-col gap-2">
          <H2 id="trial-title">{t('trialTitle', { days: TRIAL_DAYS })}</H2>
          <p className="text-base leading-relaxed text-graphite">{t('trialIntro')}</p>
        </div>
        <ol className="grid gap-[var(--edge)] sm:grid-cols-2 xl:grid-cols-4">
          {TRIAL_STEPS.map((st, i) => (
            <li key={st.key} className="flex flex-col gap-3 rounded-[24px] bg-surface p-5">
              <div className="flex items-center gap-3">
                <PastelIcon name={st.icon} bg={st.pastel} size={40} />
                <span className="text-xs font-bold text-stone">{i + 1} / 4</span>
              </div>
              <h3 className="text-lg font-extrabold tracking-[-0.01em]">{t(`trialSteps.${st.key}.title`, { price: trial, days: TRIAL_DAYS, day: TRIAL_DAYS + 1 })}</h3>
              <p className="text-sm leading-relaxed text-graphite">{t(`trialSteps.${st.key}.body`)}</p>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel labelledBy="who-pays-title" className="flex flex-col gap-6">
        <div className="flex max-w-3xl flex-col gap-2">
          <H2 id="who-pays-title">{t('whoPays.title')}</H2>
          <p className="text-base leading-relaxed text-graphite">
            {t('whoPays.intro', { count: NETWORK_INCLUDED_LOCATIONS, platform: fmt(listPrice(priceList, 'platform')), price: fmt(listPrice(priceList, 'network')) })}
          </p>
        </div>
        <ul className="grid gap-[var(--edge)] md:grid-cols-3">
          {PAYERS.map((p) => (
            <li key={p.key} className="flex flex-col gap-3 rounded-[24px] bg-canvas p-5">
              <PastelIcon name={p.icon} bg={p.pastel} size={40} />
              <h3 className="text-lg font-extrabold tracking-[-0.01em]">{t(`whoPays.${p.key}.title`)}</h3>
              <p className="text-sm leading-relaxed text-graphite">{t(`whoPays.${p.key}.body`)}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel labelledBy="fees-title" className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <H2 id="fees-title">{t('fees.title')}</H2>
          <div className="flex flex-col gap-1.5 rounded-[24px] bg-butter p-5" data-testid="collection-fee">
            <h3 className="text-base font-extrabold">{t('fees.collection.title')}</h3>
            <p className="text-sm leading-relaxed">{t('fees.collection.body', { fee: fmtFee(listPrice(priceList, 'collection')), cap: fmtFee(listPrice(priceList, 'collectionCap')) })}</p>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[24px] bg-canvas p-5" data-testid="extra-brand-fee">
            <h3 className="text-base font-extrabold">{t('fees.extraBrand.title')}</h3>
            <p className="text-sm leading-relaxed">{t('fees.extraBrand.body', { fee: fmt(listPrice(priceList, 'extraBrand')), platform: fmt(listPrice(priceList, 'platform')) })}</p>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[24px] bg-canvas p-5" data-testid="payment-fee">
            <h3 className="text-base font-extrabold">{t('fees.payments.title')}</h3>
            <p className="text-sm leading-relaxed">{t('fees.payments.body', { percent })}</p>
          </div>
        </div>
        <div className="flex flex-col gap-5">
          <H2 id="terms-title">{t('terms.title')}</H2>
          <ul className="flex flex-col gap-3">
            {terms.map((k) => (
              <li key={k} className="flex items-start gap-3 text-sm leading-relaxed">
                <Icon name="check" size={18} stroke={2.4} className="mt-0.5 shrink-0" />
                {t(`terms.${k}`)}
              </li>
            ))}
            <li className="flex items-start gap-3 text-sm leading-relaxed">
              <Icon name="check" size={18} stroke={2.4} className="mt-0.5 shrink-0" />
              {t(country === 'US' ? 'taxNoteUs' : 'taxNote')}
            </li>
          </ul>
        </div>
      </Panel>

      <Panel tone="lilac" labelledBy="pricing-demo" className="flex flex-col items-start gap-5 md:flex-row md:items-center md:justify-between">
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
