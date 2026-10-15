import { View } from 'react-native';
import { Card, Icon, Text } from '@/components';
import { color, pastel } from '@/theme';
import { useSession } from '@/lib/session';
import { holdsNetwork } from './api';
import { useNT } from './strings';

/** Entry card into the network workspaces (Community, Training, Help desk), when the active account has them. */
export function NetworkEntry({ onPress }: { onPress: () => void }) {
  const { t } = useNT();
  const { me } = useSession();
  if (!holdsNetwork(me?.capabilities)) return null;
  return (
    <Card bg={pastel.lilac} onPress={onPress} accessibilityLabel={`${t('entry')}. ${t('entrySub')}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}><Icon name="book" size={20} /></View>
        <View style={{ flex: 1 }}>
          <Text weight={700}>{t('entry')}</Text>
          <Text variant="small" color={color.graphite}>{t('entrySub')}</Text>
        </View>
        <Icon name="chevron-right" size={18} />
      </View>
    </Card>
  );
}
