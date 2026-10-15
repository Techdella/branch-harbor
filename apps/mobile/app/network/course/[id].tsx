import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Button, Card, DataStatus, Icon, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { netApi } from '@/features/network/api';
import { useNT } from '@/features/network/strings';
import { useNetOrg } from '@/features/network/useNetOrg';
import { useApi } from '@/lib/useApi';

export default function CourseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useNT();
  const { org } = useNetOrg();
  const q = useApi(() => (org ? netApi.course(org.id, id) : Promise.resolve(null)), [org?.id, id]);
  const d = q.data;
  const lessons = d?.outline.flatMap((m) => m.lessons) ?? [];
  const next = lessons.find((l) => !l.completed) ?? lessons[0];
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={d?.course.title ?? t('training')} back />
      <DataStatus q={q} />
      {!d ? <SkeletonCard /> : (
        <>
          {d.course.summary ? <Text tone="muted">{d.course.summary}</Text> : null}
          {d.missingPrerequisites.length ? <Banner tone="warning" title={t('prerequisites', { list: d.missingPrerequisites.map((m) => m.title).join(', ') })} /> : null}
          {d.enrolment ? <Text weight={700}>{d.enrolment.status === 'completed' ? t('courseDone') : t('progress', { n: d.enrolment.progressPct })}</Text> : null}
          {next && d.enrolment?.status !== 'completed' ? (
            <Button label={d.enrolment ? t('continueCourse') : t('start')} icon="play" disabled={d.missingPrerequisites.length > 0} onPress={async () => {
              if (!d.enrolment && org) await netApi.start(org.id, d.course.id);
              router.push(`/network/lesson/${next.id}`);
            }} />
          ) : null}
          {d.outline.map((m) => (
            <Card key={m.id}>
              <Text variant="h3">{m.title}</Text>
              {m.lessons.map((l) => (
                <View key={l.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
                  <Icon name={l.completed ? 'check-circle' : l.kind === 'quiz' ? 'help' : l.kind === 'video' ? 'play' : 'file'} size={18} />
                  <Text style={{ flex: 1 }} onPress={d.enrolment ? () => router.push(`/network/lesson/${l.id}`) : undefined}>{l.title}</Text>
                </View>
              ))}
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
