import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { SignForm } from '@/components/franchise/FranchiseDocs';
import { MessagePage } from '@/components/Message';
import { getAgreement } from '@/lib/franchise';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Built-in e-signature of a franchise agreement (link from the franchisor's email). */
export default async function SignAgreement({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const t = await getTranslations('franchiseSite');
  const a = token && token.length >= 20 ? await getAgreement(token).catch(() => null) : null;
  if (!a || !token) return <MessagePage icon="lock" title={t('signTitle')} body={t('linkInvalid')} />;
  const kb = Math.max(1, Math.round(a.document.sizeBytes / 1024));
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('signTitle')}</h1>
      <p className="text-lg text-graphite">{t('signIntro', { brand: a.brand.name, name: a.signerName })}</p>
      <section className="card flex flex-wrap items-center gap-3 p-5">
        <span className="grid size-11 place-items-center rounded-full bg-canvas"><Icon name="signature" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">{a.document.title}</h2>
          <p className="text-sm text-graphite">{t('docMeta', { version: a.document.version, size: kb })}</p>
        </div>
        <a className="btn btn-secondary" href={`/api/v1/public/franchise/agreements/${encodeURIComponent(token)}/document`} target="_blank" rel="noreferrer"><Icon name="download" size={16} />{t('download')}</a>
      </section>
      <SignForm token={token} canSign={a.canSign} waitingUntil={a.waitingUntil} otherwiseBlocked={a.otherwiseBlocked} status={a.status} signedAt={a.signedAt} />
      <p className="text-xs text-graphite">{t('esignLegal')}</p>
    </main>
  );
}
