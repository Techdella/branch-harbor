import type { ReactNode } from 'react';
import { cx } from '../cx';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/** Data table from lg (1024 px); labelled cards below (two columns on tablets). Wide tables scroll inside their card. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty, rowLabel }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode; /** Accessible name of a card's "open" action (mobile). */ rowLabel?: (r: T) => string }) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <>
      <div className="hidden max-w-full overflow-x-auto lg:block" tabIndex={0}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-soft text-left">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('px-3 py-3 text-xs font-extrabold uppercase tracking-[0.06em] text-stone', c.align === 'right' && 'text-right')}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx('border-b border-line-soft last:border-0', onRowClick && 'cursor-pointer hover:bg-canvas-raised')}>
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3 py-3.5 font-medium', c.align === 'right' && 'tabular text-right', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            {(() => {
              const body = (
                <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                  {columns.map((c, i) => (
                    <div key={c.key} className="contents">
                      <dt className="text-xs font-bold text-stone">{c.header}</dt>
                      <dd id={i === 0 ? `bh-row-${rowKey(r)}` : undefined} className={cx('min-w-0 text-right font-medium [overflow-wrap:anywhere]', c.align === 'right' && 'tabular')}>{c.render(r)}</dd>
                    </div>
                  ))}
                </dl>
              );
              const cls = 'block w-full rounded-md border border-line-soft bg-surface p-4 text-left';
              // The whole card opens the row, but cells may hold their own controls (checkboxes, buttons):
              // a full-card button sits underneath and the content lets clicks through except on controls,
              // so no interactive element is nested inside another.
              return onRowClick ? (
                <div className={cx(cls, 'relative hover:border-line')}>
                  <button type="button" onClick={() => onRowClick(r)} aria-label={rowLabel?.(r)} aria-labelledby={rowLabel ? undefined : `bh-row-${rowKey(r)}`} className="no-hit absolute inset-0 rounded-md" />
                  <div className="pointer-events-none relative [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_label]:pointer-events-auto [&_select]:pointer-events-auto">{body}</div>
                </div>
              ) : (
                <div className={cls}>{body}</div>
              );
            })()}
          </li>
        ))}
      </ul>
    </>
  );
}
