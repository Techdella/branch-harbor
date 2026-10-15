import { router } from 'expo-router';
import { ListItem } from '@/components';
import { useSession } from '@/lib/session';
import { pastel } from '@/theme';
import { useHospStrings } from './strings';

const holds = (caps: readonly string[], modules: readonly string[]) => caps.some((c) => modules.some((m) => c === `${m}:view`));

/**
 * Entry point into the Hospitality screens. Guests: the stays brand. Staff and owners: only when the active business
 * account is a hospitality business and the person holds the module (front desk / housekeeping, or reports).
 */
export function HospitalityEntry({ kind }: { kind: 'guest' | 'staff' | 'owner' }) {
  const { s } = useHospStrings();
  const { me } = useSession();
  if (kind !== 'guest') {
    const account = me?.accounts?.find((a) => a.id === me.accountId);
    const caps = me?.capabilities ?? [];
    if (account?.industry !== 'hospitality') return null;
    if (kind === 'staff' && !holds(caps, ['operations.reservations', 'operations.housekeeping'])) return null;
    if (kind === 'owner' && !holds(caps, ['network.reports'])) return null;
  }
  const map = { guest: { title: s('stays'), sub: s('staysKicker'), href: '/hospitality' }, staff: { title: s('staffTitle'), sub: s('tasks'), href: '/hospitality/staff' }, owner: { title: s('pulseTitle'), sub: s('pulseSub'), href: '/hospitality/pulse' } } as const;
  const m = map[kind];
  return <ListItem icon="bed" iconBg={pastel.lilac} title={m.title} subtitle={m.sub} chevron onPress={() => router.push(m.href)} />;
}
