'use client';

import { AnnouncementsScreen } from './AnnouncementsScreen';
import { BalancesScreen } from './BalancesScreen';
import { GuardiansScreen } from './GuardiansScreen';
import { ProgrammesScreen } from './ProgrammesScreen';
import { ScheduleScreen } from './ScheduleScreen';
import { SportsOverviewScreen } from './SportsOverviewScreen';
import { SportsReportsScreen } from './SportsReportsScreen';
import { TeamsScreen } from './TeamsScreen';

/** Sports operations screens (full product). */
export function SportsScreen({ screen }: { screen: string }) {
  switch (screen) {
    case 'overview':
      return <SportsOverviewScreen />;
    case 'programmes':
      return <ProgrammesScreen />;
    case 'teams':
      return <TeamsScreen />;
    case 'schedule':
      return <ScheduleScreen />;
    case 'balances':
      return <BalancesScreen />;
    case 'announcements':
      return <AnnouncementsScreen />;
    case 'guardians':
      return <GuardiansScreen />;
    case 'reports':
      return <SportsReportsScreen />;
    default:
      return null;
  }
}
