import { getTranslations } from 'next-intl/server';
import { LinkButton } from '@/components/site/LinkButton';

export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <section className="flex min-h-[50vh] flex-col items-center justify-center gap-4 rounded-[28px] bg-surface px-5 py-16 text-center md:rounded-2xl">
      <p className="text-label font-extrabold text-stone uppercase">404</p>
      <h1 className="text-[36px] leading-tight font-extrabold tracking-[-0.04em]">{t('title')}</h1>
      <p className="text-stone">{t('body')}</p>
      <LinkButton href="/">{t('home')}</LinkButton>
    </section>
  );
}
