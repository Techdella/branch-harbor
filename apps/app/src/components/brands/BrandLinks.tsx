'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Field, Icon, Select } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { SectionCard } from '../ui/States';
import { BrandMark } from './BrandsScreen';

/** Reports → Brand comparison (multi-brand HQ only). */
export function BrandComparisonLink() {
  const t = useTranslations('brands');
  return (
    <Link href="/reports/brands" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-white">
      <Icon name="layers" size={16} />
      {t('compare.link')}
    </Link>
  );
}

/**
 * Settings → Brands. A multi-brand business sees its brands; a single-brand network sees one line offering to add a
 * brand (owners and business-settings editors only) and nothing else.
 */
export function BrandsCard() {
  const t = useTranslations('brands');
  const app = useApp();
  if (!app.orgMultiBrand) {
    if (!app.canManageBrands) return null;
    return (
      <p className="flex flex-wrap items-center gap-2 px-1 text-sm text-stone">
        {t('settings.singleHint')}
        <Link href="/settings/brands" className="font-bold text-ink underline">{t('settings.add')}</Link>
      </p>
    );
  }
  return (
    <SectionCard title={t('settings.title')} aside={<Link href="/settings/brands" className="text-sm font-bold underline">{t('settings.manage')}</Link>}>
      <ul className="flex flex-wrap gap-2" data-testid="brands-card">
        {app.brands.map((b) => (
          <li key={b.id} className="flex items-center gap-2 rounded-full bg-canvas py-1 pl-1 pr-3 text-sm font-semibold">
            <BrandMark brand={b} size={28} />
            {b.name}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** Multi-brand HQ: the brand a franchise prospect is buying. Hidden for single-brand businesses. */
export function BrandSelect({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const t = useTranslations('brands');
  const app = useApp();
  if (!app.multiBrand) return null;
  const main = app.brands.find((b) => b.isDefault) ?? app.brands[0];
  return (
    <Field label={t('buying')}>
      {(p) => (
        <Select id={p.id} value={value ?? main?.id ?? ''} onChange={(e) => onChange(e.target.value || null)} data-testid="brand-select">
          {app.brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
