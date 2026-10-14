import { cx } from '../cx';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number;
}

/** Segmented pill tabs. */
export function Tabs<K extends string>({ items, value, onChange, className }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('inline-flex flex-wrap gap-1 rounded-full bg-canvas p-1', className)}>
      {items.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx('h-9 rounded-full px-4 text-[13px] font-bold transition', value === t.key ? 'bg-ink text-white' : 'text-graphite hover:text-ink')}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 opacity-60">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
