'use client';

import type { FranchiseScreen } from '@/lib/franchise/screens';
import { LegalScreen } from './LegalScreen';
import { OnboardingScreen } from './OnboardingScreen';
import { PipelineScreen } from './PipelineScreen';
import { ProspectScreen } from './ProspectScreen';
import { RulesScreen } from './RulesScreen';
import { TerritoriesScreen } from './TerritoriesScreen';

/** Franchise development (Sales), new locations (Network) and Legal screens. Navigation comes from capabilities (lib/access.ts MODULE_LINKS). */
export function FranchiseRouter({ screen }: { screen: FranchiseScreen }) {
  switch (screen) {
    case 'pipeline':
      return <PipelineScreen />;
    case 'prospect':
      return <ProspectScreen />;
    case 'territories':
      return <TerritoriesScreen />;
    case 'onboarding':
      return <OnboardingScreen />;
    case 'agreements':
      return <LegalScreen />;
    case 'rules':
      return <RulesScreen />;
  }
}
