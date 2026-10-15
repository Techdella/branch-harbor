'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '../shell/PageHeader';
import { LoadingBlock } from '../ui/States';
import { ErrorNote, useNet } from '../community/net';
import { LeadsPanel } from './TrainingAdmin';
import type { TrainingHome } from './TrainingScreen';

/** Sales → Course leads: people interested in public courses, routed to trainers (trainers see their own). */
export function CourseLeadsScreen() {
  const t = useTranslations('training.leads');
  const home = useNet<TrainingHome>('/training/home');
  return (
    <>
      <PageHeader icon="users" title={t('title')} description={t('intro')} scope={false} />
      <ErrorNote error={home.error} />
      {home.data ? <LeadsPanel home={home.data} /> : !home.error && <LoadingBlock variant="table" />}
    </>
  );
}
