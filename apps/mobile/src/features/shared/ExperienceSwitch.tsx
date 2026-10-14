import { router } from 'expo-router';
import { IconButton } from '@/components';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';

/** Demo-only experience switcher (production derives the experience from /v1/auth/me). */
export function ExperienceSwitch() {
  const { t } = useI18n();
  const { me, setExperience } = useSession();
  if (!me || me.experiences.length < 2) return null;
  return (
    <IconButton
      icon="users"
      label={t('profile.switchExperience')}
      variant="secondary"
      size={40}
      onPress={() => {
        setExperience(null);
        router.replace('/');
      }}
    />
  );
}
