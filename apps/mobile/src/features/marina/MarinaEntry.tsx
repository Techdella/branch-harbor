import { View } from 'react-native';
import { Card, Icon, MarinaMark, Text } from '@/components';
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
        <MarinaMark size={44} />
        <View style={{ flex: 1 }}>
          <Text weight={700}>{t('entry')}</Text>
          <Text variant="small" color={color.graphite}>{t('entrySub')}</Text>
        </View>
        <Icon name="chevron-right" size={18} />
      </View>
    </Card>
  );
}
