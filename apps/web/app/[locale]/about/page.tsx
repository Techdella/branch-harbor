import Image from 'next/image';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { IconName } from '@bh/icons';
import { H2, Lead, PageHero, Panel, PastelIcon } from '@/components/site/Blocks';
import { LinkButton } from '@/components/site/LinkButton';
import { IMG, PASTEL } from '@/content/images';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };
export const generateMetadata = async ({ params }: Props) => buildMetadata((await params).locale, 'about');

const P: { icon: IconName; bg: string }[] = [
  { icon: 'heart', bg: PASTEL.blush },
  { icon: 'pin', bg: PASTEL.lilac },
  { icon: 'shield', bg: PASTEL.butter },
  { icon: 'users', bg: PASTEL.lime },
];

export default async function AboutPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('about');
  const principles = t.raw('principles') as { t: string; d: string }[];
  return (
    <>
      <PageHero
        kicker={t('kicker')}
        kickerIcon="heart"
        title={t('headline')}
        intro={t('intro')}
        aside={
          <div className="relative min-h-[280px] overflow-hidden rounded-[24px] bg-sand md:min-h-[380px]">
            <Image src={IMG.team} alt="" fill priority sizes="(min-width: 1024px) 45vw, 100vw" className="object-cover" />
          </div>
        }
      />
      <Panel labelledBy="purpose-title" className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <H2 id="purpose-title">{t('purposeTitle')}</H2>
        <Lead>{t('purpose')}</Lead>
      </Panel>
      <Panel labelledBy="principles-title">
        <H2 id="principles-title">{t('principlesTitle')}</H2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {principles.map((p, i) => (
            <li key={p.t} className="flex flex-col gap-3 rounded-[24px] bg-canvas-raised p-6">
              <PastelIcon name={P[i]?.icon ?? 'check'} bg={P[i]?.bg ?? PASTEL.canvas} />
              <h3 className="text-lg font-extrabold">{p.t}</h3>
              <p className="text-[15px] leading-relaxed text-stone">{p.d}</p>
            </li>
          ))}
        </ul>
      </Panel>
      <section aria-label={`${t('companyTitle')} · ${t('contactTitle')}`} className="rail-wide grid gap-[var(--edge)] md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-[28px] bg-surface p-7 md:rounded-2xl md:p-10">
          <h2 className="text-[26px] font-extrabold tracking-[-0.03em]">{t('companyTitle')}</h2>
          <p className="text-[15px] leading-relaxed text-stone">{t('company')}</p>
        </div>
        <div className="flex flex-col items-start gap-3 rounded-[28px] bg-ink p-7 text-white md:rounded-2xl md:p-10">
          <h2 className="text-[26px] font-extrabold tracking-[-0.03em]">{t('contactTitle')}</h2>
          <p className="text-[15px] leading-relaxed text-[#C9C9C3]">{t('contactBody')}</p>
          <LinkButton href="/demo" variant="light" iconRight="arrow-right" className="mt-2">
            {t('contactCta')}
          </LinkButton>
        </div>
      </section>
    </>
  );
}
