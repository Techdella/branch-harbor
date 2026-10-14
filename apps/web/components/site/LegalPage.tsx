import { getTranslations } from 'next-intl/server';
import { Icon } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { Panel } from './Blocks';

type Doc = 'privacy' | 'terms' | 'security';
const DOCS: { key: Doc; icon: 'eye' | 'file' | 'shield' }[] = [
  { key: 'privacy', icon: 'eye' },
  { key: 'terms', icon: 'file' },
  { key: 'security', icon: 'shield' },
];

/** Policy page. Clearly marked as a draft pending legal review. */
export async function LegalPage({ doc }: { doc: Doc }) {
  const t = await getTranslations('legal');
  const tc = await getTranslations('common');
  const tf = await getTranslations('footer');
  const sections = t.raw(`${doc}.sections`) as { h: string; p: string[] }[];
  const slug = (i: number) => `section-${i + 1}`;

  return (
    <Panel labelledBy="legal-title" className="grid gap-10 lg:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-6 lg:sticky lg:top-4 lg:self-start">
        <nav aria-label={tf('policies')}>
          <ul className="flex flex-wrap gap-1 rounded-full bg-canvas p-1 lg:flex-col lg:rounded-[20px]">
            {DOCS.map((d) => (
              <li key={d.key}>
                <Link
                  href={`/${d.key}`}
                  aria-current={d.key === doc ? 'page' : undefined}
                  className={`flex h-10 items-center gap-2 rounded-full px-4 text-sm font-bold ${d.key === doc ? 'bg-ink text-white' : 'hover:bg-surface'}`}
                >
                  <Icon name={d.icon} size={15} />
                  {tf(d.key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label={t('contents')} className="hidden lg:block">
          <p className="mb-2 text-xs font-bold text-stone">{t('contents')}</p>
          <ol className="flex flex-col gap-1.5 text-sm">
            {sections.map((s, i) => (
              <li key={s.h}>
                <a href={`#${slug(i)}`} className="text-graphite hover:text-ink hover:underline">
                  {s.h}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </aside>
      <article className="flex max-w-3xl flex-col gap-6">
        <div role="note" className="flex items-start gap-3 rounded-[20px] bg-warning-bg p-5 text-warning">
          <Icon name="alert" size={20} stroke={2.2} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-extrabold">{tc('draftLegal')}</p>
            <p className="mt-1 text-sm">{tc('draftLegalBody')}</p>
          </div>
        </div>
        <h1 id="legal-title" className="text-[38px] leading-[1.05] font-extrabold tracking-[-0.045em] md:text-[52px]">
          {t(`${doc}.title`)}
        </h1>
        <p className="text-sm font-semibold text-stone">{tc('lastUpdated', { date: t('updated') })}</p>
        <p className="text-lg leading-relaxed text-graphite">{t(`${doc}.intro`)}</p>
        {sections.map((s, i) => (
          <section key={s.h} id={slug(i)} aria-labelledby={`${slug(i)}-h`} className="scroll-mt-4 border-t border-line-soft pt-6">
            <h2 id={`${slug(i)}-h`} className="text-[22px] font-extrabold tracking-[-0.02em]">
              {i + 1}. {s.h}
            </h2>
            {s.p.map((para) => (
              <p key={para} className="mt-3 text-[15px] leading-relaxed text-graphite">
                {para}
              </p>
            ))}
          </section>
        ))}
      </article>
    </Panel>
  );
}
