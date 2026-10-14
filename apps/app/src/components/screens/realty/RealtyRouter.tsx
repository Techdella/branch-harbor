'use client';

import { ListingsScreen } from './ListingsScreen';
import { PortalsScreen, PulseScreen } from './InsightScreens';
import { AgentsScreen, EnquiriesScreen, OffersScreen, ViewingsScreen } from './WorkScreens';

/** Real Estate operations screens (nav: lib/nav.ts → OPS.realty). */
export function RealtyScreen({ screen }: { screen: string }) {
  switch (screen) {
    case 'pulse':
      return <PulseScreen />;
    case 'listings':
      return <ListingsScreen />;
    case 'enquiries':
      return <EnquiriesScreen />;
    case 'viewings':
      return <ViewingsScreen />;
    case 'offers':
      return <OffersScreen />;
    case 'agents':
      return <AgentsScreen />;
    case 'portals':
      return <PortalsScreen />;
  }
  return null;
}
