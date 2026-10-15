'use client';

import type { ReactNode } from 'react';
import type { IconName } from '@bh/icons';
import { useUiLabels } from '../labels';
import { Card, IconTile } from './Card';

export interface StatCardProps {
  label: string;
  /** `null` renders the "unavailable" label — never a fabricated zero. */
  value: ReactNode | null;
  range?: string;
  source?: string;
  icon?: IconName;
  pastel?: string;
  notConnected?: boolean;
}

/** Overview metric: shows definition, time range and data source. */
export function StatCard({ label, value, range, source, icon, pastel, notConnected }: StatCardProps) {
  const labels = useUiLabels();
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-bold text-graphite">{label}</div>
        {icon && <IconTile name={icon} pastel={pastel} size={36} />}
      </div>
      <div className="tabular text-[32px] font-extrabold tracking-[-0.03em]">
        {notConnected ? <span className="text-xl text-mute">{labels.notConnected}</span> : value ?? <span className="text-xl text-mute">{labels.unavailable}</span>}
      </div>
      {(range || source) && (
        <div className="text-xs font-semibold text-stone">
          {range}
          {range && source && ' · '}
          {source}
        </div>
      )}
    </Card>
  );
}
