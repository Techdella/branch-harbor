'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button, EmptyState, Icon, IconTile, cx } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Permission } from '@bh/shared';
import type { ApiError } from '@/lib/api';
import type { Resource } from '@/lib/useApi';

export function Skel({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('bh-skeleton rounded-xl', className)} />;
}

/** Skeletons preserve layout. `variant` matches the shape of the screen being loaded. */
export function LoadingBlock({ variant = 'cards', rows = 4, label }: { variant?: 'cards' | 'table' | 'calendar' | 'detail'; rows?: number; label?: string }) {
  const t = useTranslations('states');
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">{label ?? t('loading')}</span>
      {variant === 'cards' && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-lg bg-surface p-5">
              <Skel className="h-9 w-9" />
              <Skel className="h-4 w-1/2" />
              <Skel className="h-8 w-2/3" />
              <Skel className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      )}
      {variant === 'table' && (
        <div className="flex flex-col gap-2 rounded-xl bg-surface p-4">
          <div className="flex gap-2">
            <Skel className="h-9 w-20 rounded-full" />
            <Skel className="h-9 w-24 rounded-full" />
            <Skel className="h-9 w-20 rounded-full" />
          </div>
          {Array.from({ length: rows }).map((_, i) => (
            <Skel key={i} className="h-14 w-full" />
          ))}
        </div>
      )}
      {variant === 'calendar' && (
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface p-4 md:grid-cols-7">
          {Array.from({ length: 14 }).map((_, i) => (
            <Skel key={i} className="h-24" />
          ))}
        </div>
      )}
      {variant === 'detail' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Skel className="h-72" />
          <Skel className="h-72" />
        </div>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error?: ApiError; onRetry?: () => void; compact?: boolean }) {
  const t = useTranslations('states');
  return (
    <div role="alert" className={cx('flex flex-col items-center gap-3 rounded-xl bg-surface text-center', compact ? 'p-6' : 'px-6 py-14')}>
      <IconTile name="alert" pastel="#FBE4E1" />
      <h2 className="text-h3 font-bold">{t('errorTitle')}</h2>
      <p className="max-w-md text-sm text-stone">{error?.message ?? t('errorBody')}</p>
      {error?.code && <p className="text-xs text-mute">{t('errorCode', { code: error.code })}</p>}
      {onRetry && (
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          {t('retry')}
        </Button>
      )}
    </div>
  );
}

export function DeniedState({ permission, detail }: { permission?: Permission; detail?: string }) {
  const t = useTranslations('states');
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-surface px-6 py-14 text-center">
      <IconTile name="lock" />
      <h2 className="text-h3 font-bold">{t('deniedTitle')}</h2>
      <p className="max-w-md text-sm text-stone">{detail ?? t('deniedBody')}</p>
      {permission && <p className="rounded-full bg-canvas px-3 py-1 text-xs font-bold text-graphite">{t('deniedPermission', { permission })}</p>}
    </div>
  );
}

export function Empty({ icon = 'info', title, body, action }: { icon?: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface p-4">
      <EmptyState icon={icon} title={title} body={body} action={action} />
    </div>
  );
}

/** Renders loading / error / permission-denied / ready for a `useApi` resource. */
export function Async<T>({
  res,
  loading,
  children,
  isEmpty,
  empty,
  permission,
}: {
  res: Resource<T> & { reload: () => void };
  loading?: ReactNode;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  permission?: Permission;
}) {
  if (res.status === 'error') {
    if (res.error.isForbidden) return <DeniedState permission={permission} detail={res.error.message} />;
    return <ErrorState error={res.error} onRetry={res.reload} />;
  }
  if (res.status === 'loading' && res.data === undefined) return <>{loading ?? <LoadingBlock />}</>;
  const data = res.data as T;
  if (isEmpty?.(data) && empty) return <>{empty}</>;
  return <>{children(data)}</>;
}

/** Inline banner: info, warning (stale), danger, success. Always icon + text. */
export function Banner({ tone = 'info', icon, title, children, action, live }: { tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'; icon?: IconName; title?: ReactNode; children?: ReactNode; action?: ReactNode; live?: 'polite' | 'assertive' }) {
  const tones = { info: 'bg-info-bg text-info', warning: 'bg-warning-bg text-warning', danger: 'bg-danger-bg text-danger', success: 'bg-success-bg text-success', neutral: 'bg-canvas text-graphite' } as const;
  const icons = { info: 'info', warning: 'alert', danger: 'alert', success: 'check-circle', neutral: 'info' } as const;
  return (
    <div role={live === 'assertive' ? 'alert' : live ? 'status' : undefined} className={cx('flex flex-wrap items-start gap-3 rounded-lg px-4 py-3 text-sm', tones[tone])}>
      <Icon name={icon ?? icons[tone]} size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 leading-relaxed">
        {title && <div className="font-bold">{title}</div>}
        {children && <div className={title ? 'opacity-90' : undefined}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function SectionCard({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl bg-surface p-5 md:p-6', className)}>
      {(title || aside) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-lg font-bold tracking-tight">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
