'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, Toggle, type Tone } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { usePartners, usePartnersMutation, type PartnerCatalogEntry, type PartnerConnection, type PartnerField, type PartnerLocation, type PartnerStatus, type PartnerTestResult, type Settings } from '@/lib/partners';
import { useApp } from '../shell/AppContext';
import { Banner, LoadingBlock } from '../ui/States';

type NoteTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Record<PartnerStatus, Tone> = { not_configured: 'neutral', disabled: 'neutral', sandbox: 'warning', awaiting_portal: 'info', live: 'success', error: 'danger' };

/**
 * The partner catalogue, status reasons and test results come from the API in English; they're phrased here from
 * `partners.*` by field key, provider and reason code, falling back to the API text for anything not in the catalogue.
 */
function usePartnerText() {
  const t = useTranslations('partners');
  const has = (k: string) => t.has(k as never);
  const tx = (k: string, fallback: string, v?: Record<string, string | number>) => (has(k) ? t(k as never, v as never) : fallback);
  const field = (f: Pick<PartnerField, 'key' | 'label'>) => tx(`fields.${f.key}`, f.label);
  const help = (f: PartnerField) => (f.help ? tx(`fieldHelp.${f.key}`, f.help) : undefined);
  const option = (o: string) => tx(`options.${o}`, o);
  const requirements = (e: PartnerCatalogEntry) => tx(`requirements.${e.provider}`, e.approvals);
  const fieldList = (e: PartnerCatalogEntry, keys: string[] | undefined) => (keys ?? []).map((k) => field(e.fields.find((f) => f.key === k) ?? { key: k, label: k })).join(', ');
  const reason = (e: PartnerCatalogEntry, c: PartnerConnection) => (c.statusReasonCode ? tx(`reason.${c.statusReasonCode}`, c.statusReason, { list: fieldList(e, c.missingKeys) }) : c.statusReason);
  const testResult = (e: PartnerCatalogEntry, r: PartnerTestResult) => {
    if (!r.code) return r.message;
    const p = r.params ?? {};
    return tx(`testResult.${r.code}`, r.message, { provider: String(p.provider ?? e.name), list: fieldList(e, p.missingKeys as string[] | undefined), included: Number(p.included ?? 0), excluded: Number(p.excluded ?? 0) });
  };
  const lastResult = (r: NonNullable<PartnerConnection['lastResult']>) => `${tx(`action.${r.action}`, r.action)} · ${tx(`resultStatus.${r.status}`, r.status)}`;
  return { field, help, option, requirements, reason, testResult, lastResult };
}

/**
 * Partner integrations per location/office: credentials (masked, write-only), connection test, last result,
 * enable/disable and sandbox ↔ live. Sandbox is always labelled; "Live" only appears after a passing test.
 */
export function PartnerIntegrationsPanel({ industry }: { industry: 'foods' | 'realty' }) {
  const t = useTranslations('partners');
  const pt = usePartnerText();
  const locale = useLocale();
  const app = useApp();
  const res = usePartners((a) => a.overview(industry), [industry]);
  const [editing, setEditing] = useState<{ entry: PartnerCatalogEntry; loc: PartnerLocation; conn: PartnerConnection | null } | null>(null);
  const [note, setNote] = useState<{ tone: NoteTone; text: string } | null>(null);
  const act = usePartnersMutation(async (a, kind: 'test' | 'enable' | 'disable' | 'live' | 'sandbox' | 'rotate' | 'menu' | 'busyOn' | 'busyOff', c: PartnerConnection) => {
    switch (kind) {
      case 'test': {
        const r = await a.test(c.id);
        const entry = res.data?.catalog.find((e) => e.provider === c.provider);
        return { tone: (r.result.ok ? 'success' : r.result.sandbox ? 'warning' : 'danger') as NoteTone, text: t('tested', { name: c.name, message: entry ? pt.testResult(entry, r.result) : r.result.message }) };
      }
      case 'enable': case 'disable': await a.update(c.id, { enabled: kind === 'enable' }); return null;
      case 'live': case 'sandbox': await a.update(c.id, { mode: kind }); return null;
      case 'rotate': await a.rotateFeed(c.id); return null;
      case 'menu': { const r = await a.menuPush(c.locationId); return { tone: (r.status === 'error' ? 'danger' : r.status === 'ok' ? 'success' : 'warning') as NoteTone, text: `${t('menuPushed', { message: r.status === 'sandbox' ? t('menuSandbox') : r.message, products: r.products, soldOut: r.soldOut })}${r.unmappedAllergens.length ? ` ${t('unmappedAllergens', { list: [...new Set(r.unmappedAllergens.map((x) => x.allergen))].join(', ') })}` : ''}` }; }
      case 'busyOn': case 'busyOff': { const r = await a.busy(c.locationId, kind === 'busyOn', kind === 'busyOn' ? 30 : undefined); return { tone: (r.status === 'error' ? 'danger' : 'info') as NoteTone, text: r.status === 'sandbox' ? t(kind === 'busyOn' ? 'busySandboxOn' : 'busySandboxOff') : r.message }; }
    }
  });
  const run = async (kind: Parameters<typeof act.run>[0], c: PartnerConnection) => {
    setNote(null);
    const r = await act.run(kind, c);
    if (r) setNote(r);
    res.reload();
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="partners-title">
      <div>
        <h2 id="partners-title" className="text-lg font-extrabold">{t('title')}</h2>
        <p className="text-sm text-stone">{industry === 'foods' ? t('descriptionFoods') : t('descriptionRealty')}</p>
      </div>
      <Banner tone="info" icon="lock">{t('sandboxBanner')}</Banner>
      {note && <Banner tone={note.tone} live="polite">{note.text}</Banner>}
      {act.error && <Banner tone="danger" live="assertive">{act.error.message}</Banner>}
      {res.status === 'loading' && !res.data && <LoadingBlock variant="cards" rows={2} />}
      {res.status === 'error' && <Banner tone="danger">{res.error.message}</Banner>}
      {res.data && (
        <div className="flex flex-col gap-4">
          {res.data.locations.map((loc) => {
            const entries = res.data!.catalog.filter((e) => !e.countries || e.countries.includes(loc.country));
            if (!entries.length) return null;
            return (
              <div key={loc.id} className="rounded-xl bg-surface p-4">
                <h3 className="mb-2 text-sm font-bold">{loc.name} <span className="font-medium text-stone">· {loc.country} · {loc.currency}</span></h3>
                {!loc.canManage && <p className="mb-2 text-xs text-stone">{t('readOnly')}</p>}
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                  {entries.map((entry) => {
                    const c = res.data!.items.find((x) => x.provider === entry.provider && x.locationId === loc.id) ?? null;
                    const status: PartnerStatus = c?.status ?? 'not_configured';
                    return (
                      <article key={entry.provider} className="flex flex-col gap-2 rounded-lg border border-line-soft p-3 text-sm" data-testid={`partner-${entry.provider}-${loc.id}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="flex-1">{entry.name}</strong>
                          <Badge tone={TONE[status]} icon={status === 'live' ? 'check-circle' : status === 'sandbox' ? 'lock' : undefined}>{t(`status.${status}`)}</Badge>
                          {c?.mode === 'sandbox' && status !== 'sandbox' && status !== 'disabled' && <Badge tone="warning" icon="lock">{t('status.sandbox')}</Badge>}
                        </div>
                        <p className="text-xs text-stone">{c ? pt.reason(entry, c) : pt.requirements(entry)}</p>
                        {entry.provider === 'uber_direct' && !loc.uberDirectAvailable && <p className="text-xs text-warning">{t('uberUnavailable', { country: loc.country })}</p>}
                        {c && (
                          <>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                              {Object.entries(c.credentials).map(([k, v]) => (
                                <div key={k} className="contents"><dt className="text-stone">{pt.field(entry.fields.find((f) => f.key === k) ?? { key: k, label: k })}</dt><dd className="font-mono">{v.set ? v.masked : t('secretUnset')}</dd></div>
                              ))}
                              <dt className="text-stone">{t('lastResult')}</dt>
                              <dd>{c.lastResult ? `${pt.lastResult(c.lastResult)} · ${relativeTime(c.lastResult.at, locale)}${c.lastResult.message ? ` — ${c.lastResult.status === 'sandbox' && c.lastResult.action === 'test' && c.statusReasonCode === 'sample' ? t('testResult.sample') : c.lastResult.message}` : ''}` : t('never')}</dd>
                            </dl>
                            {c.busy?.paused && <Badge tone="warning" icon="clock">{t('busyState')}</Badge>}
                            {c.feedUrl && (
                              <div className="text-xs">
                                <div className="text-stone">{t('feedUrl')}</div>
                                <code className="block break-all rounded-sm bg-canvas px-2 py-1">{c.feedUrl}</code>
                                <div className="text-stone">{c.lastFetchedAt ? t('lastFetched', { when: relativeTime(c.lastFetchedAt, locale) }) : t('notFetched')}</div>
                              </div>
                            )}
                            {c.webhookUrl && (
                              <div className="text-xs"><div className="text-stone">{t('webhookUrl')}</div><code className="block break-all rounded-sm bg-canvas px-2 py-1">{c.webhookUrl}</code></div>
                            )}
                          </>
                        )}
                        {loc.canManage && (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant={c ? 'secondary' : 'primary'} icon="settings" onClick={() => setEditing({ entry, loc, conn: c })}>{c ? t('configure') : t('set_up')}</Button>
                            {c && <Button size="sm" variant="secondary" icon="refresh" loading={act.pending} onClick={() => run('test', c)}>{t('test')}</Button>}
                            {c && c.enabled && c.mode === 'sandbox' && c.state === 'connected' && !c.missing.length && <Button size="sm" icon="check" onClick={() => run('live', c)}>{t('goLive')}</Button>}
                            {c && c.mode === 'live' && <Button size="sm" variant="ghost" onClick={() => run('sandbox', c)}>{t('backToSandbox')}</Button>}
                            {c?.feedUrl && <Button size="sm" variant="ghost" onClick={() => run('rotate', c)}>{t('rotate')}</Button>}
                            {c && <Toggle checked={c.enabled} label={c.enabled ? t('disable') : t('enable')} onChange={(on) => run(on ? 'enable' : 'disable', c)} />}
                          </div>
                        )}
                        {c && entry.provider === 'deliverect' && c.enabled && app.can('operations.write') && (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="secondary" icon="send" loading={act.pending} onClick={() => run('menu', c)}>{t('menuPush')}</Button>
                            <Button size="sm" variant="ghost" icon="clock" onClick={() => run(c.busy?.paused ? 'busyOff' : 'busyOn', c)}>{c.busy?.paused ? t('busyOff') : t('busyOn')}</Button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editing && <ConfigureDrawer {...editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNote({ tone: 'success', text: t('saved') }); res.reload(); }} />}
    </section>
  );
}

function ConfigureDrawer({ entry, loc, conn, onClose, onSaved }: { entry: PartnerCatalogEntry; loc: PartnerLocation; conn: PartnerConnection | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('partners');
  const pt = usePartnerText();
  const [values, setValues] = useState<Settings>(() => Object.fromEntries(entry.fields.filter((f) => !f.secret).map((f) => [f.key, (conn?.config[f.key] as string | boolean | null | undefined) ?? (f.type === 'boolean' ? false : f.type === 'select' ? f.options![0]! : '')])));
  const save = usePartnersMutation(async (a) => {
    // Secrets are write-only: only fields the user typed are sent; empty means "keep".
    const settings = Object.fromEntries(Object.entries(values).filter(([k, v]) => !(entry.fields.find((f) => f.key === k)?.secret && (v === '' || v === undefined))));
    return conn ? a.update(conn.id, { settings }) : a.create(entry.provider, loc.id, settings);
  });
  return (
    <Drawer open onClose={onClose} title={`${entry.name} · ${loc.name}`} kicker={t('credentials')}
      footer={<div className="flex gap-2"><Button loading={save.pending} onClick={async () => { if (await save.run()) onSaved(); }}>{t('save')}</Button><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button></div>}>
      <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); if (await save.run()) onSaved(); }}>
        <Banner tone="info" icon="lock">{pt.requirements(entry)}</Banner>
        {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
        {entry.fields.map((f) => (
          <Field key={f.key} label={pt.field(f)} hint={f.secret && conn?.credentials[f.key]?.set ? t('secretSet', { masked: conn.credentials[f.key]!.masked ?? '••••' }) : pt.help(f)} optional={!f.required}>
            {({ id, describedBy }) => f.type === 'boolean'
              ? <Select id={id} aria-describedby={describedBy} value={values[f.key] ? 'true' : 'false'} onChange={(e) => setValues({ ...values, [f.key]: e.target.value === 'true' })}><option value="true">{t('yes')}</option><option value="false">{t('no')}</option></Select>
              : f.type === 'select'
                ? <Select id={id} aria-describedby={describedBy} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>{f.options!.map((o) => <option key={o} value={o}>{pt.option(o)}</option>)}</Select>
                : <Input id={id} aria-describedby={describedBy} type={f.secret ? 'password' : 'text'} autoComplete="off" value={String(values[f.key] ?? '')} placeholder={f.secret && conn?.credentials[f.key]?.set ? '••••••••' : ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
          </Field>
        ))}
      </form>
    </Drawer>
  );
}
