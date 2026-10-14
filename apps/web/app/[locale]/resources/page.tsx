import { getTranslations, setRequestLocale } from 'next-intl/server';
import { PageHero, Panel } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { GuideList } from '@/components/resources/GuideList';
import { pageMetadata } from '@/components/site/meta';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => pageMetadata((await params).locale, 'resources');

export default async function ResourcesPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('resources');
  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="book" title={t('headline')} intro={t('intro')} />
      <Panel labelledBy="guides-title">
        <h2 id="guides-title" className="sr-only">
          {t('kicker')}
        </h2>
        <GuideList />
      </Panel>
      <Panel tone="lilac" className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
        <p className="text-xl font-extrabold tracking-[-0.02em]">{t('docsCta')}</p>
        <LinkButton href="/docs" iconRight="arrow-right">
          {t('docsLink')}
        </LinkButton>
      </Panel>
    </>
  );
}
