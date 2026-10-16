'use client';

import { useTranslations } from 'next-intl';
import { Field, Select } from '@bh/ui';
import { SCOPE_ORDER, type ScopeKind } from '@bh/shared';
import type { ScopesVM } from '@/lib/http/access';

export interface ScopeValue {
  kind: ScopeKind;
  id: string;
}

/** Every scope of the business by kind (brands only when there is more than one). */
export function scopesByKind(scopes: ScopesVM | null, orgId: string): Partial<Record<ScopeKind, { id: string; name: string }[]>> {
  if (!scopes) return { organization: [{ id: orgId, name: '' }] };
  return {
    organization: [{ id: orgId, name: '' }],
    ...(scopes.brands.length > 1 ? { brand: scopes.brands } : {}),
    territory: scopes.territories,
    region: scopes.regions,
    portfolio: scopes.portfolios,
    owner_group: scopes.ownerGroups,
    location: scopes.locations,
  };
}

/** The scope id the invitation API understands (`all`, `loc:…`, `group:…`, `territory:…`). */
export function inviteScopeId(v: ScopeValue): string {
  switch (v.kind) {
    case 'organization': return 'all';
    case 'location': return `loc:${v.id}`;
    case 'owner_group': return `group:${v.id}`;
    default: return `${v.kind}:${v.id}`;
  }
}

/**
 * Scope picker: first the kind of scope — the whole business, a brand, a territory (a sub-network such as a country),
 * a region, a portfolio (any named set of locations), an owner group or a location — then which one. Kinds without
 * any entry are not offered.
 */
export function ScopePicker({ scopes, orgId, value, onChange, kinds, testId = 'scope' }: { scopes: ScopesVM | null; orgId: string; value: ScopeValue; onChange: (v: ScopeValue) => void; kinds?: readonly ScopeKind[]; testId?: string }) {
  const t = useTranslations('access');
  const by = scopesByKind(scopes, orgId);
  const offered = SCOPE_ORDER.filter((k) => (by[k]?.length ?? 0) > 0 && (!kinds || kinds.includes(k)));
  const list = by[value.kind] ?? [];
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid={testId}>
      <Field label={t('scopes.scopeType')}>
        {(p) => (
          <Select id={p.id} value={value.kind} data-testid={`${testId}-kind`} onChange={(e) => { const k = e.target.value as ScopeKind; onChange({ kind: k, id: by[k]?.[0]?.id ?? '' }); }}>
            {offered.map((k) => <option key={k} value={k}>{t(`scopeKind.${k}`)}</option>)}
          </Select>
        )}
      </Field>
      {value.kind !== 'organization' && (
        <Field label={t(`scopeKind.${value.kind}`)}>
          {(p) => (
            <Select id={p.id} value={value.id} data-testid={`${testId}-target`} onChange={(e) => onChange({ kind: value.kind, id: e.target.value })}>
              {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}
