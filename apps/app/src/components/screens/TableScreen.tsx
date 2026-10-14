'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, DataTable, Icon, cx, type Column } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Permission } from '@bh/shared';
import type { TableData } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { useScopeLabel } from '../shell/ScopePicker';
import { Async, Banner, Empty, LoadingBlock } from '../ui/States';
import { CellView } from './CellView';

type Row = TableData['rows'][number];

/** Generic, scoped list screen: filters, record count with scope, source, mobile cards. */
export function TableScreen({ tableKey, title, icon, permission, description }: { tableKey: string; title: string; icon: IconName; permission?: Permission; description?: string }) {
  const t = useTranslations('table');
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [planned, setPlanned] = useState(false);
  const res = useApi((api) => api.table(app.ctx, tableKey), [app.industry, app.role, app.scopeId, tableKey]);

  const actions = res.status === 'ready' && res.data.primaryAction ? (
    <Button icon="plus" onClick={() => setPlanned(true)}>
      {res.data.primaryAction}
    </Button>
  ) : null;

  return (
    <>
      <PageHeader icon={icon} title={title} description={description} actions={actions} />
      {planned && (
        <Banner tone="info" action={<button className="text-xs font-bold underline" onClick={() => setPlanned(false)}>{t('dismiss')}</button>}>
          {t('planned')}
        </Banner>
      )}
      <Async res={res} permission={permission} loading={<LoadingBlock variant="table" />}>
        {(data) => <TableBody data={data} filter={filter} setFilter={setFilter} q={q} setQ={setQ} scopeLabel={scopeLabel} />}
      </Async>
    </>
  );
}

function TableBody({ data, filter, setFilter, q, setQ, scopeLabel }: { data: TableData; filter: string; setFilter: (f: string) => void; q: string; setQ: (q: string) => void; scopeLabel: string }) {
  const t = useTranslations('table');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.rows.filter((r) => (filter === 'all' || r.tags.includes(filter)) && (!needle || JSON.stringify(r.cells).toLowerCase().includes(needle)));
  }, [data, filter, q]);
  const columns: Column<Row>[] = data.columns.map((c) => ({ key: c.key, header: c.label, align: c.align, render: (r) => <CellView c={r.cells[c.key]} /> }));

  return (
    <section className="rounded-xl bg-surface p-3.5">
      {data.description && <p className="px-1 pb-3 text-sm text-stone">{data.description}</p>}
      <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
        <div role="group" aria-label={t('filters')} className="flex flex-wrap gap-2">
          {data.filters.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={cx('h-9 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', filter === f.key ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="flex h-9 min-w-[160px] flex-1 items-center gap-2 rounded-full bg-canvas px-3 sm:max-w-[260px]">
          <Icon name="search" size={14} />
          <span className="sr-only">{t('searchTable')}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchTable')} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <span className="ml-auto text-xs text-stone" aria-live="polite">
          {t('count', { count: rows.length, scope: scopeLabel })}
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty icon="filter" title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <div className="overflow-x-auto">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
        </div>
      )}
      <p className="flex items-center gap-1.5 px-1 pt-3 text-xs text-stone">
        <Icon name="info" size={12} />
        {t('source', { source: data.source })}
      </p>
    </section>
  );
}
