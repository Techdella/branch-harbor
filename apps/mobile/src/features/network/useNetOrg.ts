import { useApi } from '@/lib/useApi';
import { networkOrgs, type NetOrg } from './api';

let cached: NetOrg[] | null = null;

/** The network organisation the person works in (the first one; most people belong to exactly one). */
export function useNetOrg() {
  const q = useApi(async () => (cached ??= await networkOrgs()), []);
  return { org: q.data?.[0] ?? null, q };
}
