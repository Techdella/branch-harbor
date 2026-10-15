import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { WorkspaceHome } from '@/components/screens/WorkspaceHome';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('overview') };
}
export default function Page() {
  return <WorkspaceHome />;
}
