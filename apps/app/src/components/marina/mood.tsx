'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MarinaAvatar, MarinaFigure, cx } from '@bh/ui';
import type { MarinaMood } from '@bh/icons';
import { ASSISTANT_NAME, type BriefingItem } from '@bh/shared';
import type { AssistantInfo } from '@/lib/marina';
import { useFormatters } from './Blocks';

/**
 * Marina's moods, chosen from state (docs/MARINA.md): happy by default, thinking while she works, celebrate when
 * something went well, concerned when attention is needed, sleep when she is switched off or out of allowance.
 */
export const insightMood = (severity: string): MarinaMood => (severity === 'critical' ? 'concerned' : 'happy');

export function briefingMood(items: BriefingItem[] | null | undefined): MarinaMood {
  if (!items) return 'happy';
  if (!items.length) return 'celebrate';
  return items.some((i) => i.severity === 'critical') ? 'concerned' : 'happy';
}

export type SleepReason = 'off' | 'paused';

/** Why Marina is asleep for this organisation (switched off, or the month's fair-use limit reached), if she is. */
export function sleepReason(info: AssistantInfo | null | undefined, errorCode?: string | null): SleepReason | null {
  if (errorCode === 'ai_disabled' || info?.enabled === false) return 'off';
  if (errorCode === 'ai_credit_limit' || info?.usage.state === 'paused') return 'paused';
  return null;
}

/** First day of the month after `month` (YYYY-MM, UTC metering month): when the AI allowance resets. */
export function allowanceResetsOn(month: string | null | undefined, now = new Date()): string {
  const [y, m] = (month && /^\d{4}-\d{2}$/.test(month) ? month : now.toISOString().slice(0, 7)).split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Marina asleep: why, and what to do about it (who can switch her on, or when the allowance resets). */
export function MarinaSleep({ reason, info, figure, className }: { reason: SleepReason; info: AssistantInfo | null; figure?: boolean; className?: string }) {
  const t = useTranslations('marina');
  const f = useFormatters();
  const admin = !!info?.can.admin;
  const date = f.date(allowanceResetsOn(info?.usage.month));
  const v = { name: ASSISTANT_NAME, date };
  return (
    <div role="status" data-testid="marina-sleep" className={cx('flex gap-3', figure ? 'flex-col items-center text-center' : 'items-start', className)}>
      {figure ? <MarinaFigure width={190} mood="sleep" pose="hold" /> : <MarinaAvatar size={30} mood="sleep" />}
      <div className={cx('flex flex-col gap-1.5', figure && 'items-center')}>
        <p className="text-[15px] font-bold">{t(reason === 'off' ? 'sleep.offTitle' : 'sleep.pausedTitle', v)}</p>
        <p className="max-w-sm text-[13px] leading-relaxed text-stone">{t(reason === 'off' ? 'sleep.offBody' : 'sleep.pausedBody', v)}</p>
        {admin && (
          <Link href="/settings" className="mt-1 inline-flex w-fit items-center rounded-full bg-canvas px-3.5 py-1.5 text-xs font-bold hover:bg-line-soft">
            {t(reason === 'off' ? 'sleep.offAdmin' : 'sleep.pausedAdmin', v)}
          </Link>
        )}
      </div>
    </div>
  );
}
