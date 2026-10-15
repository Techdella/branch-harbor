import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { color, pastel } from '@/theme';
import { useSession } from '@/lib/session';
import { holdsAssistant } from './api';
import { useMT } from './strings';

/** Entry card into the assistant, when the active account holds it. */
export function MarinaEntry({ onPress }: { onPress: () => void }) {
  const { t } = useMT();
  const { me } = useSession();
  if (!holdsAssistant(me?.capabilities)) return null;
  return (
    <Card bg={pastel.lilac} onPress={onPress} accessibilityLabel={`${t('entry')}. ${t('entrySub')}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center' }}><Icon name="sparkles" size={20} color={color.surface} /></View>
        <View style={{ flex: 1 }}>
          <Text weight={700}>{t('entry')}</Text>
          <Text variant="small" color={color.graphite}>{t('entrySub')}</Text>
        </View>
        <Icon name="chevron-right" size={18} />
      </View>
    </Card>
  );
}
