import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LogoMark } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { LinkButton } from '@/components/site/LinkButton';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'sign-in');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001';

export default async function SignInPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('signIn');
  return (
    <section aria-labelledby="signin-title" className="flex min-h-[60vh] items-center justify-center rounded-[28px] bg-surface px-5 py-16 md:rounded-2xl">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <LogoMark size={56} />
        <h1 id="signin-title" className="text-[36px] leading-tight font-extrabold tracking-[-0.04em]">
          {t('title')}
        </h1>
        <p className="text-base leading-relaxed text-stone">{t('body')}</p>
        <LinkButton href={`${APP_URL}/sign-in?locale=${encodeURIComponent(locale)}`} external size="lg" signal="arrow-up-right">
          {t('cta')}
        </LinkButton>
        <p className="text-sm text-stone">
          {t('noAccount')}{' '}
          <Link href="/demo" className="font-bold text-ink underline">
            {t('demo')}
          </Link>
        </p>
      </div>
    </section>
  );
}
