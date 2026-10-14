import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { H2, PageHero, Panel, PastelIcon } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { PASTEL } from '@/content/images';
import { pageMetadata } from '@/components/site/meta';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => pageMetadata((await params).locale, 'support');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001';
const TOPICS: { icon: IconName; bg: string }[] = [
  { icon: 'calendar', bg: PASTEL.lilac },
  { icon: 'globe', bg: PASTEL.aqua },
  { icon: 'wordpress', bg: PASTEL.butter },
  { icon: 'card', bg: PASTEL.blush },
  { icon: 'users', bg: PASTEL.lime },
  { icon: 'sparkles', bg: PASTEL.sage },
];

export default async function SupportPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('support');
  const topics = t.raw('topics') as { t: string; d: string }[];
  return (
    <>
      <PageHero kicker={t('kicker')} kickerIcon="help" title={t('headline')} intro={t('intro')} />
      <Panel labelledBy="options-title">
        <H2 id="options-title">{t('optionsTitle')}</H2>
        <ul className="mt-8 grid gap-3 md:grid-cols-3">
          <li className="flex flex-col items-start gap-3 rounded-[24px] bg-lilac p-6">
            <PastelIcon name="users" bg="#fff" />
            <h3 className="text-lg font-extrabold">{t('options.customers.t')}</h3>
            <p className="text-[15px] leading-relaxed text-graphite">{t('options.customers.d')}</p>
            <LinkButton href={`${APP_URL}/`} external iconRight="arrow-up-right" className="mt-auto">
              {t('openApp')}
            </LinkButton>
          </li>
          <li className="flex flex-col items-start gap-3 rounded-[24px] bg-butter p-6">
            <PastelIcon name="message" bg="#fff" />
            <h3 className="text-lg font-extrabold">{t('options.prospects.t')}</h3>
            <p className="text-[15px] leading-relaxed text-graphite">{t('options.prospects.d')}</p>
            <LinkButton href="/demo" iconRight="arrow-right" className="mt-auto">
              {t('askQuestion')}
            </LinkButton>
          </li>
          <li className="flex flex-col items-start gap-3 rounded-[24px] bg-aqua p-6">
            <PastelIcon name="shield" bg="#fff" />
            <h3 className="text-lg font-extrabold">{t('options.security.t')}</h3>
            <p className="text-[15px] leading-relaxed text-graphite">{t('options.security.d')}</p>
            <LinkButton href="/security" iconRight="arrow-right" className="mt-auto">
              {t('securityLink')}
            </LinkButton>
          </li>
        </ul>
        <p className="mt-6 text-sm text-stone">{t('hoursNote')}</p>
      </Panel>
      <Panel labelledBy="topics-title">
        <H2 id="topics-title">{t('topicsTitle')}</H2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((x, i) => (
            <li key={x.t} className="flex items-center gap-4 rounded-[20px] border border-line-soft p-5">
              <PastelIcon name={TOPICS[i]?.icon ?? 'help'} bg={TOPICS[i]?.bg ?? PASTEL.canvas} />
              <div>
                <h3 className="font-extrabold">{x.t}</h3>
                <p className="text-sm text-stone">{x.d}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
