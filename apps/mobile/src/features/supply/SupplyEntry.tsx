import { useEffect } from 'react';
import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { color, pastel } from '@/theme';
import { useSession } from '@/lib/session';
import { holdsSelfChecks, holdsSuppliers } from './api';
import { useST } from './strings';
import { startOfflineSync } from '../quality/offline';

/** Entry card into receiving deliveries and today's self-checks, when the active account has either. */
export function SupplyEntry({ onPress }: { onPress: () => void }) {
  const { t } = useST();
  const { me } = useSession();
  const checks = holdsSelfChecks(me?.capabilities);
  // Self-checks answered offline sync in the background (the same queue as audits).
  useEffect(() => { if (checks) startOfflineSync(); }, [checks]);
  if (!holdsSuppliers(me?.capabilities) && !checks) return null;
  return (
    <Card bg={pastel.lime} onPress={onPress} accessibilityLabel={`${t('entry')}. ${t('entrySub')}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}><Icon name="truck" size={20} /></View>
        <View style={{ flex: 1 }}>
          <Text weight={700}>{t('entry')}</Text>
          <Text variant="small" color={color.graphite}>{t('entrySub')}</Text>
        </View>
        <Icon name="chevron-right" size={18} />
      </View>
    </Card>
  );
}
