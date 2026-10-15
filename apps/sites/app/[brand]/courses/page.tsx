import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { listCourses } from '@/lib/courses';
import { money } from '@/lib/format';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand } = await params;
  const data = await loadBrand(brand);
  const t = await getTranslations('courses');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  return { title: `${t('title')} · ${data.brand.name}`, alternates: { canonical: links.brandCanonical('/courses') } };
}

/** Courses and trainings the brand sells to the public (e.g. teacher trainings). */
export default async function Courses({ params }: Props) {
  const { brand } = await params;
  const data = await loadBrand(brand);
  const t = await getTranslations('courses');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  const { items } = await listCourses(brand);
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{t('title')}</h1>
      <p className="mt-2 max-w-2xl text-graphite">{t('intro', { brand: data.brand.name })}</p>
      {!items.length ? <p className="mt-8 rounded-2xl bg-canvas p-6 text-graphite">{t('none')}</p> : (
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {items.map((c) => (
            <li key={c.slug}>
              <a href={links.brand(`/courses/${c.slug}`)} className="flex h-full flex-col gap-2 rounded-3xl border border-line-soft p-6 hover:border-ink">
                {c.category && <span className="text-xs font-bold uppercase tracking-wide text-graphite">{c.category}</span>}
                <span className="text-xl font-extrabold" dir="auto">{c.title}</span>
                {c.summary && <span className="text-graphite" dir="auto">{c.summary}</span>}
                <span className="mt-auto flex flex-wrap items-center gap-3 pt-2 text-sm font-semibold">
                  {c.price && <span>{money(c.price, locale)}</span>}
                  {c.startsOn && <span className="inline-flex items-center gap-1"><Icon name="calendar" size={15} />{t('starts', { date: new Date(`${c.startsOn}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) })}</span>}
                  {c.seatsLeft !== null && <span>{c.seatsLeft > 0 ? t('seatsLeft', { count: c.seatsLeft }) : t('full')}</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
