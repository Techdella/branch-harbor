'use client';

import { Icon } from './Icon';
import { useUiLabels } from '../labels';

export interface ScopeOption {
  id: string;
  label: string;
  kind: 'all' | 'region' | 'owner_group' | 'location';
}

/** Always-visible scope selector: "All authorised locations", a region, an owner group or a location. */
export function ScopeSelector({ options, value, onChange }: { options: ScopeOption[]; value: string; onChange: (id: string) => void }) {
  const ui = useUiLabels();
  return (
    <label className="relative inline-flex h-11 max-w-full items-center gap-2 rounded-full border border-line bg-surface pl-3 pr-8 text-[13px] font-bold">
      <Icon name="pin" size={16} />
      <span className="sr-only">{ui.scope}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 max-w-full appearance-none truncate bg-transparent pr-1 focus:outline-none">
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3">
        <Icon name="chevron-down" size={14} />
      </span>
    </label>
  );
}

/** Shows where a value comes from: inherited from HQ, set locally, or locked. */
export function OriginTag({ origin }: { origin: 'hq' | 'local' | 'locked' | 'approval' }) {
  const ui = useUiLabels();
  const map = {
    hq: { label: ui.originHq, icon: 'building', cls: 'bg-canvas text-graphite' },
    local: { label: ui.originLocal, icon: 'pin', cls: 'bg-lime-soft text-ink' },
    locked: { label: ui.originLocked, icon: 'lock', cls: 'bg-ink text-white' },
    approval: { label: ui.originApproval, icon: 'shield', cls: 'bg-warning-bg text-warning' },
  } as const;
  const o = map[origin];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${o.cls}`}>
      <Icon name={o.icon} size={12} stroke={2.2} />
      {o.label}
    </span>
  );
}
