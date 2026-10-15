'use client';

import type { FranchiseScreen } from '@/lib/franchise/screens';
import { LegalScreen } from './LegalScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { PipelineScreen } from './PipelineScreen';
import { ProspectScreen } from './ProspectScreen';
import { RulesScreen } from './RulesScreen';
import { TerritoryMapScreen } from '../../fdev/TerritoryMapScreen';
import { ValidationScreen } from '../../fdev/ValidationScreen';
import { LifecycleScreen } from '../../fdev/LifecycleScreen';
import { DevelopmentScreen } from '../../fdev/DevelopmentScreen';
import { MasterScreen } from '../../fdev/MasterScreen';

/** Franchise development (Sales), new locations (Network) and Legal screens. Navigation comes from capabilities (lib/access.ts MODULE_LINKS). */
export function FranchiseRouter({ screen }: { screen: FranchiseScreen }) {
  switch (screen) {
    case 'pipeline':
      return <PipelineScreen />;
    case 'prospect':
      return <ProspectScreen />;
    case 'territories':
      return <TerritoryMapScreen />;
    case 'onboarding':
      return <OnboardingScreen />;
    case 'agreements':
      return <LegalScreen />;
    case 'rules':
      return <RulesScreen />;
    // Franchise development: validation calls, agreement lifecycle, development schedules, master franchise.
    case 'validation':
      return <ValidationScreen />;
    case 'lifecycle':
      return <LifecycleScreen />;
    case 'development':
      return <DevelopmentScreen />;
    case 'master':
      return <MasterScreen />;
  }
}
