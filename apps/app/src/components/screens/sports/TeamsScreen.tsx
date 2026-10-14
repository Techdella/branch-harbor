'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tabs } from '@bh/ui';
import type { SSelection, STeam, STeamDetail } from '@/lib/sports/types';
import { getSports } from '@/lib/sports/client';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../../ui/States';
import { CapacityBar, FieldLabel, areaCls, fmtDate, inputCls, useScopeIds } from './ui';

/** Rosters, coach assignments, transfers between groups (capacity-checked, with history) and squad selection. */
export function TeamsScreen() {
  const t = useTranslations('sportsHub.teams');
  const tOps = useTranslations('ops.sports.teams');
  const app = useApp();
  const scope = useScopeIds();
  const [tab, setTab] = useState<'groups' | 'selection'>('groups');
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const res = useSports(async (c) => ({ teams: await c.teams(scope), programmes: await c.programmes(scope) }), [scope.join(','), app.role]);

  return (
    <>
      <PageHeader icon="users" title={tOps('title')} description={tOps('description')} />
      <Tabs items={[{ key: 'groups', label: t('groupsTab') }, { key: 'selection', label: t('selectionTab') }]} value={tab} onChange={setTab} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
        {({ teams, programmes }) => tab === 'groups' ? (
          teams.length === 0 ? <Empty icon="users" title={t('empty')} /> : (
            <div className="flex flex-col gap-3">
              {programmes.filter((p) => teams.some((x) => x.programmeId === p.id)).map((p) => (
                <SectionCard key={p.id} title={p.name} aside={<span className="text-xs text-stone">{app.locations.find((l) => l.id === p.locationId)?.name}</span>}>
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr))]">
                    {teams.filter((x) => x.programmeId === p.id).map((tm) => (
                      <button key={tm.id} type="button" onClick={() => setOpenId(tm.id)} className="flex flex-col gap-2 rounded-lg bg-canvas p-3 text-left hover:ring-2 hover:ring-line">
                        <div className="flex items-center justify-between gap-2"><span className="font-bold">{tm.name}</span>{tm.kind !== 'team' && <Badge tone={tm.kind === 'squad' ? 'signal' : 'neutral'} icon={tm.kind === 'squad' ? 'trophy' : null}>{t(`kind.${tm.kind}`)}</Badge>}</div>
                        <div className="text-xs text-stone">{tm.coach ? t('coach', { name: tm.coach.name }) : t('noCoach')}{tm.assistants.length ? ` · ${t('assistants', { n: tm.assistants.length })}` : ''}{tm.youCoach ? ` · ${t('youCoach')}` : ''}</div>
                        <CapacityBar used={tm.rosterCount} capacity={tm.capacity} label={t('roster')} />
                      </button>
                    ))}
                  </div>
                </SectionCard>
              ))}
              <TeamDrawer id={openId} teams={teams} onClose={() => setOpenId(null)} onChanged={(m) => { setMsg(m); res.reload(); }} />
            </div>
          )
        ) : <SelectionPanel teams={teams} onChanged={(m) => { setMsg(m); res.reload(); }} />}
      </Async>
    </>
  );
}

function TeamDrawer({ id, teams, onClose, onChanged }: { id: string | null; teams: STeam[]; onClose: () => void; onChanged: (m: string) => void }) {
  const t = useTranslations('sportsHub.teams');
  const locale = useLocale();
  const app = useApp();
  const detail = useSports((c) => c.team(id!), [id], !!id);
  const team = teams.find((x) => x.id === id);
  const coaches = useSports((c) => c.coaches(team!.locationId), [team?.locationId], !!team && app.can('customers.write'));
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [head, setHead] = useState<string>('');
  const transfer = useSportsAction((c, regId: string, to: string) => c.transfer(regId, to).then(() => true));
  const setCoaches = useSportsAction((c, h: string | null, a: string[]) => c.setCoaches(id!, h, a).then(() => true));
  useEffect(() => { setMoveTo({}); setHead(team?.coach?.id ?? ''); }, [id, team?.coach?.id]);
  if (!id || !team) return null;
  const others = teams.filter((x) => x.programmeId === team.programmeId && x.id !== team.id && x.kind !== 'squad');
  return (
    <Drawer open onClose={onClose} title={team.name} kicker={t(`kind.${team.kind}`)}>
      <Async res={detail} loading={<LoadingBlock variant="detail" />}>
        {(d: STeamDetail) => (
          <div className="flex flex-col gap-4 text-sm">
            {(transfer.error || setCoaches.error) && <Banner tone="danger" live="assertive">{(transfer.error ?? setCoaches.error)!.message}</Banner>}
            <section className="flex flex-col gap-2">
              <h3 className="font-bold">{t('coaches')}</h3>
              <p>{d.coach ? t('coach', { name: d.coach.name }) : t('noCoach')}{d.assistants.length ? ` · ${d.assistants.map((a) => a.name).join(', ')}` : ''}</p>
              {d.canManage && app.can('customers.write') && (
                <div className="flex gap-2">
                  <label className="sr-only" htmlFor="head-coach">{t('headCoach')}</label>
                  <select id="head-coach" className={inputCls} value={head} onChange={(e) => setHead(e.target.value)}><option value="">{t('noCoach')}</option>{(coaches.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <Button size="sm" variant="secondary" loading={setCoaches.pending} onClick={async () => { if (await setCoaches.run(head || null, d.assistants.map((a) => a.id))) onChanged(t('coachesSaved')); }}>{t('save')}</Button>
                </div>
              )}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="font-bold">{t('rosterTitle', { n: d.roster.length, capacity: team.capacity ?? '∞' })}</h3>
              {d.roster.length === 0 ? <p className="text-stone">{t('rosterEmpty')}</p> : (
                <ul className="flex flex-col divide-y divide-line-soft">
                  {d.roster.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span><strong>{r.name}</strong> {r.ageGroup && <span className="text-xs text-stone">· {r.ageGroup}</span>}</span>
                      {d.canManage && app.can('customers.write') && r.registrationId && others.length > 0 && (
                        <span className="flex gap-1.5">
                          <label className="sr-only" htmlFor={`mv-${r.id}`}>{t('moveTo')}</label>
                          <select id={`mv-${r.id}`} className="h-9 rounded-xs border border-line px-2 text-xs" value={moveTo[r.id] ?? ''} onChange={(e) => setMoveTo((m) => ({ ...m, [r.id]: e.target.value }))}>
                            <option value="">{t('moveTo')}</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.capacity !== null && o.rosterCount >= o.capacity ? t('full') : `${o.rosterCount}/${o.capacity ?? '∞'}`}</option>)}
                          </select>
                          <Button size="sm" variant="secondary" disabled={!moveTo[r.id]} loading={transfer.pending} onClick={async () => { if (await transfer.run(r.registrationId!, moveTo[r.id]!)) { onChanged(t('moved', { name: r.name })); detail.reload(); } }}>{t('move')}</Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-1">
              <h3 className="font-bold">{t('history')}</h3>
              {d.moves.length === 0 ? <p className="text-stone">{t('noMoves')}</p> : d.moves.map((m) => (
                <p key={m.id} className="text-xs"><Icon name="repeat" size={12} className="mr-1 inline" />{t('moveLine', { name: m.participant, dir: m.toTeamId === team.id ? t('in') : t('out'), date: fmtDate(m.at, locale) })}{m.reason ? ` · ${m.reason}` : ''}</p>
              ))}
            </section>
          </div>
        )}
      </Async>
    </Drawer>
  );
}

function SelectionPanel({ teams, onChanged }: { teams: STeam[]; onChanged: (m: string) => void }) {
  const t = useTranslations('sportsHub.selection');
  const app = useApp();
  const scope = useScopeIds();
  const res = useSports((c) => c.selections(scope), [scope.join(','), app.role]);
  const squads = teams.filter((x) => x.kind === 'squad');
  const [squadId, setSquadId] = useState(squads[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [pool, setPool] = useState<{ id: string; name: string; team: string }[]>([]);
  const [decisionNote, setDecisionNote] = useState<Record<string, string>>({});
  const propose = useSportsAction((c, input: Parameters<typeof c.proposeSelection>[0]) => c.proposeSelection(input).then(() => true));
  const decide = useSportsAction((c, id: string, d: 'approve' | 'reject', note?: string) => c.decideSelection(id, d, note).then(() => true));
  const squad = squads.find((s) => s.id === squadId);
  useEffect(() => {
    if (!squad) return;
    let live = true;
    (async () => {
      const c = await getSports();
      const sources = teams.filter((x) => x.programmeId === squad.programmeId && x.kind !== 'squad');
      const rosters = await Promise.all(sources.map((s) => c.team(s.id).then((d) => d.roster.map((r) => ({ id: r.id, name: r.name, team: s.name }))).catch(() => [])));
      if (live) setPool(rosters.flat());
    })();
    return () => { live = false; };
  }, [squad, teams]);

  const submit = async () => {
    const ids = Object.entries(picked).filter(([, v]) => v).map(([k]) => k);
    if (await propose.run({ squadTeamId: squadId, title, notes: notes || undefined, participants: ids.map((id) => ({ id })) })) { setPicked({}); setTitle(''); setNotes(''); onChanged(t('proposed')); res.reload(); }
  };

  return (
    <div className="grid items-start gap-3 lg:grid-cols-[1fr_1.2fr]">
      <SectionCard title={t('proposeTitle')}>
        <p className="mb-3 text-xs text-stone">{t('humanOnly')}</p>
        {squads.length === 0 ? <p className="text-sm text-stone">{t('noSquads')}</p> : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="sq">{t('squad')}</FieldLabel><select id="sq" className={inputCls} value={squadId} onChange={(e) => { setSquadId(e.target.value); setPicked({}); }}>{squads.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.rosterCount}/{s.capacity ?? '∞'}</option>)}</select></div>
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="sq-title">{t('titleLabel')}</FieldLabel><input id="sq-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <fieldset className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg bg-canvas p-3"><legend className="text-[13px] font-bold">{t('participants', { n: Object.values(picked).filter(Boolean).length })}</legend>
              {pool.length === 0 && <p className="text-xs text-stone">{t('poolEmpty')}</p>}
              {pool.map((p) => <label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={!!picked[p.id]} onChange={(e) => setPicked((s) => ({ ...s, [p.id]: e.target.checked }))} />{p.name} <span className="text-xs text-stone">· {p.team}</span></label>)}
            </fieldset>
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="sq-notes">{t('notes')}</FieldLabel><textarea id="sq-notes" className={areaCls} value={notes} placeholder={t('notesPlaceholder')} onChange={(e) => setNotes(e.target.value)} /></div>
            {propose.error && <Banner tone="danger" live="assertive">{propose.error.message}</Banner>}
            <Button icon="send" disabled={!title.trim() || !Object.values(picked).some(Boolean)} loading={propose.pending} onClick={() => void submit()}>{t('propose')}</Button>
          </div>
        )}
      </SectionCard>
      <SectionCard title={t('listTitle')}>
        {decide.error && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
        <Async res={res} loading={<LoadingBlock variant="table" rows={3} />} isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-stone">{t('none')}</p>}>
          {(items: SSelection[]) => (
            <ul className="flex flex-col gap-3">
              {items.map((s) => (
                <li key={s.id} className="rounded-lg bg-canvas p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2"><strong>{s.title}</strong><Badge tone={s.status === 'approved' ? 'success' : s.status === 'proposed' ? 'info' : 'neutral'} icon={s.status === 'approved' ? 'check-circle' : s.status === 'proposed' ? 'clock' : 'x'}>{t(`status.${s.status}`)}</Badge></div>
                  <div className="text-xs text-stone">{s.squadName} · {t('by', { name: s.proposedByName })}</div>
                  <p className="mt-1">{s.participants.map((p) => p.name).join(', ')}</p>
                  {s.notes && <p className="mt-1 text-xs text-stone">{s.notes}</p>}
                  {s.decisionNote && <p className="mt-1 text-xs">{t('decisionNote', { note: s.decisionNote })}</p>}
                  {s.canDecide && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <label className="sr-only" htmlFor={`dn-${s.id}`}>{t('decisionNoteLabel')}</label>
                      <input id={`dn-${s.id}`} className={inputCls} placeholder={t('decisionNoteLabel')} value={decisionNote[s.id] ?? ''} onChange={(e) => setDecisionNote((m) => ({ ...m, [s.id]: e.target.value }))} />
                      <div className="flex gap-2">
                        <Button size="sm" icon="check" loading={decide.pending} onClick={async () => { if (await decide.run(s.id, 'approve', decisionNote[s.id] || undefined)) { onChanged(t('approved')); res.reload(); } }}>{t('approve')}</Button>
                        <Button size="sm" variant="secondary" disabled={!decisionNote[s.id]?.trim()} onClick={async () => { if (await decide.run(s.id, 'reject', decisionNote[s.id])) { onChanged(t('rejected')); res.reload(); } }}>{t('reject')}</Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </SectionCard>
    </div>
  );
}
