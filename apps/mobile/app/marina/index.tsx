import { MarinaScreen } from '@/features/marina/MarinaScreen';

/** The assistant as a stacked screen (entry cards on the staff, network and owner screens). */
export default function MarinaRoute() {
  return <MarinaScreen tabs={false} />;
}
