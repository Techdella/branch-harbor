import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { IMG, PASTEL } from '@/content/images';
import { H2, Lead, Panel, PastelIcon, PageHero } from './Blocks';
import { LinkButton } from './LinkButton';

type Key = 'franchises' | 'independent';

const META: Record<Key, { icon: IconName; img: string; points: { icon: IconName; bg: string }[]; href: string }> = {
  franchises: {
    icon: 'building',
    img: IMG.yogaStudio,
    href: '/demo',
    points: [
      { icon: 'layers', bg: PASTEL.lilac },
      { icon: 'lock', bg: PASTEL.butter },
      { icon: 'shield', bg: PASTEL.aqua },
      { icon: 'refresh', bg: PASTEL.lime },
    ],
  },
  independent: {
    icon: 'store',
    img: IMG.shopOpen,
    href: '/demo',
    points: [
      { icon: 'zap', bg: PASTEL.butter },
      { icon: 'globe', bg: PASTEL.aqua },
      { icon: 'plug', bg: PASTEL.lime },
      { icon: 'sparkles', bg: PASTEL.lilac },
    ],
  },
};

const INTL_ICONS: IconName[] = ['clock', 'globe', 'shield'];

export async function SolutionPage({ which }: { which: Key }) {
  const t = await getTranslations(`solutions`);
  const m = META[which];
  const points = t.raw(`${which}.points`) as { t: string; d: string }[];
  const steps = t.raw(`${which}.steps`) as { t: string; d: string }[];
  const intl = which === 'franchises' ? (t.raw('franchises.intl') as { t: string; d: string }[]) : null;

  return (
    <>
      <PageHero
        kicker={t(`${which}.kicker`)}
        kickerIcon={m.icon}
        title={t(`${which}.headline`)}
        intro={t(`${which}.intro`)}
        aside={
          <div className="relative min-h-[280px] overflow-hidden rounded-[24px] bg-lilac md:min-h-[400px]">
            <Image src={m.img} alt={t(`${which}.imageAlt`)} fill priority sizes="(min-width: 1024px) 45vw, 100vw" className="object-cover" />
          </div>
        }
      >
        <LinkButton href={m.href} size="lg" signal="arrow-up-right">
          {t(`${which}.cta`)}
        </LinkButton>
      </PageHero>

      <Panel labelledBy="points-title">
        <H2 id="points-title">{t('pointsTitle')}</H2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {points.map((p, i) => (
            <li key={p.t} className="flex gap-4 rounded-[24px] bg-canvas-raised p-6">
              <PastelIcon name={m.points[i]?.icon ?? 'check'} bg={m.points[i]?.bg ?? PASTEL.canvas} />
              <div className="flex flex-col gap-1.5">
                <h3 className="text-lg font-extrabold tracking-[-0.02em]">{p.t}</h3>
                <p className="text-[15px] leading-relaxed text-stone">{p.d}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel labelledBy="steps-title">
        <H2 id="steps-title">{t(`${which}.stepsTitle`)}</H2>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.t} className="flex flex-col gap-2 rounded-[24px] border border-line-soft p-6">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-sm font-extrabold text-white">{i + 1}</span>
              <h3 className="mt-2 text-lg font-extrabold tracking-[-0.02em]">{s.t}</h3>
              <p className="text-[15px] leading-relaxed text-stone">{s.d}</p>
            </li>
          ))}
        </ol>
      </Panel>

      {intl && (
        <Panel labelledBy="intl-title" tone="aqua">
          <H2 id="intl-title">{t('franchises.intlTitle')}</H2>
          <ul className="mt-8 grid gap-3 md:grid-cols-3">
            {intl.map((p, i) => (
              <li key={p.t} className="flex flex-col gap-3 rounded-[24px] bg-surface p-6">
                <PastelIcon name={INTL_ICONS[i] ?? 'globe'} bg={PASTEL.aqua} />
                <h3 className="text-lg font-extrabold tracking-[-0.02em]">{p.t}</h3>
                <p className="text-[15px] leading-relaxed text-stone">{p.d}</p>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel tone="sage" labelledBy="sol-cta" className="flex flex-col items-center gap-5 text-center">
        <H2 id="sol-cta" className="max-w-2xl">
          {t('ctaTitle')}
        </H2>
        <p className="max-w-xl text-base leading-relaxed text-[#E6EEE7] md:text-lg">{t('ctaBody')}</p>
        <LinkButton href="/demo" size="lg" variant="light" iconRight="arrow-up-right">
          {t(`${which}.cta`)}
        </LinkButton>
      </Panel>
    </>
  );
}
