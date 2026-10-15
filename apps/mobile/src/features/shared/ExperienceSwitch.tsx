import { router } from 'expo-router';
import { IconButton } from '@/components';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';

/** Back to the chooser when the person holds several experiences or several business accounts (derived from /v1/auth/me). */
export function ExperienceSwitch() {
  const { t } = useI18n();
  const { me, setExperience } = useSession();
  if (!me || (me.experiences.length < 2 && (me.accounts?.length ?? 0) < 2)) return null;
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
