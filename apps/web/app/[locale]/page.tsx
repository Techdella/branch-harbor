import Image from 'next/image';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { Icon } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { INDUSTRIES, INDUSTRY_KEYS } from '@/content/industries';
import { INTEGRATIONS, CATEGORY_PASTEL } from '@/content/integrations';
import { PASTEL } from '@/content/images';
import { ProductPreview } from '@/components/home/ProductPreview';
import { FaqList, H2, Kicker, Lead, Panel, PastelIcon, StatusPill } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { buildMetadata } from '@/lib/seo';

export const generateMetadata = async ({ params }: { params: Promise<{ locale: string }> }) => buildMetadata((await params).locale, 'home');

const CAPABILITIES: { icon: IconName; pastel: string; tag: 'launch' | 'preview' | 'setup' | 'selected' }[] = [
  { icon: 'globe', pastel: PASTEL.aqua, tag: 'launch' },
  { icon: 'users', pastel: PASTEL.lilac, tag: 'launch' },
  { icon: 'megaphone', pastel: PASTEL.blush, tag: 'launch' },
  { icon: 'card', pastel: PASTEL.butter, tag: 'setup' },
  { icon: 'sparkles', pastel: PASTEL.lilac, tag: 'preview' },
  { icon: 'plug', pastel: PASTEL.sage, tag: 'selected' },
];
const TAG_STYLE = {
  launch: 'bg-lime text-ink',
  preview: 'bg-ink text-white',
  setup: 'bg-aqua text-ink',
  selected: 'bg-canvas text-ink',
} as const;

const STEP_STYLE: { icon: IconName; pastel: string }[] = [
  { icon: 'grid', pastel: PASTEL.butter },
  { icon: 'plug', pastel: PASTEL.aqua },
  { icon: 'layers', pastel: PASTEL.blush },
];

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const tc = await getTranslations('common');
  const tm = await getTranslations('industryMeta');
  const ti = await getTranslations('integrations');

  const steps = t.raw('steps.items') as { title: string; desc: string }[];
  const caps = t.raw('capabilities.items') as { name: string; desc: string }[];
  const faqs = t.raw('faq.items') as { q: string; a: string }[];
  const hqChips = t.raw('hqLocal.hq.chips') as string[];
  const localChips = t.raw('hqLocal.local.chips') as string[];
  const intPreview = [...INTEGRATIONS.filter((i) => i.status !== 'planned').slice(0, 6), ...INTEGRATIONS.filter((i) => ['mindbody', 'square'].includes(i.id))];

  return (
    <>
      {/* 2. Hero */}
      <Panel className="flex flex-col items-center gap-6 text-center md:py-20" labelledBy="hero-title">
        <Kicker icon="sparkles">{t('hero.badge')}</Kicker>
        <h1 id="hero-title" className="max-w-[980px] text-[44px] leading-[0.98] font-extrabold tracking-[-0.05em] sm:text-[64px] lg:text-[88px]">
          {t('hero.titleLead')} <span className="text-sage">{t('hero.titleAccent')}</span>
        </h1>
        <Lead className="max-w-[620px]">{t('hero.body')}</Lead>
        <div className="flex flex-wrap justify-center gap-2.5">
          <a href="#industries" className="inline-flex h-[54px] items-center gap-2.5 rounded-full bg-ink ps-6 pe-1.5 text-[15px] font-bold text-white transition hover:bg-ink-2">
            {t('hero.primary')}
            <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-lime text-ink">
              <Icon name="arrow-down" size={18} />
            </span>
          </a>
          <a href="#how" className="inline-flex h-[54px] items-center gap-2 rounded-full border-[1.5px] border-ink bg-surface px-6 text-[15px] font-bold transition hover:bg-canvas-raised">
            <Icon name="play" size={14} />
            {t('hero.secondary')}
          </a>
        </div>
      </Panel>

      {/* 3. Product visual */}
      <ProductPreview />

      {/* 4. Industry selector */}
      <section id="industries" aria-labelledby="industries-title" className="grid scroll-mt-4 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex min-h-[300px] flex-col justify-between gap-6 rounded-[28px] bg-sage p-7 text-white md:rounded-2xl md:p-9">
          <H2 id="industries-title">{t('industries.title')}</H2>
          <div className="flex flex-col gap-4">
            <p className="text-[15px] leading-relaxed text-[#E6EEE7]">{t('industries.body')}</p>
            <Link href="/solutions/independent-businesses" className="inline-flex items-center gap-2 text-sm font-bold text-white underline-offset-4 hover:underline">
              {t('industries.independent')}
              <Icon name="arrow-right" size={15} className="rtl:-scale-x-100" />
            </Link>
          </div>
        </div>
        {INDUSTRY_KEYS.map((k) => {
          const ind = INDUSTRIES[k];
          return (
            <Link
              key={k}
              href={`/industries/${k}`}
              className="group relative flex min-h-[380px] flex-col justify-end overflow-hidden rounded-[28px] md:rounded-2xl"
              style={{ background: ind.pastel }}
            >
              <Image src={ind.image} alt="" fill sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" className="object-cover transition duration-500 group-hover:scale-[1.03]" />
              <span className="absolute start-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-xs font-bold backdrop-blur">
                <Icon name={ind.icon} size={13} />
                {tc(`availability.${ind.availability}`)}
              </span>
              <span className="relative m-3 flex flex-col gap-1.5 rounded-[22px] bg-white/95 p-4 backdrop-blur">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xl font-extrabold tracking-[-0.02em]">{tm(`${k}.name`)}</span>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white">
                    <Icon name="arrow-up-right" size={15} className="rtl:-scale-x-100" />
                  </span>
                </span>
                <span className="text-[13px] leading-snug text-graphite">{tm(`${k}.who`)}</span>
                <span className="text-xs font-bold text-stone">{tm(`${k}.flow`)}</span>
              </span>
            </Link>
          );
        })}
        <div className="flex items-center gap-3 rounded-[28px] border-[1.5px] border-dashed border-line bg-canvas-raised p-6 sm:col-span-2 lg:col-span-3 md:rounded-2xl">
          <PastelIcon name="house" bg={PASTEL.aqua} size={40} />
          <p className="text-sm font-bold">
            {t('industries.realty')}
            <span className="ms-2 font-medium text-stone">{tm('realty.who')}</span>
          </p>
        </div>
      </section>

      {/* 5. Headquarters and locations */}
      <section aria-labelledby="hqlocal-title" className="grid gap-3 md:grid-cols-2">
        <h2 id="hqlocal-title" className="sr-only">
          {t('hqLocal.title')}
        </h2>
        {(
          [
            { key: 'hq', icon: 'building', bg: 'bg-lilac', chips: hqChips, chipIcons: ['lock', 'layers', 'chart'] },
            { key: 'local', icon: 'pin', bg: 'bg-butter', chips: localChips, chipIcons: ['edit', 'shield', 'undo'] },
          ] as const
        ).map((p) => (
          <div key={p.key} className={`flex flex-col gap-4 rounded-[28px] p-7 md:rounded-2xl md:p-10 ${p.bg}`}>
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3.5 py-1.5 text-[13px] font-bold">
              <Icon name={p.icon} size={14} />
              {t(`hqLocal.${p.key}.eyebrow`)}
            </span>
            <h3 className="text-[30px] leading-[1.08] font-extrabold tracking-[-0.035em] md:text-[36px]">{t(`hqLocal.${p.key}.title`)}</h3>
            <p className="max-w-lg text-[15px] leading-relaxed text-graphite">{t(`hqLocal.${p.key}.body`)}</p>
            <ul className="mt-auto flex flex-wrap gap-2 pt-2">
              {p.chips.map((c, i) => (
                <li key={c} className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-xs font-bold">
                  <Icon name={p.chipIcons[i] ?? 'check'} size={13} />
                  {c}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {/* 6. Three steps */}
      <Panel id="how" labelledBy="how-title">
        <div className="flex flex-col gap-3">
          <H2 id="how-title">{t('steps.title')}</H2>
          <Lead>{t('steps.body')}</Lead>
        </div>
        <ol className="mt-10 grid gap-3 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3 rounded-[24px] bg-canvas-raised p-6">
              <div className="flex items-center justify-between">
                <PastelIcon name={STEP_STYLE[i]?.icon ?? 'check'} bg={STEP_STYLE[i]?.pastel ?? PASTEL.canvas} size={48} />
                <span className="tabular text-[40px] font-extrabold tracking-[-0.04em] text-line" aria-hidden="true">
                  0{i + 1}
                </span>
              </div>
              <h3 className="text-xl font-extrabold tracking-[-0.02em]">{s.title}</h3>
              <p className="text-[15px] leading-relaxed text-stone">{s.desc}</p>
            </li>
          ))}
        </ol>
      </Panel>

      {/* 7. Capabilities */}
      <Panel labelledBy="caps-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-3">
            <H2 id="caps-title">{t('capabilities.title')}</H2>
            <Lead>{t('capabilities.body')}</Lead>
          </div>
          <ul aria-label={t('capabilities.legendLabel')} className="flex flex-wrap gap-2">
            {(['launch', 'preview', 'setup', 'selected'] as const).map((k) => (
              <li key={k} className={`rounded-full px-3 py-1 text-xs font-bold ${TAG_STYLE[k]}`}>
                {t(`capabilities.tags.${k}`)}
              </li>
            ))}
          </ul>
        </div>
        <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {caps.map((c, i) => {
            const meta = CAPABILITIES[i]!;
            return (
              <li key={c.name} className="flex flex-col gap-3 rounded-[24px] border border-line-soft p-6">
                <div className="flex items-start justify-between gap-3">
                  <PastelIcon name={meta.icon} bg={meta.pastel} />
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${TAG_STYLE[meta.tag]}`}>{t(`capabilities.tags.${meta.tag}`)}</span>
                </div>
                <h3 className="text-xl font-extrabold tracking-[-0.02em]">{c.name}</h3>
                <p className="text-[15px] leading-relaxed text-stone">{c.desc}</p>
              </li>
            );
          })}
        </ul>
      </Panel>

      {/* 8. Hosted vs WordPress */}
      <section aria-labelledby="delivery-title" className="grid gap-3 md:grid-cols-2">
        <h2 id="delivery-title" className="sr-only">
          {t('delivery.title')}
        </h2>
        <div className="flex flex-col items-start gap-4 rounded-[28px] bg-ink p-7 text-white md:rounded-2xl md:p-10">
          <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-ink-2">
            <Icon name="globe" size={24} />
          </span>
          <h3 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('delivery.hosted.title')}</h3>
          <p className="max-w-md text-[15px] leading-relaxed text-[#C9C9C3]">{t('delivery.hosted.body')}</p>
          <LinkButton href="/pricing" variant="light" iconRight="arrow-right" className="mt-auto">
            {t('delivery.hosted.cta')}
          </LinkButton>
        </div>
        <div className="flex flex-col items-start gap-4 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-butter">
            <Icon name="wordpress" size={24} />
          </span>
          <h3 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('delivery.wordpress.title')}</h3>
          <p className="max-w-md text-[15px] leading-relaxed text-stone">{t('delivery.wordpress.body')}</p>
          <LinkButton href="/wordpress" variant="secondary" iconRight="arrow-right" className="mt-auto">
            {t('delivery.wordpress.cta')}
          </LinkButton>
        </div>
      </section>

      {/* 9. Integrations */}
      <Panel labelledBy="int-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-3">
            <H2 id="int-title">{t('integrations.title')}</H2>
            <Lead>{t('integrations.body')}</Lead>
          </div>
          <LinkButton href="/integrations" variant="secondary" iconRight="arrow-right">
            {t('integrations.cta')}
          </LinkButton>
        </div>
        <ul className="mt-10 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {intPreview.map((i) => (
            <li key={i.id} className="flex items-center gap-3 rounded-[20px] border border-line-soft p-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] text-sm font-extrabold" style={{ background: CATEGORY_PASTEL[i.category] }} aria-hidden="true">
                {i.mono}
              </span>
              <div className="flex min-w-0 flex-col items-start gap-1">
                <span className="truncate text-sm font-bold">{i.name}</span>
                <StatusPill status={i.status} label={tc(`status.${i.status}`)} />
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-stone">{ti('disclaimer')}</p>
      </Panel>

      {/* 10. Evidence + 11. Pricing preview */}
      <section aria-label={`${t('evidence.eyebrow')} · ${t('pricing.eyebrow')}`} className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col items-start gap-4 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <span className="text-label font-extrabold text-stone uppercase">{t('evidence.eyebrow')}</span>
          <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('evidence.title')}</h2>
          <p className="text-[15px] leading-relaxed text-stone">{t('evidence.body')}</p>
          <ul className="flex flex-wrap gap-2">
            {INDUSTRY_KEYS.map((k) => (
              <li key={k}>
                <Link href={`/industries/${k}#workflow`} className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-bold hover:outline-2 hover:outline-ink" style={{ background: INDUSTRIES[k].pastel }}>
                  <Icon name={INDUSTRIES[k].icon} size={14} />
                  {t('evidence.workflow', { name: tm(`${k}.name`) })}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col items-start gap-4 rounded-[28px] bg-lilac p-7 md:rounded-2xl md:p-10">
          <span className="text-label font-extrabold text-graphite uppercase">{t('pricing.eyebrow')}</span>
          <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('pricing.title')}</h2>
          <p className="text-[15px] leading-relaxed text-graphite">{t('pricing.body')}</p>
          <LinkButton href="/pricing" iconRight="arrow-right" className="mt-auto">
            {t('pricing.cta')}
          </LinkButton>
        </div>
      </section>

      <Panel labelledBy="faq-title" className="grid gap-8 lg:grid-cols-[1fr_2fr]">
        <H2 id="faq-title">{t('faq.title')}</H2>
        <FaqList items={faqs} />
      </Panel>

      {/* 12. Closing CTA */}
      <Panel tone="sage" labelledBy="closing-title" className="flex flex-col items-center gap-5 text-center md:py-20">
        <H2 id="closing-title" className="max-w-2xl md:text-[56px]">
          {t('closing.title')}
        </H2>
        <p className="max-w-xl text-base leading-relaxed text-[#E6EEE7] md:text-lg">{t('closing.body')}</p>
        <div className="flex flex-wrap justify-center gap-2.5">
          <LinkButton href="/demo" size="lg" variant="light" iconRight="arrow-up-right">
            {t('closing.primary')}
          </LinkButton>
          <LinkButton href="/pricing" size="lg" variant="onDark">
            {t('closing.secondary')}
          </LinkButton>
        </div>
      </Panel>
    </>
  );
}
