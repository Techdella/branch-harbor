import type { ReactNode } from 'react';
import { cx } from '../cx';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/** Data table on desktop; labelled cards below md. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode }) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <>
      <table className="hidden w-full border-collapse text-sm md:table">
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
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            <button type="button" onClick={onRowClick ? () => onRowClick(r) : undefined} className="w-full rounded-md border border-line-soft bg-surface p-4 text-left">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {columns.map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-xs font-bold text-stone">{c.header}</dt>
                    <dd className="text-right font-medium">{c.render(r)}</dd>
                  </div>
                ))}
              </dl>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
