import { useEffect } from 'react';
import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { color, pastel } from '@/theme';
import { useSession } from '@/lib/session';
import { holdsAudits, holdsCompliance } from './api';
import { startOfflineSync } from './offline';
import { useQT } from './strings';

/** Entry card into audits and compliance documents, when the active account has either. Also starts offline sync. */
export function QualityEntry({ onPress }: { onPress: () => void }) {
  const { t } = useQT();
  const { me } = useSession();
  const show = holdsAudits(me?.capabilities) || holdsCompliance(me?.capabilities);
  useEffect(() => { if (show) startOfflineSync(); }, [show]);
  if (!show) return null;
  return (
    <Card bg={pastel.butter} onPress={onPress} accessibilityLabel={`${t('entry')}. ${t('entrySub')}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}><Icon name="check-circle" size={20} /></View>
        <View style={{ flex: 1 }}>
          <Text weight={700}>{t('entry')}</Text>
          <Text variant="small" color={color.graphite}>{t('entrySub')}</Text>
        </View>
        <Icon name="chevron-right" size={18} />
      </View>
    </Card>
  );
}
