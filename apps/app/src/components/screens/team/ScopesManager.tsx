'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, cx } from '@bh/ui';
import { accessApi, useAccess, useAccessAction, type AssignmentListItemVM, type RolesVM, type ScopesVM } from '@/lib/http/access';
import { useApi } from '@/lib/useApi';
import { useApp } from '../../shell/AppContext';
import { Async, Banner, LoadingBlock } from '../../ui/States';
import { RoleOptions } from './AccessEditor';

type Kind = 'portfolio' | 'territory';
const TERRITORY_KINDS = ['master', 'development', 'support'] as const;

interface Draft {
  kind: Kind;
  id: string | null;
  name: string;
  territoryKind: string;
  country: string;
  locationIds: Set<string>;
}

/**
 * Team & access → Portfolios and territories: create, rename, change locations (location picker) and delete, and
 * assign people to them. A portfolio is any named set of locations (a field consultant's); a territory is a
 * sub-network such as a country run by a master franchisee. A scope someone is assigned to can't be deleted.
 */
export function ScopesManager() {
  const t = useTranslations('access.scopes');
  const app = useApp();
  const res = useAccess(() => Promise.all([accessApi.scopes(), accessApi.assignments(), accessApi.roles()]), [app.org.id]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const del = useAccessAction((kind: Kind, id: string) => (kind === 'portfolio' ? accessApi.deletePortfolio(id) : accessApi.deleteTerritory(id)));
  const [confirming, setConfirming] = useState<string | null>(null);
  if (app.org.model === 'independent') return null;
  const canTerritory = app.capabilities.has('network.locations:edit');
  const fresh = (kind: Kind): Draft => ({ kind, id: null, name: '', territoryKind: 'master', country: '', locationIds: new Set() });
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {([scopes, assignments, roles]) => {
        const locName = (id: string) => scopes.locations.find((l) => l.id === id)?.name ?? id;
        const people = (kind: Kind, id: string) => assignments.items.filter((a) => a.scope.kind === kind && a.scope.id === id);
        const card = (kind: Kind, x: { id: string; name: string; locationIds: string[]; kind?: string; country?: string | null }) => {
          const who = people(kind, x.id);
          return (
            <li key={x.id} className="flex flex-col gap-2 rounded-lg bg-canvas p-3.5" data-testid={`scope-${kind}-${x.name}`}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <strong className="text-sm">{x.name}</strong>
                  <span className="block text-xs text-stone">
                    {kind === 'territory' && x.kind ? `${t(`kinds.${x.kind}`)}${x.country ? ` · ${x.country}` : ''} · ` : ''}
                    {t('locationCount', { count: x.locationIds.length })}
                  </span>
                </div>
                {(kind === 'portfolio' || canTerritory) && (
                  <span className="flex gap-1.5">
                    <Button size="sm" variant="secondary" icon="edit" onClick={() => (setNotice(''), setDraft({ kind, id: x.id, name: x.name, territoryKind: x.kind ?? 'master', country: x.country ?? '', locationIds: new Set(x.locationIds) }))} data-testid={`edit-${kind}-${x.name}`}>{t('edit')}</Button>
                    {confirming === x.id ? (
                      <>
                        <Button size="sm" variant="danger" loading={del.pending} onClick={async () => { if (await del.run(kind, x.id)) { setConfirming(null); setDraft(null); setNotice(t('deleted', { name: x.name })); res.reload(); } }} data-testid={`confirm-delete-${x.name}`}>{t('confirmDelete')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => (setConfirming(null), del.clearError())}>{t('cancel')}</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" icon="x" onClick={() => (setConfirming(x.id), del.clearError())} data-testid={`delete-${kind}-${x.name}`}>{t('delete')}</Button>
                    )}
                  </span>
                )}
              </div>
              <p className="text-xs text-graphite">{x.locationIds.map(locName).join(', ') || t('noLocations')}</p>
              <p className="text-xs text-stone">{who.length ? t('assigned', { people: who.map((a) => `${a.user.name} (${a.roleName})`).join(', ') }) : t('noMembers')}</p>
              {confirming === x.id && del.error && <Banner tone="danger" live="assertive">{del.error.message}</Banner>}
            </li>
          );
        };
        return (
          <section className="flex flex-col gap-4 rounded-xl bg-surface p-5" aria-labelledby="scopes-title" data-testid="scopes">
            <div>
              <h2 id="scopes-title" className="text-lg font-bold">{t('title')}</h2>
              <p className="text-sm text-stone">{t('intro')}</p>
            </div>
            {notice && <Banner tone="success" live="polite">{notice}</Banner>}
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="flex-1 text-sm font-bold">{t('portfolios')}</h3>
                  <Button size="sm" variant="secondary" icon="plus" onClick={() => (setNotice(''), setDraft(fresh('portfolio')))} data-testid="new-portfolio">{t('newPortfolio')}</Button>
                </div>
                {scopes.portfolios.length === 0 ? <p className="text-xs text-stone">{t('noPortfolios')}</p> : <ul className="flex flex-col gap-2">{scopes.portfolios.map((x) => card('portfolio', x))}</ul>}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="flex-1 text-sm font-bold">{t('territories')}</h3>
                  {canTerritory && <Button size="sm" variant="secondary" icon="plus" onClick={() => (setNotice(''), setDraft(fresh('territory')))} data-testid="new-territory">{t('newTerritory')}</Button>}
                </div>
                {scopes.territories.length === 0 ? <p className="text-xs text-stone">{t('noTerritories')}</p> : <ul className="flex flex-col gap-2">{scopes.territories.map((x) => card('territory', x))}</ul>}
              </div>
            </div>
            {draft && (
              <ScopeEditor
                key={`${draft.kind}:${draft.id ?? 'new'}`}
                draft={draft}
                scopes={scopes}
                roles={roles}
                assigned={draft.id ? people(draft.kind, draft.id) : []}
                onClose={() => setDraft(null)}
                onSaved={(msg, next) => { setNotice(msg); setDraft(next); res.reload(); }}
              />
            )}
          </section>
        );
      }}
    </Async>
  );
}

function ScopeEditor({ draft, scopes, roles, assigned, onClose, onSaved }: { draft: Draft; scopes: ScopesVM; roles: RolesVM; assigned: AssignmentListItemVM[]; onClose: () => void; onSaved: (msg: string, next: Draft | null) => void }) {
  const t = useTranslations('access.scopes');
  const app = useApp();
  const [name, setName] = useState(draft.name);
  const [territoryKind, setTerritoryKind] = useState(draft.territoryKind);
  const [country, setCountry] = useState(draft.country);
  const [picked, setPicked] = useState<Set<string>>(draft.locationIds);
  const [query, setQuery] = useState('');
  const members = useApi((api) => api.team.members(app.ctx), [app.org.id], !!draft.id);
  const [person, setPerson] = useState('');
  const [role, setRole] = useState(draft.kind === 'portfolio' ? 'field_consultant' : 'master_franchisee');
  const save = useAccessAction(async () => {
    const body = { name: name.trim(), locationIds: [...picked] };
    if (draft.kind === 'portfolio') return draft.id ? accessApi.updatePortfolio(draft.id, body) : accessApi.createPortfolio(body);
    const tb = { ...body, kind: territoryKind, country: country.trim() ? country.trim().toUpperCase() : null };
    return draft.id ? accessApi.updateTerritory(draft.id, tb) : accessApi.createTerritory(tb);
  });
  const assign = useAccessAction(() => {
    const custom = role.startsWith('custom:') ? role.slice(7) : undefined;
    return accessApi.addAssignment({ userId: person, role: custom ? 'custom' : role, ...(custom ? { customRoleId: custom } : {}), scope: { kind: draft.kind, id: draft.id! }, grants: [], revokes: [] });
  });
  const unassign = useAccessAction((id: string) => accessApi.removeAssignment(id));
  const visible = useMemo(() => scopes.locations.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase())), [scopes.locations, query]);
  const otherTerritory = (l: ScopesVM['locations'][number]) => draft.kind === 'territory' && l.territoryId && l.territoryId !== draft.id ? scopes.territories.find((x) => x.id === l.territoryId)?.name ?? null : null;
  const setAll = (on: boolean) => { const n = new Set(picked); for (const l of visible) { if (on) n.add(l.id); else n.delete(l.id); } setPicked(n); };
  const current = { ...draft, name: name.trim(), territoryKind, country, locationIds: picked };
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-soft p-4" data-testid="scope-editor">
      <h3 className="text-sm font-bold">{draft.id ? t('editTitle', { name: draft.name }) : draft.kind === 'portfolio' ? t('newPortfolio') : t('newTerritory')}</h3>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={draft.kind === 'portfolio' ? t('portfolioName') : t('territoryName')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} data-testid="scope-name" />}</Field>
        {draft.kind === 'territory' && (
          <>
            <Field label={t('kind')}>{(p) => <Select id={p.id} value={territoryKind} onChange={(e) => setTerritoryKind(e.target.value)}>{TERRITORY_KINDS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}</Select>}</Field>
            <Field label={t('country')} hint={t('countryHint')}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />}</Field>
          </>
        )}
      </div>
      <fieldset className="flex flex-col gap-2" data-testid="location-picker">
        <legend className="mb-1 text-xs font-bold">{t('locationsPicked', { count: picked.size, total: scopes.locations.length })}</legend>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1"><Field label={t('searchLocations')}>{(p) => <Input id={p.id} type="search" value={query} onChange={(e) => setQuery(e.target.value)} />}</Field></div>
          <Button size="sm" variant="secondary" onClick={() => setAll(true)}>{t('selectAll')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setAll(false)}>{t('clear')}</Button>
        </div>
        <div className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
          {visible.map((l) => {
            const other = otherTerritory(l);
            return (
              <label key={l.id} className={cx('flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold', picked.has(l.id) ? 'border-ink bg-lime/30' : 'border-line-soft')}>
                <input type="checkbox" className="h-4 w-4 accent-ink" checked={picked.has(l.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(l.id); else n.delete(l.id); setPicked(n); }} />
                {l.name}
                {other && <span className="font-normal text-stone">({t('movesFrom', { territory: other })})</span>}
              </label>
            );
          })}
        </div>
      </fieldset>
      {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!name.trim()} loading={save.pending} data-testid="scope-save" onClick={async () => {
          const r = await save.run();
          if (r) onSaved(t('saved', { name: name.trim() }), draft.id ? null : { ...current, id: r.id });
        }}>{draft.id ? t('save') : t('create')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      </div>

      {draft.id && (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3" data-testid="scope-members">
          <h4 className="text-sm font-bold">{t('members')}</h4>
          {assigned.length === 0 ? <p className="text-xs text-stone">{t('noMembers')}</p> : (
            <ul className="flex flex-col gap-1">
              {assigned.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2 text-sm">
                  <strong>{a.user.name}</strong>
                  <Badge tone="neutral" icon={null}>{a.roleName}</Badge>
                  <span className="text-xs text-stone">{a.user.email}</span>
                  {a.editable && <Button size="sm" variant="ghost" icon="x" className="ml-auto" loading={unassign.pending} onClick={async () => { if (await unassign.run(a.id)) onSaved(t('unassigned', { name: a.user.name }), current); }}>{t('remove')}</Button>}
                </li>
              ))}
            </ul>
          )}
          {unassign.error && <Banner tone="danger" live="assertive">{unassign.error.message}</Banner>}
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
            <Field label={t('person')}>
              {(p) => (
                <Select id={p.id} value={person} onChange={(e) => setPerson(e.target.value)} data-testid="scope-person">
                  <option value="">{t('choosePerson')}</option>
                  {(members.data ?? []).filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('role')}>{(p) => <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value)} data-testid="scope-role"><RoleOptions roles={roles} /></Select>}</Field>
            <Button disabled={!person} loading={assign.pending} data-testid="scope-assign" onClick={async () => {
              const who = members.data?.find((m) => m.id === person)?.name ?? '';
              if (await assign.run()) { setPerson(''); onSaved(t('assignedOne', { name: who }), current); }
            }}>{t('assign')}</Button>
          </div>
          {assign.error && <Banner tone="danger" live="assertive">{assign.error.message}</Banner>}
          <p className="text-xs text-stone">{t('membersHint')}</p>
        </div>
      )}
    </div>
  );
}
