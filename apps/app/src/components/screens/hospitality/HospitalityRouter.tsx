'use client';

import { PulseScreen, ReportsScreen } from './InsightScreens';
import { GridScreen, ReservationsScreen } from './FrontDeskScreens';
import { ChannelsScreen, HousekeepingScreen, OutletScreen, RatesScreen, SetupScreen } from './OpsScreens';

/** Hospitality operations screens (nav: lib/nav.ts → OPS.hospitality). Live API only. */
export function HospitalityScreen({ screen }: { screen: string }) {
  switch (screen) {
    case 'pulse':
      return <PulseScreen />;
    case 'grid':
      return <GridScreen />;
    case 'reservations':
      return <ReservationsScreen />;
    case 'rates':
      return <RatesScreen />;
    case 'housekeeping':
      return <HousekeepingScreen />;
    case 'outlet':
      return <OutletScreen />;
    case 'hotelreports':
      return <ReportsScreen />;
    case 'setup':
      return <SetupScreen />;
    case 'channels':
      return <ChannelsScreen />;
  }
  return null;
}
