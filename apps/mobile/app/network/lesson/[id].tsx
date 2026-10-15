import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Button, Card, DataStatus, Icon, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { netApi, type QuizResult } from '@/features/network/api';
import { useNT } from '@/features/network/strings';
import { useNetOrg } from '@/features/network/useNetOrg';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

/** Lesson player for staff on the go: reading, video link, files and quizzes with the pass mark. */
export default function LessonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useNT();
  const { org } = useNetOrg();
  const q = useApi(() => (org ? netApi.lesson(org.id, id) : Promise.resolve(null)), [org?.id, id]);
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const l = q.data;
  const done = l?.enrolment?.status === 'completed' || result?.enrolment.status === 'completed';
  const goNext = () => { setResult(null); setAnswers({}); if (l?.nextId) router.replace(`/network/lesson/${l.nextId}`); else router.back(); };

  return (
    <Screen tabs={false}>
      <ScreenHeader title={l?.title ?? t('lesson')} kicker={l?.courseTitle} back />
      <DataStatus q={q} />
      {!l ? <SkeletonCard /> : (
        <>
          {l.videoUrl ? <Button label={t('watch')} icon="play" variant="secondary" onPress={() => void Linking.openURL(l.videoUrl!)} /> : null}
          {l.body ? <Text>{l.body}</Text> : null}
          {l.attachments.map((a) => <Button key={a.url} label={a.name} icon="download" variant="soft" onPress={() => void Linking.openURL(a.url)} />)}
          {l.kind === 'quiz' && l.quiz ? (
            <>
              <Text tone="muted">{t('passMark', { n: l.passMark ?? 0 })}</Text>
              {l.quiz.map((qq, i) => {
                const r = result?.results.find((x) => x.questionId === qq.id);
                return (
                  <Card key={qq.id}>
                    <Text weight={700}>{`${i + 1}. ${qq.prompt}`}</Text>
                    {qq.multiple ? <Text variant="small" tone="muted">{t('chooseAll')}</Text> : null}
                    {qq.options.map((o, oi) => {
                      const on = (answers[qq.id] ?? []).includes(oi);
                      return (
                        <Pressable key={oi} accessibilityRole={qq.multiple ? 'checkbox' : 'radio'} accessibilityState={{ checked: on }} onPress={() => {
                          const cur = answers[qq.id] ?? [];
                          setAnswers({ ...answers, [qq.id]: qq.multiple ? (on ? cur.filter((x) => x !== oi) : [...cur, oi]) : [oi] });
                        }} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
                          <View style={{ width: 22, height: 22, borderRadius: qq.multiple ? 6 : 11, borderWidth: 2, borderColor: color.ink, backgroundColor: on ? color.ink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                            {on ? <Icon name="check" size={14} color={color.surface} /> : null}
                          </View>
                          <Text style={{ flex: 1 }}>{o}</Text>
                        </Pressable>
                      );
                    })}
                    {r ? <Text weight={700} color={r.correct ? '#1F6B3A' : '#9E1B12'}>{r.correct ? t('correct') : t('incorrect')}</Text> : null}
                  </Card>
                );
              })}
              {result ? <Banner tone={result.passed ? 'success' : 'warning'} title={result.passed ? t('passed', { n: result.score }) : t('failed', { n: result.score, mark: result.passMark })} /> : null}
              {err ? <Banner tone="danger" title={err} /> : null}
              {!(result?.passed || l.completed) ? (
                <Button label={t('submit')} loading={busy} disabled={l.quiz.some((x) => !(answers[x.id] ?? []).length)} onPress={async () => {
                  if (!org) return;
                  setBusy(true); setErr(null);
                  try { setResult(await netApi.quiz(org.id, l.id, answers)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
                }} />
              ) : null}
            </>
          ) : null}
          {done ? <Banner tone="success" title={t('courseDone')} /> : null}
          {l.kind !== 'quiz' && !l.completed && l.enrolment?.status === 'active' ? (
            <Button label={t('complete')} icon="check" loading={busy} onPress={async () => {
              if (!org) return;
              setBusy(true);
              try { await netApi.complete(org.id, l.id); if (l.nextId) goNext(); else await q.refresh(); } finally { setBusy(false); }
            }} />
          ) : null}
          {l.nextId && (l.completed || result?.passed) ? <Button label={t('next')} variant="secondary" iconEnd="arrow-right" onPress={goNext} /> : null}
        </>
      )}
    </Screen>
  );
}
