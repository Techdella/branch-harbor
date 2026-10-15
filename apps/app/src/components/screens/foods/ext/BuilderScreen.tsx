'use client';

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tabs, cx } from '@bh/ui';
import type { Builder, BuilderItem, BuilderMenu, DayPart, PublishPreview, PublishResult } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtDateTime } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, Labeled, Section, StatusBadge, inputCls, toMajor, toMinor, useFx } from './common';

type Tab = 'items' | 'dayparts' | 'publish';
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const LANGS = ['fr', 'es', 'de', 'pt'];

/**
 * HQ menu builder: categories, items, required/optional modifier groups with min/max, business-supplied
 * allergens (jurisdiction conventions) and dietary labels, per-locale names, day-parts, and publish with a
 * per-location preview and results (retry failures).
 */
export function BuilderScreen() {
  const t = useFx();
  const app = useApp();
  const [tab, setTab] = useState<Tab>('items');
  const [menuId, setMenuId] = useState<string | null>(null);
  const res = useFoods((api) => api.builder(), [app.org.id]);
  const vocab = useFoods((api) => api.vocabulary(), [app.org.id]);
  const canEdit = app.can('templates.write');

  return (
    <>
      <PageHeader icon="layers" title={t('builder.title')} description={t('builder.description')} />
      {!canEdit && <Banner tone="neutral" icon="lock" title={t('builder.readOnly')}>{t('builder.readOnlyBody')}</Banner>}
      <Tabs<Tab> items={[{ key: 'items', label: t('builder.tabItems') }, { key: 'dayparts', label: t('builder.tabDayParts') }, { key: 'publish', label: t('builder.tabPublish') }]} value={tab} onChange={setTab} />
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(b) => {
          const menu = b.menus.find((m) => m.id === menuId) ?? b.menus[0];
          return (
            <>
              <div role="group" aria-label={t('builder.menus')} className="flex flex-wrap items-center gap-1.5">
                {b.menus.map((m) => (
                  <button key={m.id} type="button" aria-pressed={menu?.id === m.id} onClick={() => setMenuId(m.id)} className={cx('flex h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold', menu?.id === m.id ? 'bg-ink text-white' : 'bg-surface')}>
                    <Icon name={m.kind === 'preorder' ? 'calendar' : 'list'} size={14} />{m.name}
                  </button>
                ))}
                {canEdit && <NewMenu onDone={res.reload} />}
              </div>
              {tab === 'items' && menu && <ItemsTab b={b} menu={menu} vocab={vocab.data} canEdit={canEdit} reload={res.reload} />}
              {tab === 'dayparts' && <DayPartsTab parts={b.dayParts} canEdit={canEdit} reload={res.reload} />}
              {tab === 'publish' && menu && <PublishTab menu={menu} b={b} canEdit={canEdit} reload={res.reload} />}
            </>
          );
        }}
      </Async>
    </>
  );
}

function NewMenu({ onDone }: { onDone: () => void }) {
  const t = useFx();
  const [name, setName] = useState('');
  const m = useFoodsMutation((api, n: string, kind: 'standard' | 'preorder') => api.createMenu(n, kind));
  const [kind, setKind] = useState<'standard' | 'preorder'>('standard');
  return (
    <form className="flex flex-wrap items-center gap-1.5" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await m.run(name.trim(), kind))) { setName(''); onDone(); } }}>
      <input aria-label={t('builder.newMenu')} placeholder={t('builder.newMenu')} value={name} onChange={(e) => setName(e.target.value)} className={cx(inputCls, 'w-44')} />
      <select aria-label={t('builder.menuKind')} value={kind} onChange={(e) => setKind(e.target.value as 'standard')} className={cx(inputCls, 'w-36')}>
        <option value="standard">{t('builder.kind.standard')}</option>
        <option value="preorder">{t('builder.kind.preorder')}</option>
      </select>
      <Button size="sm" variant="secondary" icon="plus" type="submit" loading={m.pending}>{t('common.add')}</Button>
    </form>
  );
}

function ItemsTab({ b, menu, vocab, canEdit, reload }: { b: Builder; menu: BuilderMenu; vocab?: { allergens: Array<{ key: string; label: string }>; dietary: string[] }; canEdit: boolean; reload: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const [open, setOpen] = useState<BuilderItem | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const cats = [...menu.categories].sort((a, c) => a.sortOrder - c.sortOrder);
  const uncategorised = menu.items.filter((i) => !i.categoryId || !cats.some((c) => c.id === i.categoryId));
  const currencies = [...new Set(b.locations.map((l) => l.currency))];
  const newCat = useFoodsMutation((api, name: string) => api.createCategory(menu.id, { name }));
  const [catName, setCatName] = useState('');
  const partName = (id: string) => b.dayParts.find((d) => d.id === id)?.name ?? '';
  const groups = [...cats.map((c) => ({ id: c.id, name: c.name, parts: c.dayPartIds, items: menu.items.filter((i) => i.categoryId === c.id) })), ...(uncategorised.length ? [{ id: '', name: t('builder.uncategorised'), parts: [] as string[], items: uncategorised }] : [])];

  return (
    <>
      {groups.map((g) => (
        <Section key={g.id || 'none'} title={g.name} aside={
          <div className="flex flex-wrap items-center gap-2">
            {g.parts.map((p) => <Badge key={p} tone="info" icon="clock">{partName(p)}</Badge>)}
            {canEdit && g.id && <Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(g.id)}>{t('builder.addItem')}</Button>}
          </div>
        }>
          <ul className="divide-y divide-line-soft">
            {g.items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-bold">
                    {it.name}
                    {!it.active && <StatusBadge status="closed" label={t('builder.archived')} />}
                    {it.dayPartIds.map((p) => <Badge key={p} tone="info" icon="clock">{partName(p)}</Badge>)}
                    {it.stationKey && <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold">{t('builder.station')}: {it.stationKey}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-stone">
                    <span>{currencies.map((c) => (it.prices[c] === undefined ? `${c} —` : `${c} ${(it.prices[c]! / 100).toLocaleString(locale, { minimumFractionDigits: 2 })}`)).join(' · ')}</span>
                    <span>{it.allergensDeclared || it.allergens.length ? t('builder.allergensDeclared', { n: it.allergens.length }) : t('builder.allergensNotProvided')}</span>
                    {it.dietary.length > 0 && <span>{it.dietary.join(', ')}</span>}
                    {it.modifierGroups.length > 0 && <span>{t('builder.groups', { n: it.modifierGroups.length })}</span>}
                    {Object.keys(it.translations).length > 0 && <span>{t('builder.languages', { list: Object.keys(it.translations).join(', ') })}</span>}
                  </div>
                </div>
                <Button size="sm" variant="secondary" icon={canEdit ? 'edit' : 'eye'} onClick={() => setOpen(it)}>{canEdit ? t('common.edit') : t('common.view')}</Button>
              </li>
            ))}
            {g.items.length === 0 && <li className="py-3 text-sm text-stone">{t('builder.emptyCategory')}</li>}
          </ul>
        </Section>
      ))}
      {canEdit && (
        <form className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-4" onSubmit={async (e) => { e.preventDefault(); if (catName.trim() && (await newCat.run(catName.trim()))) { setCatName(''); reload(); } }}>
          <Labeled label={t('builder.newCategory')}><input value={catName} onChange={(e) => setCatName(e.target.value)} className={inputCls} /></Labeled>
          <Button type="submit" size="sm" icon="plus" loading={newCat.pending}>{t('common.add')}</Button>
          <ErrorLine error={newCat.error} />
        </form>
      )}
      {open && <ItemDrawer item={open} b={b} vocab={vocab} canEdit={canEdit} currencies={currencies} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
      {adding && <NewItemDrawer menu={menu} categoryId={adding} currencies={currencies} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); reload(); }} />}
    </>
  );
}

function PriceInputs({ currencies, value, onChange }: { currencies: string[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const t = useFx();
  return (
    <fieldset className="grid grid-cols-2 gap-2">
      <legend className="mb-1 text-[13px] font-bold">{t('builder.prices')}</legend>
      {currencies.map((c) => (
        <Labeled key={c} label={c}><input inputMode="decimal" value={value[c] ?? ''} onChange={(e) => onChange({ ...value, [c]: e.target.value })} className={inputCls} placeholder="—" /></Labeled>
      ))}
    </fieldset>
  );
}
const pricesOut = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim() !== '').map(([k, x]) => [k, toMinor(x)]));

function NewItemDrawer({ menu, categoryId, currencies, onClose, onSaved }: { menu: BuilderMenu; categoryId: string; currencies: string[]; onClose: () => void; onSaved: () => void }) {
  const t = useFx();
  const [name, setName] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const m = useFoodsMutation((api, body: Record<string, unknown>) => api.createItem(menu.id, body));
  const cat = menu.categories.find((c) => c.id === categoryId);
  return (
    <Drawer open onClose={onClose} title={t('builder.addItem')} kicker={cat?.name} footer={
      <Button loading={m.pending} disabled={!name.trim()} onClick={async () => { if (await m.run({ name: name.trim(), category: cat?.name ?? 'Other', categoryId, prices: pricesOut(prices) })) onSaved(); }}>{t('common.save')}</Button>
    }>
      <div className="flex flex-col gap-3">
        <Labeled label={t('builder.name')}><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
        <PriceInputs currencies={currencies} value={prices} onChange={setPrices} />
        <p className="text-xs text-stone">{t('builder.newItemHint')}</p>
        <ErrorLine error={m.error} />
      </div>
    </Drawer>
  );
}

function ItemDrawer({ item, b, vocab, canEdit, currencies, onClose, onSaved }: { item: BuilderItem; b: Builder; vocab?: { allergens: Array<{ key: string; label: string }>; dietary: string[] }; canEdit: boolean; currencies: string[]; onClose: () => void; onSaved: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? '');
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(Object.entries(item.prices).map(([k, v]) => [k, toMajor(v)])));
  const [allergens, setAllergens] = useState<string[]>(item.allergens);
  const [declared, setDeclared] = useState(item.allergensDeclared || item.allergens.length > 0);
  const [dietary, setDietary] = useState<string[]>(item.dietary);
  const [parts, setParts] = useState<string[]>(item.dayPartIds);
  const [station, setStation] = useState(item.stationKey ?? '');
  const [prep, setPrep] = useState(item.prepMinutes?.toString() ?? '');
  const [tr, setTr] = useState(item.translations);
  const save = useFoodsMutation((api, patch: Record<string, unknown>) => api.updateItem(item.id, patch));
  const archive = useFoodsMutation((api) => api.archiveItem(item.id));
  const ai = useFoodsMutation((api) => api.aiMenuCopy(item.id, locale));
  const [draft, setDraft] = useState<{ draft: string; warnings: string[]; note: string } | null>(null);
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const regimes = [...new Set(b.locations.map((l) => l.defaultAllergenRegime))];

  const submit = async () => {
    const patch: Record<string, unknown> = {
      name, description: description || null, prices: pricesOut(prices), dietary, dayPartIds: parts, stationKey: station || null, prepMinutes: prep ? Number(prep) : null, translations: tr,
      ...(declared ? { allergens, allergensDeclared: true } : {}),
    };
    if (await save.run(patch)) onSaved();
  };
  return (
    <Drawer open onClose={onClose} title={item.name} kicker={item.category} footer={canEdit ? (
      <div className="flex flex-wrap gap-2">
        <Button loading={save.pending} onClick={submit}>{t('common.save')}</Button>
        {item.active && <Button variant="ghost" icon="box" loading={archive.pending} onClick={async () => { await archive.run(); onSaved(); }}>{t('builder.archive')}</Button>}
      </div>
    ) : undefined}>
      <fieldset disabled={!canEdit} className="flex flex-col gap-4">
        <Labeled label={t('builder.name')}><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
        <Labeled label={t('builder.descriptionField')}><textarea value={description} onChange={(e) => setDescription(e.target.value)} className={cx(inputCls, 'h-20 py-2')} /></Labeled>
        {canEdit && (
          <div className="rounded-lg bg-canvas p-3">
            <Button size="sm" variant="secondary" icon="sparkles" loading={ai.pending} onClick={async () => setDraft((await ai.run()) ?? null)}>{t('builder.aiDraft')}</Button>
            {ai.error && <p className="mt-2 text-xs font-bold text-danger">{ai.error.message}</p>}
            {draft && (
              <div className="mt-2 flex flex-col gap-2 text-sm">
                <p className="rounded-md bg-surface p-2">{draft.draft}</p>
                {draft.warnings.map((w) => <p key={w} className="flex items-center gap-1 text-xs font-bold text-warning"><Icon name="alert" size={12} />{w}</p>)}
                <p className="text-xs text-stone">{draft.note}</p>
                <Button size="sm" variant="ghost" icon="check" onClick={() => setDescription(draft.draft)}>{t('builder.useDraft')}</Button>
              </div>
            )}
          </div>
        )}
        <PriceInputs currencies={currencies} value={prices} onChange={setPrices} />
        <fieldset>
          <legend className="text-[13px] font-bold">{t('builder.allergens')}</legend>
          <p className="mb-2 text-xs text-stone">{t('builder.allergensHint', { regimes: regimes.join(', ') })}</p>
          <label className="mb-2 flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />{t('builder.declare')}</label>
          {declared && (
            <div className="grid grid-cols-2 gap-1.5">
              {(vocab?.allergens ?? []).map((a) => (
                <label key={a.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allergens.includes(a.key)} onChange={() => setAllergens(toggle(allergens, a.key))} />{a.label}</label>
              ))}
            </div>
          )}
          {!declared && <p className="text-sm text-stone">{t('builder.allergensNotProvidedLong')}</p>}
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-[13px] font-bold">{t('builder.dietary')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {(vocab?.dietary ?? []).map((d) => (
              <button key={d} type="button" aria-pressed={dietary.includes(d)} onClick={() => setDietary(toggle(dietary, d))} className={cx('h-8 rounded-full px-3 text-xs font-bold', dietary.includes(d) ? 'bg-ink text-white' : 'bg-canvas')}>{d}</button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-[13px] font-bold">{t('builder.dayParts')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {b.dayParts.map((d) => (
              <button key={d.id} type="button" aria-pressed={parts.includes(d.id)} onClick={() => setParts(toggle(parts, d.id))} className={cx('h-8 rounded-full px-3 text-xs font-bold', parts.includes(d.id) ? 'bg-ink text-white' : 'bg-canvas')}>{d.name}</button>
            ))}
          </div>
          <p className="mt-1 text-xs text-stone">{t('builder.dayPartsHint')}</p>
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <Labeled label={t('builder.station')}><input value={station} onChange={(e) => setStation(e.target.value)} placeholder="grill" className={inputCls} /></Labeled>
          <Labeled label={t('builder.prepMinutes')}><input inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value)} className={inputCls} /></Labeled>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-bold">{t('builder.translations')}</legend>
          {LANGS.map((lng) => (
            <div key={lng} className="grid grid-cols-[44px_1fr] items-center gap-2">
              <span className="text-xs font-bold uppercase">{lng}</span>
              <input aria-label={t('builder.nameIn', { lang: lng })} value={tr[lng]?.name ?? ''} onChange={(e) => setTr({ ...tr, [lng]: { ...tr[lng], name: e.target.value } })} className={inputCls} placeholder={t('builder.fallsBack')} />
            </div>
          ))}
        </fieldset>
        <ModifierGroups item={item} currencies={currencies} canEdit={canEdit} onChanged={onSaved} />
        <ErrorLine error={save.error ?? archive.error} />
      </fieldset>
    </Drawer>
  );
}

function ModifierGroups({ item, currencies, canEdit, onChanged }: { item: BuilderItem; currencies: string[]; canEdit: boolean; onChanged: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [min, setMin] = useState('0');
  const [max, setMax] = useState('1');
  const [opts, setOpts] = useState('');
  const add = useFoodsMutation((api, body: Parameters<typeof api.addModifierGroup>[1]) => api.addModifierGroup(item.id, body));
  const del = useFoodsMutation((api, id: string) => api.deleteModifierGroup(id));
  return (
    <fieldset>
      <legend className="mb-1 text-[13px] font-bold">{t('builder.modifierGroups')}</legend>
      <ul className="flex flex-col gap-2">
        {item.modifierGroups.map((g) => (
          <li key={g.id} className="rounded-lg bg-canvas p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <strong>{g.name}</strong>
              <span className="flex items-center gap-2">
                <Badge tone={g.minSelect > 0 ? 'warning' : 'neutral'} icon={g.minSelect > 0 ? 'alert' : null}>{g.minSelect > 0 ? t('builder.required', { min: g.minSelect, max: g.maxSelect }) : t('builder.optional', { max: g.maxSelect })}</Badge>
                {canEdit && <button type="button" aria-label={t('builder.removeGroup', { name: g.name })} onClick={async () => { await del.run(g.id); onChanged(); }} className="rounded-full p-1 hover:bg-surface"><Icon name="x" size={14} /></button>}
              </span>
            </div>
            <p className="mt-1 text-xs text-stone">{g.modifiers.map((m) => `${m.name}${Object.values(m.prices).some((p) => p > 0) ? ` (+${currencies.map((c) => (m.prices[c] !== undefined ? new Intl.NumberFormat(locale, { style: 'currency', currency: c }).format(m.prices[c]! / 100) : null)).filter(Boolean).join(' / ')})` : ''}`).join(' · ')}</p>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-line-soft p-3">
          <Labeled label={t('builder.groupName')}><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
          <div className="grid grid-cols-2 gap-2">
            <Labeled label={t('builder.min')}><input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} className={inputCls} /></Labeled>
            <Labeled label={t('builder.max')}><input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} className={inputCls} /></Labeled>
          </div>
          <div className="col-span-2"><Labeled label={t('builder.options')} hint={t('builder.optionsHint')}><input value={opts} onChange={(e) => setOpts(e.target.value)} className={inputCls} /></Labeled></div>
          <div className="col-span-2">
            <Button size="sm" variant="secondary" icon="plus" loading={add.pending} disabled={!name.trim() || !opts.trim()} onClick={async () => {
              const modifiers = opts.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [n, p] = s.split('+').map((x) => x.trim()); return { name: n!, prices: Object.fromEntries(currencies.map((c) => [c, p ? toMinor(p) : 0])) }; });
              if (await add.run({ name: name.trim(), minSelect: Number(min) || 0, maxSelect: Math.max(1, Number(max) || 1), modifiers })) { setName(''); setOpts(''); onChanged(); }
            }}>{t('builder.addGroup')}</Button>
          </div>
          <div className="col-span-2"><ErrorLine error={add.error ?? del.error} /></div>
        </div>
      )}
    </fieldset>
  );
}

function DayPartsTab({ parts, canEdit, reload }: { parts: DayPart[]; canEdit: boolean; reload: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [start, setStart] = useState('07:00');
  const [end, setEnd] = useState('11:00');
  const [days, setDays] = useState<number[]>(WEEKDAYS);
  const create = useFoodsMutation((api, body: Parameters<typeof api.createDayPart>[0]) => api.createDayPart(body));
  const remove = useFoodsMutation((api, id: string) => api.deleteDayPart(id));
  const dayName = (d: number) => new Date(Date.UTC(2026, 0, 4 + d)).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
  return (
    <Section title={t('builder.tabDayParts')}>
      <p className="mb-3 text-sm text-stone">{t('builder.dayPartsBody')}</p>
      <ul className="divide-y divide-line-soft">
        {parts.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div>
              <strong>{p.name}</strong>
              <p className="text-xs text-stone">{[...new Set(p.windows.map((w) => `${w.start}–${w.end}`))].join(', ')} · {p.windows.length === 7 ? t('builder.everyDay') : p.windows.map((w) => dayName(w.weekday)).join(', ')}</p>
            </div>
            {canEdit && <Button size="sm" variant="ghost" icon="x" onClick={async () => { await remove.run(p.id); reload(); }}>{t('common.remove')}</Button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await create.run({ name, windows: days.map((weekday) => ({ weekday, start, end })), sortOrder: parts.length + 1 })) { setName(''); reload(); } }}>
          <Labeled label={t('builder.name')}><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} required /></Labeled>
          <Labeled label={t('builder.from')}><input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></Labeled>
          <Labeled label={t('builder.to')}><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} /></Labeled>
          <fieldset className="flex flex-wrap gap-1">
            <legend className="sr-only">{t('builder.days')}</legend>
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])} className={cx('h-10 rounded-full px-3 text-xs font-bold', days.includes(d) ? 'bg-ink text-white' : 'bg-canvas')}>{dayName(d)}</button>
            ))}
          </fieldset>
          <Button type="submit" icon="plus" loading={create.pending} disabled={!days.length}>{t('common.add')}</Button>
        </form>
      )}
      <ErrorLine error={create.error ?? remove.error} />
    </Section>
  );
}

function PublishTab({ menu, b, canEdit, reload }: { menu: BuilderMenu; b: Builder; canEdit: boolean; reload: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const preview = useFoods((api) => api.publishPreview(menu.id), [menu.id, menu.publications.length]);
  const pub = useFoodsMutation((api, ids?: string[]) => api.publish(menu.id, ids));
  const retry = useFoodsMutation((api) => api.retryPublish(menu.id));
  const [result, setResult] = useState<PublishResult | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const failed = menu.publications.filter((p) => p.status === 'failed').length;
  const tz = useMemo(() => Object.fromEntries(b.locations.map((l) => [l.id, l.timeZone])), [b.locations]);
  return (
    <>
      <Section title={t('builder.previewTitle', { menu: menu.name })} aside={canEdit && (
        <div className="flex flex-wrap gap-2">
          {failed > 0 && <Button size="sm" variant="secondary" icon="refresh" loading={retry.pending} onClick={async () => { const r = await retry.run(); if (r) { setResult(r); reload(); } }}>{t('builder.retryFailed', { n: failed })}</Button>}
          <Button size="sm" icon="send" loading={pub.pending} onClick={async () => { const r = await pub.run(selected ?? undefined); if (r) { setResult(r); reload(); } }}>{selected ? t('builder.publishSelected', { n: selected.length }) : t('builder.publishAll')}</Button>
        </div>
      )}>
        <p className="mb-3 text-sm text-stone">{t('builder.previewBody')}</p>
        <Async res={preview} loading={<LoadingBlock variant="table" rows={3} />}>
          {(p: PublishPreview) => (
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="text-left text-xs uppercase text-stone"><th className="p-2">{canEdit ? t('builder.include') : ''}</th><th className="p-2">{t('common.location')}</th><th className="p-2">{t('builder.wouldBe')}</th><th className="p-2">{t('builder.sellable')}</th><th className="p-2">{t('builder.notSellable')}</th><th className="p-2">{t('builder.lastPublish')}</th></tr></thead>
                <tbody>
                  {p.locations.map((l) => (
                    <tr key={l.locationId} className="border-t border-line-soft align-top">
                      <td className="p-2">{canEdit && <input type="checkbox" aria-label={t('builder.includeLoc', { name: l.name })} checked={selected ? selected.includes(l.locationId) : true} onChange={(e) => { const cur = selected ?? p.locations.map((x) => x.locationId); setSelected(e.target.checked ? [...cur, l.locationId] : cur.filter((x) => x !== l.locationId)); }} />}</td>
                      <td className="p-2 font-bold">{l.name} <span className="font-normal text-stone">· {l.currency}</span></td>
                      <td className="p-2"><StatusBadge status={l.wouldBe} /></td>
                      <td className="p-2 tabular">{l.sellable}</td>
                      <td className="p-2 text-xs">{l.reason ?? (l.unavailable.length ? l.unavailable.map((u) => `${u.name}: ${u.reason}`).join('; ') : '—')}</td>
                      <td className="p-2 text-xs">{l.lastPublish ? <span className="flex flex-col gap-1"><StatusBadge status={l.lastPublish.status} />{fmtDateTime(l.lastPublish.at, tz[l.locationId] ?? 'UTC', locale)}</span> : t('builder.never')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
        <ErrorLine error={pub.error ?? retry.error} />
      </Section>
      {result && (
        <Banner tone={result.summary.failed ? 'warning' : 'success'} live="polite" title={t('builder.publishedTitle')}>
          {t('builder.publishedBody', { ok: result.summary.succeeded, partial: result.summary.partial, failed: result.summary.failed, skipped: result.summary.skipped })}
          <ul className="mt-1 list-disc pl-5">{result.locations.filter((l) => l.status !== 'succeeded').map((l) => <li key={l.locationId}>{l.name}: {t(`status.${l.status}`)}{l.reason ? ` — ${l.reason}` : ''}</li>)}</ul>
        </Banner>
      )}
    </>
  );
}
