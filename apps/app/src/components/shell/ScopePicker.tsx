'use client';

import { useTranslations } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import { useApp } from './AppContext';
import { useBusinessMode } from '@/lib/useBusinessMode';

/** Always-visible scope selector: all authorised locations, a region, an owner group or a location. */
export function ScopePicker({ className, compact }: { className?: string; compact?: boolean }) {
  const t = useTranslations('shell');
  const app = useApp();
  const mode = useBusinessMode();
  if (mode.isIndependent) return <BusinessName className={className} />;
  const groups = (['all', 'region', 'owner_group', 'location'] as const).map((k) => ({ k, opts: app.scopes.filter((s) => s.kind === k) })).filter((g) => g.opts.length);
  return (
    <label className={cx('relative flex h-11 min-w-0 items-center gap-2 rounded-full border-[1.5px] border-ink bg-surface pl-3.5 pr-9 text-sm font-bold', className)}>
      <Icon name="layers" size={16} className="shrink-0" />
      <span className="sr-only">{t('scope')}</span>
      <select value={app.scopeId} onChange={(e) => app.setScopeId(e.target.value)} className={cx('h-10 min-w-0 flex-1 appearance-none truncate bg-transparent font-bold focus:outline-none', compact ? 'max-w-full' : 'max-w-[260px]')}>
        {groups.map((g) =>
          g.k === 'all' ? (
            g.opts.map((o) => (
              <option key={o.id} value={o.id}>
                {t('allLocations', { count: o.locationIds.length })}
              </option>
            ))
          ) : (
            <optgroup key={g.k} label={t(`scopeKind.${g.k}`)}>
              {g.opts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} ({o.locationIds.length})
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-3.5" />
    </label>
  );
}

/** Independent businesses have no scopes: the top bar shows the business (and where it is) instead. */
function BusinessName({ className }: { className?: string }) {
  const t = useTranslations('single');
  const mode = useBusinessMode();
  const city = mode.location?.address.city;
  return (
    <span className={cx('flex h-11 min-w-0 items-center gap-2 rounded-full bg-canvas px-3.5 text-sm font-bold', className)} aria-label={t('businessLabel', { name: mode.businessName })} data-testid="business-name">
      <Icon name="store" size={16} className="shrink-0" />
      <span className="truncate">{mode.businessName}</span>
      {city && <span className="hidden truncate text-xs font-semibold text-stone sm:inline">· {city}</span>}
    </span>
  );
}

/** Text label of the active scope, e.g. "Region: Europe (2)". Shown on reports, AI and bulk actions. */
export function useScopeLabel() {
  const t = useTranslations('shell');
  const app = useApp();
  const mode = useBusinessMode();
  if (mode.isIndependent) return mode.businessName;
  const s = app.scope;
  if (s.kind === 'all') return t('allLocations', { count: s.locationIds.length });
  return `${t(`scopeKind.${s.kind}`)}: ${s.label}${s.kind === 'location' ? '' : ` (${s.locationIds.length})`}`;
}

export function ScopeChip() {
  const label = useScopeLabel();
  const mode = useBusinessMode();
  // Independent businesses have one scope (the business), already named in every page header.
  if (mode.isIndependent) return null;
  return (
    <span className="inline-flex h-9 items-center gap-1.5 rounded-full bg-canvas px-3 text-xs font-semibold">
      <Icon name="pin" size={13} />
      {label}
    </span>
  );
}
