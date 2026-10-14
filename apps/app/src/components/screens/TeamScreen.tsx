'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Avatar, Badge, Button, DataTable, Field, Input, Select } from '@bh/ui';
import type { Member } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock } from '../ui/States';

const ROLE_OPTIONS = ['hq_admin', 'regional_manager', 'franchise_owner', 'location_manager', 'staff', 'marketing_contributor', 'finance'] as const;

export function TeamScreen() {
  const t = useTranslations('team');
  const app = useApp();
  const res = useApi((api) => api.team.members(app.ctx), [app.industry, app.role], app.can('members.manage'));
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('location_manager');
  const [scopeId, setScopeId] = useState(app.scopes.find((s) => s.kind === 'location')?.id ?? 'all');
  const [ok, setOk] = useState('');
  const invite = useMutation((api) => api.team.invite({ email, role: t(`role.${role}`), roleKey: role, scopeId, scopeLabel: app.scopes.find((s) => s.id === scopeId)?.label ?? '' }));
  if (!app.can('members.manage')) return <DeniedState permission="members.manage" />;

  return (
    <>
      <PageHeader icon="user" title={t('title')} description={t('description')} actions={<Button icon="plus" onClick={() => (setInviting(true), setOk(''))}>{t('invite')}</Button>} />
      {ok && <Banner tone="success" live="polite">{ok}</Banner>}
      {inviting && (
        <section className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-label={t('invite')}>
          <h2 className="text-lg font-bold">{t('inviteTitle')}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t('email')} error={invite.error?.fields?.email}>
              {(p) => <Input id={p.id} type="email" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label={t('roleLabel')}>
              {(p) => (
                <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {t(`role.${r}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('scope')} hint={t('scopeHint')}>
              {(p) => (
                <Select id={p.id} aria-describedby={p.describedBy} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                  {app.scopes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.kind === 'all' ? t('wholeOrg') : s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <p className="text-xs text-stone">{t(`roleHelp.${role}`)}</p>
          <div className="flex gap-2">
            <Button
              loading={invite.pending}
              onClick={async () => {
                const m = await invite.run();
                if (m) {
                  setOk(t('invited', { email: m.email }));
                  setInviting(false);
                  setEmail('');
                  res.reload();
                }
              }}
            >
              {t('send')}
            </Button>
            <Button variant="secondary" onClick={() => setInviting(false)}>
              {t('cancel')}
            </Button>
          </div>
        </section>
      )}
      <Async res={res} permission="members.manage" loading={<LoadingBlock variant="table" />}>
        {(members) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<Member>
              rows={members}
              rowKey={(m) => m.id}
              columns={[
                { key: 'person', header: t('col.person'), render: (m) => <span className="flex items-center gap-2.5"><Avatar name={m.name} size={32} pastel={m.status === 'support' ? '#F7EDA8' : '#E2F5A6'} /><span><strong>{m.name}</strong><span className="block text-xs text-stone">{m.email}</span></span></span> },
                { key: 'roles', header: t('col.assignments'), render: (m) => <ul className="flex flex-col gap-0.5">{m.assignments.map((a, i) => <li key={i}><strong>{a.role}</strong> <span className="text-stone">· {a.scopeLabel}</span></li>)}</ul> },
                { key: 'last', header: t('col.lastActive'), render: (m) => m.lastActive },
                { key: 'status', header: t('col.status'), render: (m) => <Badge tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'info' : 'warning'} icon={m.status === 'support' ? 'shield' : undefined}>{t(`status.${m.status}`)}</Badge> },
              ]}
            />
          </section>
        )}
      </Async>
      <p className="text-xs text-stone">{t('footer')}</p>
    </>
  );
}
