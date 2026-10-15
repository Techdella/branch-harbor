import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { Icon } from '@/components/ui';
import { PASTEL } from '@/content/images';
import type { IntegrationStatus } from '@/content/integrations';
import { CheckList, H2, Lead, PageHero, Panel, PastelIcon, SampleBadge, StatusPill } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'wordpress');

const PREVIEW: { icon: IconName; bg: string }[] = [
  { icon: 'wordpress', bg: PASTEL.signal },
  { icon: 'pin', bg: PASTEL.butter },
  { icon: 'bag', bg: PASTEL.signal },
  { icon: 'file', bg: PASTEL.aqua },
];
const STEP_STYLE: { icon: IconName; bg: string }[] = [
  { icon: 'search', bg: PASTEL.butter },
  { icon: 'plug', bg: PASTEL.aqua },
  { icon: 'key', bg: PASTEL.lilac },
  { icon: 'pin', bg: PASTEL.lime },
  { icon: 'refresh', bg: PASTEL.blush },
  { icon: 'check-circle', bg: PASTEL.sage },
];

export default async function WordPressPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('wordpress');
  const tc = await getTranslations('common');
  const preview = t.raw('preview') as { n: string; s: string }[];
  const steps = t.raw('steps') as { t: string; d: string }[];
  const matrix = t.raw('matrix') as { cat: string; status: IntegrationStatus; ver: string; does: string; limit: string }[];

  return (
    <>
      <PageHero
        kicker={t('kicker')}
        kickerIcon="wordpress"
        title={t('headline')}
        intro={t('intro')}
        aside={
          <div className="rounded-[24px] bg-butter p-3 sm:p-4">
            <div className="rounded-[18px] bg-surface">
              <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
                <Icon name="plug" size={16} />
                <span className="text-sm font-bold">{t('previewTitle')}</span>
                <SampleBadge className="ms-auto">{tc('sampleData')}</SampleBadge>
              </div>
              <ul className="flex flex-col p-2">
                {preview.map((p, i) => (
                  <li key={p.n} className="flex items-center gap-3 rounded-[14px] px-3 py-3 odd:bg-canvas-raised">
                    <PastelIcon name={PREVIEW[i]?.icon ?? 'check'} bg={PASTEL.canvas} size={36} />
                    <span className="flex-1 text-sm font-bold">{p.n}</span>
                    <span className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ background: PREVIEW[i]?.bg }}>
                      {p.s}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        }
      >
        <div className="flex flex-wrap gap-2.5">
          <LinkButton href="/integrations" size="lg" signal="arrow-right">
            {t('primary')}
          </LinkButton>
          <LinkButton href="/demo" size="lg" variant="secondary">
            {t('secondary')}
          </LinkButton>
        </div>
      </PageHero>

      <Panel labelledBy="wp-steps">
        <H2 id="wp-steps">{t('stepsTitle')}</H2>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.t} className="flex flex-col gap-3 rounded-[24px] bg-canvas-raised p-6">
              <div className="flex items-center justify-between">
                <PastelIcon name={STEP_STYLE[i]?.icon ?? 'check'} bg={STEP_STYLE[i]?.bg ?? PASTEL.canvas} />
                <span className="text-sm font-extrabold text-mute" aria-hidden="true">
                  0{i + 1}
                </span>
              </div>
              <h3 className="text-lg font-extrabold">{s.t}</h3>
              <p className="text-[15px] leading-relaxed text-stone">{s.d}</p>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel labelledBy="wp-matrix">
        <H2 id="wp-matrix">{t('matrixTitle')}</H2>
        <Lead className="mt-3">{t('matrixBody')}</Lead>
        <div className="mt-8 hidden md:block">
          <table className="w-full border-collapse text-start text-sm">
            <thead>
              <tr className="border-b border-line-soft">
                {(['category', 'status', 'tested', 'does', 'limits'] as const).map((h) => (
                  <th key={h} scope="col" className="px-3 py-3 text-start text-xs font-extrabold tracking-[0.06em] text-stone uppercase">
                    {t(`matrixHead.${h}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((m) => (
                <tr key={m.cat} className="border-b border-line-soft last:border-0">
                  <th scope="row" className="px-3 py-4 text-start font-bold">
                    {m.cat}
                  </th>
                  <td className="px-3 py-4">
                    <StatusPill status={m.status} label={tc(`status.${m.status}`)} />
                  </td>
                  <td className="px-3 py-4 text-graphite">{m.ver}</td>
                  <td className="px-3 py-4 text-graphite">{m.does}</td>
                  <td className="px-3 py-4 text-graphite">{m.limit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-8 flex flex-col gap-2 md:hidden">
          {matrix.map((m) => (
            <li key={m.cat} className="flex flex-col gap-2 rounded-[18px] border border-line-soft p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">{m.cat}</span>
                <StatusPill status={m.status} label={tc(`status.${m.status}`)} />
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="font-bold text-stone">{t('matrixHead.tested')}</dt>
                <dd>{m.ver}</dd>
                <dt className="font-bold text-stone">{t('matrixHead.does')}</dt>
                <dd>{m.does}</dd>
                <dt className="font-bold text-stone">{t('matrixHead.limits')}</dt>
                <dd>{m.limit}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </Panel>

      <section aria-label={`${t('prereqTitle')} · ${t('neverTitle')}`} className="grid gap-[var(--edge)] md:grid-cols-2">
        <div className="flex flex-col gap-5 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <h2 className="text-[28px] font-extrabold tracking-[-0.03em]">{t('prereqTitle')}</h2>
          <CheckList items={t.raw('prereq') as string[]} />
        </div>
        <div className="flex flex-col gap-5 rounded-[28px] bg-blush p-7 md:rounded-2xl md:p-10">
          <h2 className="text-[28px] font-extrabold tracking-[-0.03em]">{t('neverTitle')}</h2>
          <CheckList items={t.raw('never') as string[]} icon="x" />
        </div>
      </section>
    </>
  );
}
