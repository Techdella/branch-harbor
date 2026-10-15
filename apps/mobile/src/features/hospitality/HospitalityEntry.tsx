import { router } from 'expo-router';
import { ListItem } from '@/components';
import { pastel } from '@/theme';
import { useHospStrings } from './strings';

/** Entry point into the Hospitality screens from the customer, staff and owner experiences. */
export function HospitalityEntry({ kind }: { kind: 'guest' | 'staff' | 'owner' }) {
  const { s } = useHospStrings();
  const map = { guest: { title: s('stays'), sub: s('staysKicker'), href: '/hospitality' }, staff: { title: s('staffTitle'), sub: s('tasks'), href: '/hospitality/staff' }, owner: { title: s('pulseTitle'), sub: s('pulseSub'), href: '/hospitality/pulse' } } as const;
  const m = map[kind];
  return <ListItem icon="bed" iconBg={pastel.lilac} title={m.title} subtitle={m.sub} chevron onPress={() => router.push(m.href)} />;
}
