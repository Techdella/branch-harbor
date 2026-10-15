import { Suspense } from 'react';
import Image from 'next/image';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { IMG } from '@/content/images';
import { Kicker, Lead } from '@/components/site/Blocks';
import { DemoForm } from '@/components/demo/DemoForm';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'demo');

export default async function DemoPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('demo');
  const aside = t.raw('aside') as string[];

  return (
    <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
      <section aria-labelledby="demo-title" className="rounded-[28px] bg-surface px-5 py-10 sm:px-8 md:rounded-2xl md:px-12 md:py-14">
        <div className="mb-10 flex flex-col items-start gap-5">
          <Kicker icon="calendar">{t('kicker')}</Kicker>
          <h1 id="demo-title" className="text-[38px] leading-[1.03] font-extrabold tracking-[-0.045em] md:text-[52px]">
            {t('headline')}
          </h1>
          <Lead>{t('intro')}</Lead>
        </div>
        {/* The form renders on the client (search params); reserve its height so the page doesn't jump. */}
        <Suspense fallback={<div aria-hidden="true" className="min-h-[1500px] md:min-h-[1000px]" />}>
          <DemoForm />
        </Suspense>
      </section>
      <aside aria-labelledby="next-title" className="flex flex-col gap-3">
        <div className="relative min-h-[280px] overflow-hidden rounded-[28px] bg-lilac md:rounded-2xl">
          <Image src={IMG.yogaStretch} alt={t('imageAlt')} fill priority sizes="(min-width: 1024px) 35vw, 100vw" className="object-cover" />
        </div>
        <div className="flex flex-col gap-4 rounded-[28px] bg-lilac p-7 md:rounded-2xl">
          <h2 id="next-title" className="text-xl font-extrabold tracking-[-0.02em]">
            {t('asideTitle')}
          </h2>
          <ol className="flex flex-col gap-3">
            {aside.map((a, i) => (
              <li key={a} className="flex gap-3 text-sm leading-relaxed">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-extrabold">{i + 1}</span>
                {a}
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
