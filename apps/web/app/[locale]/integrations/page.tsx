import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { INTEGRATION_STATUSES } from '@/content/integrations';
import { PageHero, Panel, StatusPill } from '@/components/site/Blocks';
import { IntegrationCatalogue } from '@/components/integrations/IntegrationCatalogue';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'integrations' });
  return { title: t('metaTitle'), description: t('intro') };
}

export default async function IntegrationsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('integrations');
  const tc = await getTranslations('common');

  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="plug" title={t('headline')} intro={t('intro')} />
      <Panel labelledBy="catalogue-title">
        <h2 id="catalogue-title" className="sr-only">
          {t('metaTitle')}
        </h2>
        <IntegrationCatalogue />
      </Panel>
      <Panel labelledBy="status-help">
        <h2 id="status-help" className="text-[28px] font-extrabold tracking-[-0.03em]">
          {t('statusHelpTitle')}
        </h2>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {INTEGRATION_STATUSES.map((s) => (
            <div key={s} className="flex flex-col items-start gap-2.5 rounded-[20px] bg-canvas-raised p-5">
              <dt>
                <StatusPill status={s} label={tc(`status.${s}`)} />
              </dt>
              <dd className="text-sm leading-relaxed text-graphite">{t(`statusHelp.${s}`)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-xs leading-relaxed text-stone">{t('disclaimer')}</p>
      </Panel>
    </>
  );
}
