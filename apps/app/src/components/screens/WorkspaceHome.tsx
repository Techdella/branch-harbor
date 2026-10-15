'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { moduleDef } from '@bh/shared';
import { WORKSPACE_ICON, workspaceNav } from '@/lib/access';
import { useApp } from '../shell/AppContext';
import { useNavLabel } from '../shell/Sidebar';
import { PageHeader } from '../shell/PageHeader';
import { Empty } from '../ui/States';
import { OverviewScreen } from './OverviewScreen';
import { MarinaHomeCard } from '../marina/MarinaHub';

/**
 * Home of the active workspace: what this person can do here (only modules they hold) and, for Network and
 * Operations, the metrics overview when they hold Reports. Independent businesses keep the single overview.
 */
export function WorkspaceHome() {
  const t = useTranslations('access');
  const app = useApp();
  const label = useNavLabel();
  if (app.org.model === 'independent')
    return (
      <>
        <MarinaHomeCard />
        <OverviewScreen />
      </>
    );
  const ws = app.workspace;
  if (!ws)
    return (
      <>
        <PageHeader icon="grid" title={t('home.emptyTitle')} scope={false} />
        <Empty icon="info" title={t('home.emptyTitle')} body={t('home.emptyBody', { business: app.org.name })} />
      </>
    );
  const links = workspaceNav(ws, app.capabilities, app.industry);
  const metrics = (ws === 'network' || ws === 'operations') && app.hasModule('network.reports');
  const describe = (module: string) => {
    const key = `modules.${module}.description`;
    return t.has(key) ? t(key) : (moduleDef(app.industry, module)?.description ?? '');
  };
  // A module with several screens (Websites → builder + websites, Franchise pipeline → pipeline + territories…) gets
  // its description once; its other cards say what that screen is, or nothing — never the same text twice.
  const described = new Set<string>();
  const descriptionOf = (l: (typeof links)[number]) => {
    const own = `home.linkDescriptions.${l.key}`;
    if (described.has(l.module)) return t.has(own) ? t(own) : '';
    described.add(l.module);
    const text = describe(l.module);
    return links.some((x) => x !== l && x.module !== l.module && describe(x.module) === text) && t.has(own) ? t(own) : text;
  };
  const cards = links.map((l) => ({ link: l, description: descriptionOf(l) }));
  return (
    <>
      <PageHeader icon={WORKSPACE_ICON[ws]} title={t(`workspace.${ws}.name`)} description={t(`workspace.${ws}.description`)} scope={metrics} />
      <MarinaHomeCard />
      <section aria-label={t('home.modules')} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]" data-testid="workspace-home">
        {cards.map(({ link: l, description }) => (
          <Link key={l.href} href={l.href} className="group flex flex-col gap-2 rounded-xl bg-surface p-4 transition hover:shadow-card">
            <span className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-[12px] bg-canvas">
                <Icon name={l.icon} size={17} />
              </span>
              <span className="text-[15px] font-bold">{label(l)}</span>
              <Icon name="chevron-right" size={14} className="ml-auto text-stone group-hover:text-ink" />
            </span>
            {description && <span className="text-sm text-stone">{description}</span>}
          </Link>
        ))}
      </section>
      {metrics && <OverviewScreen header={false} />}
    </>
  );
}
