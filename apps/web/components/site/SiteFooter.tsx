import { ASSISTANT_NAME } from '@bh/shared';
import { getTranslations } from 'next-intl/server';
import { Icon, Logo } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { INDUSTRY_KEYS } from '@/content/industries';
import { CONTACT_EMAIL, DEMO_URL, otherIndustryMailto } from '@/lib/links';
import { LanguageSwitcher } from './LanguageSwitcher';
import { CookieSettingsButton } from '@/components/consent/CookieBanner';

type FooterLink = { href: string; label: string; external?: boolean };

export async function SiteFooter() {
  const t = await getTranslations('footer');
  const tm = await getTranslations('industryMeta');
  const tn = await getTranslations('nav');
  const tc = await getTranslations('common');

  const cols: { title: string; links: FooterLink[] }[] = [
    {
      title: t('industries'),
      links: [
        ...INDUSTRY_KEYS.map((k) => ({ href: `/industries/${k}`, label: tm(`${k}.name`) })),
        { href: otherIndustryMailto(tn('otherIndustrySubject')), label: t('otherIndustry'), external: true },
      ],
    },
    {
      title: t('product'),
      links: [
        { href: '/solutions/franchises', label: t('franchises') },
        { href: '/solutions/independent-businesses', label: t('independent') },
        { href: '/wordpress', label: t('wordpress') },
        { href: '/integrations', label: t('integrations') },
        { href: '/marina', label: ASSISTANT_NAME },
        { href: '/pricing', label: t('pricing') },
        { href: DEMO_URL, label: tc('tryDemo'), external: true },
        { href: '/demo', label: t('demo') },
      ],
    },
    {
      title: t('resources'),
      links: [
        { href: '/blog', label: t('blog') },
        { href: '/guides', label: t('guides') },
        { href: '/resources', label: t('resources') },
        { href: '/docs', label: t('docs') },
        { href: '/support', label: t('support') },
      ],
    },
    {
      title: t('company'),
      links: [
        { href: '/about', label: t('about') },
        { href: '/privacy', label: t('privacy') },
        { href: '/terms', label: t('terms') },
        { href: '/security', label: t('security') },
      ],
    },
  ];

  const linkCls = 'flex min-h-11 items-center gap-1 text-sm font-medium text-white transition hover:text-lime focus-visible:text-lime md:inline-flex md:min-h-0';

  return (
    <footer className="band rounded-[28px] bg-ink pt-10 pb-7 text-white md:rounded-2xl md:pt-16">
      <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4 lg:grid-cols-[1.5fr_repeat(4,minmax(0,1fr))] lg:gap-x-10">
        <div className="col-span-2 flex flex-col gap-4 md:col-span-4 lg:col-span-1">
          <Logo size={34} dark />
          <p className="max-w-64 text-sm leading-relaxed text-[#B9B9B3]">{t('tagline')}</p>
          <LanguageSwitcher dark />
        </div>
        {cols.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <h2 className="mb-3 text-xs font-bold tracking-[0.06em] text-[#a3a39d] uppercase">{c.title}</h2>
            <ul className="flex flex-col md:gap-2.5">
              {c.links.map((l) => (
                <li key={l.href}>
                  {l.external ? (
                    <a href={l.href} className={linkCls}>
                      {l.label}
                      {l.href.startsWith('http') && <Icon name="arrow-up-right" size={13} className="text-[#a3a39d]" />}
                    </a>
                  ) : (
                    <Link href={l.href} className={linkCls}>
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mt-10 flex flex-col gap-2 border-t border-[#2A2A2A] pt-5 text-xs leading-relaxed text-[#a3a39d] md:flex-row md:items-center md:justify-between">
        <p>
          {t('copyright', { year: new Date().getFullYear() })} · {t('note')}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>{t('contact', { email: CONTACT_EMAIL })}</span>
          <CookieSettingsButton className="font-bold text-white underline-offset-4 hover:underline" />
          <span>{t('credits')}</span>
        </p>
      </div>
    </footer>
  );
}
