'use client';

import type { ReactNode } from 'react';
import { CalendarView } from './CalendarView';
import { ClientsView } from './ClientsView';
import { InsightsView } from './InsightsView';
import { PackagesView } from './PackagesView';
import { PractitionersView } from './PractitionersView';
import { ServicesView } from './ServicesView';

/** Wellness operations screens (full product). Returns null for keys handled by the generic screens (e.g. forms). */
export function wellnessScreen(key: string): ReactNode | null {
  switch (key) {
    case 'calendar':
      return <CalendarView />;
    case 'services':
      return <ServicesView />;
    case 'practitioners':
      return <PractitionersView />;
    case 'clients':
      return <ClientsView />;
    case 'packages':
      return <PackagesView />;
    case 'insights':
      return <InsightsView />;
    default:
      return null;
  }
}
