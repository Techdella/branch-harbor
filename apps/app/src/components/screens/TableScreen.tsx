'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, DataTable, Icon, cx, type Column } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Permission } from '@bh/shared';
import type { Cell, TableData } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { useScopeLabel } from '../shell/ScopePicker';
import { Async, Banner, Empty, LoadingBlock } from '../ui/States';
import { CellView } from './CellView';
import { useTxt } from '../ui/useDataText';

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
  const tt = useTxt();

  const actions = res.status === 'ready' && res.data.primaryAction ? (
    <Button icon="plus" onClick={() => setPlanned(true)}>
      {tt(res.data.primaryAction, res.data.primaryActionMsg)}
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
  const tt = useTxt();
  // Search what the viewer sees (translated labels, business data as is).
  const cellText = (c: Cell | undefined): string => {
    if (!c) return '';
    if (c.t === 'text') return `${tt(c.v, c.vMsg)} ${c.sub ? tt(c.sub, c.subMsg) : ''}`;
    if (c.t === 'badge') return tt(c.v, c.vMsg);
    if (c.t === 'money') return c.sub ? tt(c.sub, c.subMsg) : '';
    if (c.t === 'unavailable') return c.reason ? tt(c.reason, c.reasonMsg) : '';
    return '';
  };
  const needle = q.trim().toLocaleLowerCase();
  const rows = data.rows.filter((r) => (filter === 'all' || r.tags.includes(filter)) && (!needle || Object.values(r.cells).map(cellText).join(' ').toLocaleLowerCase().includes(needle)));
  const columns: Column<Row>[] = data.columns.map((c) => ({ key: c.key, header: tt(c.label, c.labelMsg), align: c.align, render: (r) => <CellView c={r.cells[c.key]} /> }));

  return (
    <section className="rounded-xl bg-surface p-3.5">
      {data.description && <p className="px-1 pb-3 text-sm text-stone">{tt(data.description, data.descriptionMsg)}</p>}
      <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
        <div role="group" aria-label={t('filters')} className="flex flex-wrap gap-2">
          {data.filters.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={cx('h-9 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', filter === f.key ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
              {tt(f.label, f.labelMsg)}
            </button>
          ))}
        </div>
        <label className="flex h-11 min-w-[160px] flex-1 items-center gap-2 rounded-full bg-canvas px-3 sm:max-w-[260px]">
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
        <div className="overflow-x-auto" tabIndex={0}>
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
        </div>
      )}
      <p className="flex items-center gap-1.5 px-1 pt-3 text-xs text-stone">
        <Icon name="info" size={12} />
        {t('source', { source: tt(data.source, data.sourceMsg) })}
      </p>
    </section>
  );
}
