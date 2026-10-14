import { router } from 'expo-router';
import { ListItem } from '@/components';
import { pastel } from '@/theme';
import { useRealtyStrings } from './strings';

/** Entry point into the Real Estate screens from the customer, staff and owner experiences. */
export function RealtyEntry({ kind }: { kind: 'buyer' | 'agent' | 'owner' }) {
  const { s } = useRealtyStrings();
  const map = { buyer: { title: s('homes'), sub: s('homesKicker'), href: '/realty' }, agent: { title: s('agentTitle'), sub: s('today'), href: '/realty/agent' }, owner: { title: s('pulseTitle'), sub: s('funnel'), href: '/realty/pulse' } } as const;
  const m = map[kind];
  return <ListItem icon="house" iconBg={pastel.aqua} title={m.title} subtitle={m.sub} chevron onPress={() => router.push(m.href)} />;
}
