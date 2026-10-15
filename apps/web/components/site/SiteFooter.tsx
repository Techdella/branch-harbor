import { getTranslations } from 'next-intl/server';
import { Logo } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { INDUSTRY_KEYS } from '@/content/industries';
import { LanguageSwitcher } from './LanguageSwitcher';
import { CookieSettingsButton } from '@/components/consent/CookieBanner';

export async function SiteFooter() {
  const t = await getTranslations('footer');
  const tm = await getTranslations('industryMeta');

  const cols: { title: string; links: { href: string; label: string }[] }[] = [
    { title: t('industries'), links: INDUSTRY_KEYS.map((k) => ({ href: `/industries/${k}`, label: tm(`${k}.name`) })) },
    {
      title: t('product'),
      links: [
        { href: '/solutions/franchises', label: t('franchises') },
        { href: '/solutions/independent-businesses', label: t('independent') },
        { href: '/wordpress', label: t('wordpress') },
        { href: '/integrations', label: t('integrations') },
        { href: '/pricing', label: t('pricing') },
        { href: '/demo', label: t('demo') },
      ],
    },
    {
      title: t('company'),
      links: [
        { href: '/resources', label: t('resources') },
        { href: '/docs', label: t('docs') },
        { href: '/support', label: t('support') },
        { href: '/about', label: t('about') },
      ],
    },
    {
      title: t('policies'),
      links: [
        { href: '/privacy', label: t('privacy') },
        { href: '/terms', label: t('terms') },
        { href: '/security', label: t('security') },
      ],
    },
  ];

  return (
    <footer className="rounded-[28px] bg-ink px-6 pt-10 pb-7 text-white md:rounded-2xl md:px-12 md:pt-14">
      <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]">
        <div className="col-span-2 flex flex-col gap-4 lg:col-span-1">
          <Logo size={34} dark />
          <p className="max-w-60 text-sm leading-relaxed text-[#B9B9B3]">{t('tagline')}</p>
          <LanguageSwitcher dark />
        </div>
        {cols.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <h2 className="mb-3 text-xs font-bold text-[#a3a39d]">{c.title}</h2>
            <ul className="flex flex-col md:gap-2.5">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="flex min-h-11 items-center text-sm font-medium text-white hover:text-lime md:inline md:min-h-0">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mt-10 flex flex-col gap-2 border-t border-[#2A2A2A] pt-5 text-xs leading-relaxed text-[#a3a39d] md:flex-row md:justify-between">
        <p>
          {t('copyright', { year: new Date().getFullYear() })} · {t('note')}
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          <CookieSettingsButton className="font-bold text-white underline-offset-4 hover:underline" />
          <span>{t('credits')}</span>
        </p>
      </div>
    </footer>
  );
}
