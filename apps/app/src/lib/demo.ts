/**
 * Demo site (docs/PRODUCT_PLAN.md decision 3): the same app against a demo database, built with
 * NEXT_PUBLIC_DEMO_MODE=true. Only then does the app show the "Demo environment" ribbon and the demo sign-in picker.
 * The production app never shows sample data.
 */
import { demoLogin, http } from './http/client';
import { clearWorkspace } from './http/workspace';

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export interface DemoAccount {
  email: string;
  name: string;
  roles: { role: string; roleName: string; scope: string | null }[];
}
export interface DemoOrg {
  id: string;
  name: string;
  industry: string;
  model: string;
  accounts: DemoAccount[];
}

export async function demoAccounts(): Promise<DemoOrg[]> {
  const r = await http.get<{ organizations: DemoOrg[] }>('/demo/accounts', undefined, { auth: false });
  return r.organizations;
}

export async function signInAsDemo(email: string) {
  await demoLogin(email);
  clearWorkspace();
}
