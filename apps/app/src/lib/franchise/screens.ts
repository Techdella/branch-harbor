/** Franchise development (Sales), new-location onboarding (Network) and Legal screens under /franchise/[screen]. */
export const FRANCHISE_SCREENS = ['pipeline', 'prospect', 'territories', 'onboarding', 'agreements', 'rules', 'validation', 'lifecycle', 'development', 'master'] as const;
export type FranchiseScreen = (typeof FRANCHISE_SCREENS)[number];
export const isFranchiseScreen = (s: string): s is FranchiseScreen => (FRANCHISE_SCREENS as readonly string[]).includes(s);
