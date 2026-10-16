import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { ASSISTANT_NAME } from '@bh/shared';
import { Icon } from '@/components/ui';
import { PASTEL } from '@/content/images';
import { FaqList, H2, Lead, PageHero, Panel, PastelIcon, SampleBadge } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { DEMO_URL } from '@/lib/links';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'marina');

const FEATURES: { icon: IconName; bg: string }[] = [
  { icon: 'chart', bg: PASTEL.aqua },
  { icon: 'sun', bg: PASTEL.butter },
  { icon: 'sparkles', bg: PASTEL.lilac },
  { icon: 'pin', bg: PASTEL.sage },
  { icon: 'edit', bg: PASTEL.blush },
  { icon: 'book', bg: PASTEL.lime },
];
const SAFETY: IconName[] = ['lock', 'check-circle', 'shield', 'file'];

/** Raw (array) messages are not ICU-formatted, so the assistant's name is filled in here. */
const named = (s: string) => s.replaceAll('{name}', ASSISTANT_NAME);

export default async function MarinaPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('marina');
  const tc = await getTranslations('common');
  const v = { name: ASSISTANT_NAME };
  const examples = (t.raw('askExamples') as string[]).map(named);
  const features = t.raw('features') as { name: string; desc: string }[];
  const safety = t.raw('safety') as { name: string; desc: string }[];
  const faq = (t.raw('faq') as { q: string; a: string }[]).map((f) => ({ q: named(f.q), a: named(f.a) }));

  return (
    <>
      <PageHero
        kicker={t('kicker')}
        kickerIcon="sparkles"
        title={t('title', v)}
        intro={t('lead', v)}
        aside={
          <div className="rounded-[24px] bg-lilac p-3 sm:p-4">
            <div className="rounded-[18px] bg-surface">
              <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
                <Icon name="sparkles" size={16} />
                <span className="text-sm font-bold">{t('askTitle')}</span>
                <SampleBadge className="ms-auto">{tc('sampleData')}</SampleBadge>
              </div>
              <ul className="flex flex-col gap-2 p-3">
                {examples.map((q) => (
                  <li key={q} className="flex items-center gap-3 rounded-[14px] bg-canvas-raised px-3 py-3 text-sm font-medium">
                    <Icon name="search" size={16} />
                    <span className="flex-1">{q}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        }
      >
        <div className="flex flex-wrap gap-2.5">
          <LinkButton href={DEMO_URL} external size="lg" signal="arrow-right">
            {t('ctaDemo', v)}
          </LinkButton>
          <LinkButton href="/pricing" size="lg" variant="secondary">
            {t('ctaPricing')}
          </LinkButton>
        </div>
      </PageHero>

      <Panel labelledBy="marina-features">
        <H2 id="marina-features">{t('featuresTitle', v)}</H2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <li key={f.name} className="flex flex-col gap-3 rounded-[24px] border border-line-soft p-6">
              <PastelIcon name={FEATURES[i]?.icon ?? 'sparkles'} bg={FEATURES[i]?.bg ?? PASTEL.lilac} />
              <h3 className="text-xl font-extrabold tracking-[-0.02em]">{named(f.name)}</h3>
              <p className="text-[15px] leading-relaxed text-stone">{named(f.desc)}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel labelledBy="marina-safety" tone="sage">
        <H2 id="marina-safety">{t('safetyTitle')}</H2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {safety.map((f, i) => (
            <li key={f.name} className="flex items-start gap-4 rounded-[24px] bg-surface p-6">
              <PastelIcon name={SAFETY[i] ?? 'check'} bg={PASTEL.canvas} />
              <div className="flex flex-col gap-1.5">
                <h3 className="text-lg font-extrabold tracking-[-0.02em]">{named(f.name)}</h3>
                <p className="text-[15px] leading-relaxed text-stone">{named(f.desc)}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel labelledBy="marina-usage" className="flex flex-col items-start gap-4">
        <H2 id="marina-usage">{t('usageTitle')}</H2>
        <Lead className="max-w-3xl">{t('usageBody', v)}</Lead>
        <LinkButton href="/pricing" variant="secondary" iconRight="arrow-right">
          {t('ctaPricing')}
        </LinkButton>
      </Panel>

      <Panel labelledBy="marina-faq">
        <H2 id="marina-faq">{t('faqTitle', v)}</H2>
        <FaqList items={faq} className="mt-8" />
      </Panel>
    </>
  );
}
