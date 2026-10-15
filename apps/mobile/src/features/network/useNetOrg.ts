import { useApi } from '@/lib/useApi';
import { networkOrgs } from './api';

/** The network organisation the person works in: the active business account when it has the network workspaces. */
export function useNetOrg() {
  const q = useApi(() => networkOrgs(), []);
  return { org: q.data?.[0] ?? null, q };
}
