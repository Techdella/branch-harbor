'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Textarea, cx, type Tone } from '@bh/ui';
import { SOCIAL_LIMITS, SOCIAL_NETWORKS, socialPostIssues, type SocialNetworkKey } from '@bh/shared';
import { fmtDateTime, fmtYmd } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { NotAvailable } from '../screens/NotAvailable';
import { socialApi, type SocialAccount, type SocialPost } from './api';
import { NETWORK_ICON, useCan, useLocationName } from './shared';

const STATUS_TONE: Record<string, Tone> = { draft: 'neutral', pending_approval: 'warning', scheduled: 'info', publishing: 'info', published: 'success', sandboxed: 'neutral', partially_published: 'warning', failed: 'danger', rejected: 'danger', cancelled: 'neutral' };

/**
 * Social: content calendar, approvals of local posts and the accounts HQ owns (with the posting rights handed over
 * to locations). Accounts not connected through OAuth run in sandbox: posts are simulated and labelled as such.
 */
export function SocialScreen() {
  const t = useTranslations('comms.social');
  const app = useApp();
  const can = useCan();
  const [tab, setTab] = useState<'calendar' | 'approvals' | 'accounts'>('calendar');
  const [composing, setComposing] = useState(false);
  const range = useMemo(() => ({ from: new Date(Date.now() - 7 * 86400_000).toISOString(), to: new Date(Date.now() + 45 * 86400_000).toISOString() }), []);
  const posts = useApi(() => socialApi.posts(range), [app.org.id, range], can('marketing.social'));
  const accounts = useApi(() => socialApi.accounts(), [app.org.id], can('marketing.social'));
  if (!can('marketing.social')) return <NotAvailable />;
  const pending = (posts.data?.items ?? []).filter((p) => p.status === 'pending_approval');

  return (
    <>
      <PageHeader icon="share" title={t('title')} description={t('description')} actions={can('marketing.social', 'edit') ? <Button icon="plus" onClick={() => setComposing(true)}>{t('compose')}</Button> : undefined} />
      <Tabs items={[{ key: 'calendar', label: t('tab.calendar') }, { key: 'approvals', label: t('tab.approvals'), count: pending.length }, { key: 'accounts', label: t('tab.accounts') }]} value={tab} onChange={setTab} />
      {tab === 'calendar' && (
        <Async res={posts} loading={<LoadingBlock variant="calendar" />}>
          {(d) => <Calendar posts={d.items.filter((p) => p.status !== 'cancelled')} accounts={accounts.data?.items ?? []} onChanged={() => posts.reload()} />}
        </Async>
      )}
      {tab === 'approvals' && (
        <Async res={posts} loading={<LoadingBlock variant="cards" rows={2} />}>
          {(d) => {
            const list = d.items.filter((p) => p.status === 'pending_approval');
            if (!list.length) return <Empty icon="check-circle" title={t('approvals.empty')} />;
            return <div className="grid gap-3 lg:grid-cols-2">{list.map((p) => <PostCard key={p.id} p={p} accounts={accounts.data?.items ?? []} canApprove={d.canApprove} onChanged={() => posts.reload()} />)}</div>;
          }}
        </Async>
      )}
      {tab === 'accounts' && <Accounts res={accounts} />}
      <Composer open={composing} onClose={() => setComposing(false)} onCreated={() => { setComposing(false); posts.reload(); }} />
    </>
  );
}

function Calendar({ posts, accounts, onChanged }: { posts: SocialPost[]; accounts: SocialAccount[]; onChanged: () => void }) {
  const t = useTranslations('comms.social');
  const locale = useLocale();
  const groups = new Map<string, SocialPost[]>();
  for (const p of posts) {
    const k = p.scheduledAt ? p.scheduledAt.slice(0, 10) : 'none';
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'none' ? -1 : b === 'none' ? 1 : a.localeCompare(b)));
  if (!keys.length) return <Empty icon="calendar" title={t('calendar.empty')} body={t('calendar.emptyBody')} />;
  return (
    <div className="flex flex-col gap-4" data-testid="social-calendar">
      {keys.map((k) => (
        <section key={k} aria-label={k === 'none' ? t('calendar.unscheduled') : fmtYmd(k, locale)}>
          <h2 className="mb-2 text-sm font-bold text-stone">{k === 'none' ? t('calendar.unscheduled') : fmtYmd(k, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
          <div className="grid gap-3 lg:grid-cols-2">{groups.get(k)!.map((p) => <PostCard key={p.id} p={p} accounts={accounts} canApprove={false} onChanged={onChanged} />)}</div>
        </section>
      ))}
    </div>
  );
}

function PostCard({ p, accounts, canApprove, onChanged }: { p: SocialPost; accounts: SocialAccount[]; canApprove: boolean; onChanged: () => void }) {
  const t = useTranslations('comms.social');
  const locale = useLocale();
  const locName = useLocationName();
  const [comment, setComment] = useState('');
  const decide = useMutation((_api, d: 'approve' | 'reject') => socialApi.decide(p.id, d, comment.trim() || undefined));
  const cancel = useMutation(() => socialApi.cancel(p.id));
  return (
    <article className="flex flex-col gap-2.5 rounded-xl bg-surface p-4" data-testid="social-post">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{t(`status.${p.status}`)}</Badge>
        <span className="text-xs text-stone">{locName(p.locationId)} · {p.author.name}</span>
        {p.scheduledAt && <span className="ml-auto text-xs text-stone">{fmtDateTime(p.scheduledAt, Intl.DateTimeFormat().resolvedOptions().timeZone, locale)}</span>}
      </div>
      <p className="whitespace-pre-wrap text-sm">{p.body}</p>
      <div className="flex flex-wrap gap-1.5">
        {p.accountIds.map((id) => {
          const a = accounts.find((x) => x.id === id);
          const r = p.results.find((x) => x.accountId === id);
          return (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold">
              <Icon name={a ? NETWORK_ICON[a.network] ?? 'share' : 'share'} size={13} />{a?.handle ?? t('unknownAccount')}{r ? ` · ${t(`result.${r.status}`)}` : ''}
            </span>
          );
        })}
      </div>
      {p.decisionComment && <p className="rounded-md bg-canvas px-3 py-2 text-[13px]">“{p.decisionComment}”</p>}
      {canApprove && p.status === 'pending_approval' && (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-2.5">
          <Field label={t('approvals.comment')} optional>{(f) => <Input id={f.id} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
          <div className="flex gap-2">
            <Button variant="secondary" icon="x" loading={decide.pending} onClick={async () => { if (await decide.run('reject')) onChanged(); }}>{t('approvals.reject')}</Button>
            <Button icon="check" loading={decide.pending} onClick={async () => { if (await decide.run('approve')) onChanged(); }}>{t('approvals.approve')}</Button>
          </div>
          {decide.error && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
        </div>
      )}
      {['draft', 'pending_approval', 'scheduled', 'rejected'].includes(p.status) && !canApprove && (
        <div><Button variant="ghost" size="sm" icon="x" loading={cancel.pending} onClick={async () => { if (await cancel.run()) onChanged(); }}>{t('cancelPost')}</Button></div>
      )}
      {cancel.error && <Banner tone="danger">{cancel.error.message}</Banner>}
    </article>
  );
}

function Composer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('comms.social');
  const app = useApp();
  const can = useCan();
  const hq = app.scope.kind === 'all' && app.session.assignments.some((a) => a.scope.kind === 'organization') && can('marketing.social', 'edit');
  const choices = useMemo(() => (app.scope.kind === 'all' ? app.locations : app.locations.filter((l) => app.scope.locationIds.includes(l.id))), [app.locations, app.scope]);
  const [ctx, setCtx] = useState<string>('');
  const contextId = ctx || (hq ? 'hq' : choices[0]?.id ?? 'hq');
  const locationId = contextId === 'hq' ? null : contextId;
  const postable = useApi(() => socialApi.postable(locationId), [locationId], open);
  const [picked, setPicked] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [image, setImage] = useState('');
  const [when, setWhen] = useState('');
  const create = useMutation((_api, submit: boolean) => socialApi.create({ locationId, body, media: image.trim() ? [{ url: image.trim() }] : [], accountIds: picked, scheduledAt: when ? new Date(when).toISOString() : null, submit }));
  const accounts = (postable.data?.items ?? []).filter((a) => picked.includes(a.id));
  const media = image.trim() ? [{ url: image.trim() }] : [];
  const issues = accounts.map((a) => ({ a, issues: socialPostIssues(a.network, { body, media }) }));
  const willNeedApproval = !postable.data?.approvesOwnPosts && (locationId === null || postable.data?.tier === 'managed' || (postable.data?.tier !== 'flexible' && accounts.some((a) => a.ownerKind === 'hq')));
  const done = async (submit: boolean) => { if (await create.run(submit)) { setBody(''); setImage(''); setWhen(''); setPicked([]); onCreated(); } };

  return (
    <Drawer open={open} onClose={onClose} title={t('composer.title')} kicker={t('composer.kicker')}
      footer={
        <div className="flex flex-wrap gap-2">
          <Button loading={create.pending} disabled={!picked.length || issues.some((x) => x.issues.length)} onClick={() => done(true)}>{willNeedApproval ? t('composer.submitApproval') : when ? t('composer.schedule') : t('composer.publishNow')}</Button>
          <Button variant="secondary" loading={create.pending} disabled={!picked.length} onClick={() => done(false)}>{t('composer.saveDraft')}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="social-composer">
        <Field label={t('composer.postAs')}>
          {(f) => (
            <Select id={f.id} value={contextId} onChange={(e) => { setCtx(e.target.value); setPicked([]); }}>
              {hq && <option value="hq">{t('composer.hq')}</option>}
              {choices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-bold">{t('composer.accounts')}</legend>
          {(postable.data?.items ?? []).length === 0 && <p className="text-sm text-stone">{t('composer.noAccounts')}</p>}
          {(postable.data?.items ?? []).map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />
              <Icon name={NETWORK_ICON[a.network] ?? 'share'} size={14} />
              {a.handle} <span className="text-xs text-stone">· {t(`network.${a.network}`)} · {a.ownerKind === 'hq' ? t('ownerHq') : t('ownerLocation')}{a.mode === 'sandbox' ? ` · ${t('sandbox')}` : ''}</span>
            </label>
          ))}
        </fieldset>
        <Field label={t('composer.text')}>{(f) => <Textarea id={f.id} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <Field label={t('composer.image')} optional hint={t('composer.imageHint')}>{(f) => <Input id={f.id} type="url" value={image} onChange={(e) => setImage(e.target.value)} />}</Field>
        <Field label={t('composer.when')} optional hint={t('composer.whenHint')}>{(f) => <Input id={f.id} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
        {willNeedApproval && picked.length > 0 && <Banner tone="info">{t('composer.approvalNote')}</Banner>}
        {issues.length > 0 && (
          <section aria-label={t('composer.previews')} className="flex flex-col gap-2">
            <h3 className="text-[13px] font-bold">{t('composer.previews')}</h3>
            {issues.map(({ a, issues: is }) => (
              <div key={a.id} className={cx('rounded-lg border p-3', is.length ? 'border-danger' : 'border-line-soft')}>
                <div className="mb-1.5 flex items-center gap-2 text-xs font-bold"><Icon name={NETWORK_ICON[a.network] ?? 'share'} size={13} />{t(`network.${a.network}`)} · {a.handle}
                  <span className="ml-auto tabular font-semibold text-stone">{t('composer.chars', { n: body.length, max: SOCIAL_LIMITS[a.network as SocialNetworkKey].maxChars })}</span>
                </div>
                {image.trim() && <div className="mb-2 flex h-28 items-center justify-center rounded-md bg-canvas text-xs text-stone"><Icon name="image" size={20} /></div>}
                <p className="whitespace-pre-wrap text-[13px]">{a.network === 'instagram' ? body.slice(0, 125) + (body.length > 125 ? '…' : '') : body}</p>
                {is.map((i) => <p key={i} className="mt-1 text-xs font-bold text-danger">{t(`issue.${i}`)}</p>)}
              </div>
            ))}
          </section>
        )}
        {create.error && <Banner tone="danger" live="assertive">{create.error.message}</Banner>}
      </div>
    </Drawer>
  );
}

function Accounts({ res }: { res: ReturnType<typeof useApi<{ items: SocialAccount[]; hq: boolean }>> }) {
  const t = useTranslations('comms.social');
  const app = useApp();
  const can = useCan();
  const locName = useLocationName();
  const isHq = !!res.data?.hq && can('marketing.social', 'publish');
  const [network, setNetwork] = useState<SocialNetworkKey>('instagram');
  const [handle, setHandle] = useState('');
  const add = useMutation(() => socialApi.addAccount({ network, handle: handle.trim(), ownerKind: 'hq', locationId: null }));
  const grant = useMutation((_api, id: string, loc: string, access: string) => socialApi.grant(id, loc, access));
  const revoke = useMutation((_api, id: string, grantId: string) => socialApi.revoke(id, grantId));
  const [terminateLoc, setTerminateLoc] = useState('');
  const terminate = useMutation((_api, loc: string) => socialApi.revokeLocation(loc));
  const [result, setResult] = useState<string | null>(null);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" rows={2} />}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <Banner tone="info" title={t('accounts.ownershipTitle')}>{t('accounts.ownershipBody')}</Banner>
          {d.items.length === 0 && <Empty icon="share" title={t('accounts.empty')} />}
          <div className="grid gap-3 lg:grid-cols-2">
            {d.items.map((a) => <AccountCard key={a.id} a={a} isHq={isHq} locName={locName} locations={app.locations} onGrant={async (loc, access) => { if (await grant.run(a.id, loc, access)) res.reload(); }} onRevoke={async (g) => { if (await revoke.run(a.id, g)) res.reload(); }} />)}
          </div>
          {(grant.error || revoke.error) && <Banner tone="danger">{(grant.error ?? revoke.error)!.message}</Banner>}
          {isHq && (
            <div className="grid gap-3 lg:grid-cols-2">
              <SectionCard title={t('accounts.addTitle')}>
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-stone">{t('accounts.addBody')}</p>
                  <Field label={t('accounts.network')}>{(f) => <Select id={f.id} value={network} onChange={(e) => setNetwork(e.target.value as SocialNetworkKey)}>{SOCIAL_NETWORKS.map((n) => <option key={n} value={n}>{t(`network.${n}`)}</option>)}</Select>}</Field>
                  <Field label={t('accounts.handle')}>{(f) => <Input id={f.id} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
                  {add.error && <Banner tone="danger">{add.error.message}</Banner>}
                  <div><Button icon="plus" loading={add.pending} disabled={!handle.trim()} onClick={async () => { if (await add.run()) { setHandle(''); res.reload(); } }}>{t('accounts.add')}</Button></div>
                </div>
              </SectionCard>
              <SectionCard title={t('accounts.terminateTitle')}>
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-stone">{t('accounts.terminateBody')}</p>
                  <Field label={t('accounts.location')}>{(f) => <Select id={f.id} value={terminateLoc} onChange={(e) => setTerminateLoc(e.target.value)}><option value="">{t('accounts.chooseLocation')}</option>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
                  {terminate.error && <Banner tone="danger">{terminate.error.message}</Banner>}
                  {result && <Banner tone="success" live="polite">{result}</Banner>}
                  <div><Button variant="danger" disabled={!terminateLoc} loading={terminate.pending} onClick={async () => { const r = await terminate.run(terminateLoc); if (r) { setResult(t('accounts.terminated', { grants: r.grantsRevoked, posts: r.postsCancelled })); res.reload(); } }}>{t('accounts.terminate')}</Button></div>
                </div>
              </SectionCard>
            </div>
          )}
        </div>
      )}
    </Async>
  );
}

function AccountCard({ a, isHq, locName, locations, onGrant, onRevoke }: { a: SocialAccount; isHq: boolean; locName: (id: string | null) => string; locations: Array<{ id: string; name: string }>; onGrant: (loc: string, access: string) => void; onRevoke: (grantId: string) => void }) {
  const t = useTranslations('comms.social');
  const [loc, setLoc] = useState('');
  const [access, setAccess] = useState('post');
  const active = a.grants.filter((g) => !g.revokedAt);
  return (
    <article className="flex flex-col gap-2.5 rounded-xl bg-surface p-4" data-testid="social-account">
      <div className="flex items-center gap-2">
        <Icon name={NETWORK_ICON[a.network] ?? 'share'} size={18} />
        <h3 className="min-w-0 flex-1 truncate font-bold">{a.handle}</h3>
        <Badge tone={a.mode === 'live' ? 'success' : 'neutral'}>{a.mode === 'live' ? t('live') : t('sandbox')}</Badge>
      </div>
      <p className="text-xs text-stone">{t(`network.${a.network}`)} · {a.ownerKind === 'hq' ? t('ownerHq') : t('ownedBy', { location: locName(a.locationId) })}</p>
      {a.ownerKind === 'hq' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold">{t('accounts.rights')}</span>
          {active.length === 0 && <span className="text-xs text-stone">{t('accounts.noRights')}</span>}
          {active.map((g) => (
            <div key={g.id} className="flex items-center gap-2 text-[13px]">
              <span className="flex-1">{locName(g.locationId)} · {t(`access.${g.access}`)}</span>
              {isHq && <Button size="sm" variant="ghost" onClick={() => onRevoke(g.id)}>{t('accounts.revoke')}</Button>}
            </div>
          ))}
          {isHq && (
            <div className="flex flex-wrap items-end gap-2">
              <Select aria-label={t('accounts.location')} className="h-10 w-auto" value={loc} onChange={(e) => setLoc(e.target.value)}>
                <option value="">{t('accounts.chooseLocation')}</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
              <Select aria-label={t('accounts.accessLabel')} className="h-10 w-auto" value={access} onChange={(e) => setAccess(e.target.value)}>
                {['post', 'post_insights', 'view'].map((x) => <option key={x} value={x}>{t(`access.${x}`)}</option>)}
              </Select>
              <Button size="sm" disabled={!loc} onClick={() => { onGrant(loc, access); setLoc(''); }}>{t('accounts.grant')}</Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
