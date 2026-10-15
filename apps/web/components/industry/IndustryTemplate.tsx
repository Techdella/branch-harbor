import Image from 'next/image';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { INDUSTRIES, type IndustryKey } from '@/content/industries';
import { getIntegration } from '@/content/integrations';
import { CheckList, FaqList, H2, Kicker, Lead, Panel, PastelIcon, SampleBadge, StatusPill } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { DEMO_URL, signUpUrl } from '@/lib/links';
import { WorkflowExplorer, type WorkflowStepView } from './WorkflowExplorer';

interface Copy {
  imageAlt: string;
  headline: string;
  intro: string;
  problems: { t: string; d: string }[];
  workflow: { label: string; title: string; desc: string; screen: string; scope: string; rows: { a: string; b: string; tag: string }[] }[];
  hq: string[];
  local: string[];
  first: string[];
  later: string[];
  faqs: { q: string; a: string }[];
}

/**
 * Industry page template (spec §4): headline → problem → sample workflow → HQ/local permissions
 * → first-release capabilities → connected systems → later capabilities → pricing → FAQs → demo CTA.
 */
export async function IndustryTemplate({ industry }: { industry: IndustryKey }) {
  const def = INDUSTRIES[industry];
  const t = await getTranslations('industryPage');
  const tc = await getTranslations('common');
  const tm = await getTranslations('industryMeta');
  const ti = await getTranslations('integrations');
  const tx = await getTranslations('industries');
  const locale = await getLocale();
  const copy = tx.raw(industry) as Copy;
  const name = tm(`${industry}.name`);
  const region = new Intl.DisplayNames([locale], { type: 'region' });

  const steps: WorkflowStepView[] = copy.workflow.map((w, n) => {
    const s = def.workflow[n];
    return {
      ...w,
      icon: s?.icon ?? 'check',
      rows: w.rows.map((row, j) => ({ ...row, icon: s?.rows[j]?.icon ?? 'check', tone: s?.rows[j]?.tone ?? 'canvas' })),
    };
  });
  const demoHref = `/demo?industry=${industry}`;

  return (
    <>
      {/* Headline */}
      <Panel labelledBy="ind-title" className="grid gap-10 lg:grid-cols-[1.05fr_1fr] lg:items-center">
        <div className="flex flex-col items-start gap-5">
          <nav aria-label={tc('breadcrumb')} className="text-[13px] font-semibold text-stone">
            <ol className="flex flex-wrap items-center gap-1.5">
              <li>
                <Link href="/" className="hover:text-ink hover:underline">
                  {tc('home')}
                </Link>
              </li>
              <li aria-hidden="true">
                <Icon name="chevron-right" size={13} className="rtl:-scale-x-100" />
              </li>
              <li>
                <Link href="/#industries" className="hover:text-ink hover:underline">
                  {(await getTranslations('nav'))('industries')}
                </Link>
              </li>
              <li aria-hidden="true">
                <Icon name="chevron-right" size={13} className="rtl:-scale-x-100" />
              </li>
              <li aria-current="page" className="font-bold text-ink">
                {name}
              </li>
            </ol>
          </nav>
          <Kicker icon={def.icon}>{t('badge', { name })}</Kicker>
          <h1 id="ind-title" className="text-[38px] leading-[1.03] font-extrabold tracking-[-0.045em] md:text-[56px]">
            {copy.headline}
          </h1>
          <Lead>{copy.intro}</Lead>
          <div className="flex flex-wrap gap-2.5">
            <LinkButton href={DEMO_URL} external size="lg" signal="arrow-up-right">
              {tc('tryDemo')}
            </LinkButton>
            <LinkButton href={signUpUrl({ industry })} external size="lg" variant="secondary">
              {tc('startPlan')}
            </LinkButton>
          </div>
          <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-bold">
            <Link href={demoHref} className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline">
              <Icon name="phone" size={16} />
              {tm(`${industry}.cta`)}
            </Link>
            <a href="#workflow" className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline">
              {t('seeWorkflow')}
              <Icon name="arrow-down" size={16} />
            </a>
          </p>
        </div>
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-3">
          <div className="relative min-h-[300px] overflow-hidden rounded-[24px] md:min-h-[420px]" style={{ background: def.pastel }}>
            <Image src={def.image} alt={copy.imageAlt} fill priority sizes="(min-width: 1024px) 28vw, 60vw" className="object-cover" />
          </div>
          <div className="flex flex-col gap-3">
            <div className="relative flex-1 overflow-hidden rounded-[24px]" style={{ background: def.pastel }}>
              <Image src={def.image2} alt="" fill sizes="(min-width: 1024px) 20vw, 40vw" className="object-cover" />
            </div>
            <div className="flex flex-col gap-2 rounded-[24px] p-4" style={{ background: def.pastel }}>
              <Icon name="activity" size={22} />
              <div className="text-xs font-bold text-graphite">{t('mainWorkflow')}</div>
              <div className="text-sm leading-snug font-extrabold">{tm(`${industry}.flow`)}</div>
            </div>
          </div>
        </div>
      </Panel>

      {/* Customer problem */}
      <Panel labelledBy="problems-title">
        <H2 id="problems-title">{t('problemsTitle')}</H2>
        <ul className="mt-8 grid gap-3 md:grid-cols-3">
          {copy.problems.map((p, n) => (
            <li key={p.t} className="flex flex-col gap-3 rounded-[24px] bg-canvas-raised p-6">
              <PastelIcon name={def.problemIcons[n] ?? 'alert'} bg={def.pastel} />
              <h3 className="text-lg font-extrabold tracking-[-0.02em]">{p.t}</h3>
              <p className="text-[15px] leading-relaxed text-stone">{p.d}</p>
            </li>
          ))}
        </ul>
      </Panel>

      {/* Interactive sample workflow */}
      <Panel id="workflow" labelledBy="workflow-title">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <H2 id="workflow-title">{t('workflowTitle', { name })}</H2>
          <SampleBadge>{tc('conceptualPreview')}</SampleBadge>
        </div>
        <WorkflowExplorer steps={steps} pastel={def.pastel} />
      </Panel>

      {/* HQ / local permissions */}
      <section aria-labelledby="perm-title" className="rail-wide grid gap-[var(--edge)] md:grid-cols-2">
        <div className="rounded-[28px] bg-surface p-7 md:col-span-2 md:rounded-2xl md:p-10">
          <H2 id="perm-title">{t('permissionsTitle')}</H2>
          <Lead className="mt-3">{t('permissionsBody')}</Lead>
        </div>
        <div className="flex flex-col gap-4 rounded-[28px] bg-lilac p-7 md:rounded-2xl md:p-10">
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3.5 py-1.5 text-[13px] font-bold">
            <Icon name="building" size={14} />
            {t('hqTitle')}
          </span>
          <CheckList items={copy.hq} />
        </div>
        <div className="flex flex-col gap-4 rounded-[28px] bg-butter p-7 md:rounded-2xl md:p-10">
          <span className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3.5 py-1.5 text-[13px] font-bold">
            <Icon name="pin" size={14} />
            {t('localTitle')}
          </span>
          <CheckList items={copy.local} />
        </div>
      </section>

      {/* First release + connected systems */}
      <section aria-label={`${t('firstTitle')} · ${t('connectedTitle')}`} className="rail-wide grid gap-[var(--edge)] lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('firstTitle')}</h2>
          <p className="text-[15px] text-stone">{t('firstBody', { name })}</p>
          <CheckList items={copy.first} />
        </div>
        <div className="flex flex-col gap-4 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('connectedTitle')}</h2>
          <p className="text-[15px] text-stone">{t('connectedBody')}</p>
          <ul className="flex flex-col gap-2">
            {def.connected.map((id) => {
              const int = getIntegration(id);
              if (!int) return null;
              return (
                <li key={id} className="flex items-center justify-between gap-3 rounded-[16px] bg-canvas-raised px-4 py-3">
                  <span className="text-sm font-bold">{int.name}</span>
                  <StatusPill status={int.status} label={tc(`status.${int.status}`)} />
                </li>
              );
            })}
          </ul>
          <Link href="/integrations" className="inline-flex items-center gap-1.5 text-sm font-bold underline-offset-4 hover:underline">
            {ti('metaTitle')}
            <Icon name="arrow-right" size={15} className="rtl:-scale-x-100" />
          </Link>
        </div>
      </section>

      {/* Later capabilities + sample network */}
      <section aria-label={`${t('laterTitle')} · ${t('sampleTitle')}`} className="rail-wide grid gap-[var(--edge)] lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-[28px] border-[1.5px] border-dashed border-line bg-canvas-raised p-7 md:rounded-2xl md:p-10">
          <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('laterTitle')}</h2>
          <p className="text-[15px] text-stone">{t('laterBody')}</p>
          <ul className="flex flex-wrap gap-2">
            {copy.later.map((l) => (
              <li key={l} className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-[13px] font-bold">
                <Icon name="clock" size={13} />
                {l}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[28px] leading-tight font-extrabold tracking-[-0.03em]">{t('sampleTitle')}</h2>
            <SampleBadge>{tc('sampleData')}</SampleBadge>
          </div>
          <p className="text-[15px] text-stone">{t('sampleBody')}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {def.sampleLocations.map((l) => (
              <li key={l.name} className="flex flex-col gap-1 rounded-[16px] bg-canvas-raised p-4">
                <span className="text-sm font-bold">{l.name}</span>
                <span className="text-xs text-stone">{region.of(l.country)}</span>
                <span className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-bold">
                  <span className="rounded-full bg-surface px-2 py-0.5">
                    <span className="sr-only">{t('currency')}: </span>
                    {l.currency}
                  </span>
                  <span className="rounded-full bg-surface px-2 py-0.5">
                    <span className="sr-only">{t('timeZone')}: </span>
                    {l.timeZone}
                  </span>
                  <span className="rounded-full px-2 py-0.5" style={{ background: def.pastel }}>
                    {tc(`locationStatus.${l.status}`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Pricing path + FAQs */}
      <Panel labelledBy="ind-faq-title" className="grid gap-8 lg:grid-cols-[1fr_2fr]">
        <div className="flex flex-col items-start gap-4">
          <H2 id="ind-faq-title">{t('faqTitle', { name })}</H2>
          <div className="mt-2 flex flex-col items-start gap-3 rounded-[24px] bg-lilac p-6">
            <h3 className="text-lg font-extrabold">{t('pricingTitle')}</h3>
            <p className="text-sm leading-relaxed text-graphite">{t('pricingBody')}</p>
            <LinkButton href="/pricing" iconRight="arrow-right">
              {t('pricingCta')}
            </LinkButton>
          </div>
        </div>
        <FaqList items={copy.faqs} />
      </Panel>

      {/* Demo CTA */}
      <Panel tone="ink" labelledBy="ind-cta-title" className="flex flex-col items-center gap-5 text-center md:py-16">
        <PastelIcon name={def.icon} bg={def.pastel} size={56} />
        <H2 id="ind-cta-title" className="max-w-2xl">
          {t('ctaTitle', { name })}
        </H2>
        <p className="max-w-xl text-base leading-relaxed text-[#C9C9C3]">{t('ctaBody')}</p>
        <div className="flex flex-wrap justify-center gap-2.5">
          <LinkButton href={DEMO_URL} external size="lg" variant="light" iconRight="arrow-up-right">
            {tc('tryDemo')}
          </LinkButton>
          <LinkButton href={signUpUrl({ industry })} external size="lg" variant="onDark">
            {tc('startPlan')}
          </LinkButton>
        </div>
        <Link href={demoHref} className="text-sm font-bold text-white underline-offset-4 hover:underline">
          {tm(`${industry}.cta`)}
        </Link>
      </Panel>
    </>
  );
}
