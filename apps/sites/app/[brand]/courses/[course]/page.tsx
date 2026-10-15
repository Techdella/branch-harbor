import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { CourseCheckout } from '@/components/courses/CourseCheckout';
import { isNotFound } from '@/lib/api';
import { getCourse } from '@/lib/courses';
import { money } from '@/lib/format';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; course: string }> };

async function load(brand: string, course: string) {
  try {
    return await getCourse(brand, course);
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, course } = await params;
  const data = await loadBrand(brand);
  const { course: c } = await load(brand, course);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  return { title: `${c.title} · ${data.brand.name}`, description: c.summary ?? undefined, alternates: { canonical: links.brandCanonical(`/courses/${c.slug}`) } };
}

/** Course landing page: details, curriculum, enquiry (lead) and online enrolment with card payment. */
export default async function CoursePage({ params }: Props) {
  const { brand, course } = await params;
  const data = await loadBrand(brand);
  const { course: c } = await load(brand, course);
  const t = await getTranslations('courses');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  const starts = c.startsOn ? new Date(`${c.startsOn}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <a href={links.brand('/courses')} className="inline-flex items-center gap-1 text-sm font-semibold text-graphite hover:text-ink"><Icon name="arrow-left" size={15} />{t('all')}</a>
      <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_380px]">
        <article>
          {c.category && <p className="text-xs font-bold uppercase tracking-wide text-graphite">{c.category}</p>}
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl" dir="auto">{c.title}</h1>
          {c.summary && <p className="mt-3 text-lg text-graphite" dir="auto">{c.summary}</p>}
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            {starts && <div className="rounded-2xl bg-canvas p-4"><dt className="text-xs text-graphite">{t('startsLabel')}</dt><dd className="font-bold">{starts}</dd></div>}
            {c.scheduleNote && <div className="rounded-2xl bg-canvas p-4"><dt className="text-xs text-graphite">{t('schedule')}</dt><dd className="font-bold" dir="auto">{c.scheduleNote}</dd></div>}
            {c.trainers.length > 0 && <div className="rounded-2xl bg-canvas p-4"><dt className="text-xs text-graphite">{t('trainers')}</dt><dd className="font-bold">{c.trainers.join(', ')}</dd></div>}
            {c.certificate && <div className="rounded-2xl bg-canvas p-4"><dt className="text-xs text-graphite">{t('certificateLabel')}</dt><dd className="font-bold">{t('certificate')}</dd></div>}
          </dl>
          {c.description && <div className="mt-6 whitespace-pre-line leading-relaxed" dir="auto">{c.description}</div>}
          {c.outline && c.outline.length > 0 && (
            <section className="mt-8" aria-labelledby="curriculum">
              <h2 id="curriculum" className="text-xl font-extrabold">{t('curriculum')}</h2>
              <ol className="mt-3 space-y-3">
                {c.outline.map((m, i) => (
                  <li key={i} className="rounded-2xl border border-line-soft p-4">
                    <p className="font-bold" dir="auto">{m.title}</p>
                    <ul className="mt-1 list-disc ps-5 text-sm text-graphite">{m.lessons.map((l, j) => <li key={j} dir="auto">{l.title}</li>)}</ul>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </article>
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-3xl border border-line-soft p-6 shadow-sm">
            {c.price && <p className="text-3xl font-extrabold">{money(c.price, locale)}</p>}
            {c.seatsLeft !== null && <p className="mt-1 text-sm font-semibold text-graphite">{c.seatsLeft > 0 ? t('seatsLeft', { count: c.seatsLeft }) : t('full')}</p>}
            <CourseCheckout brand={brand} slug={c.slug} title={c.title} price={c.price} purchasable={c.purchasable && (c.seatsLeft === null || c.seatsLeft > 0)} />
          </div>
        </aside>
      </div>
    </main>
  );
}
