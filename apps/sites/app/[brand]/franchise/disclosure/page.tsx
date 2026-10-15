import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { ReceiptForm } from '@/components/franchise/FranchiseDocs';
import { MessagePage } from '@/components/Message';
import { getDisclosure } from '@/lib/franchise';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** A franchise prospect reads the disclosure document and signs the e-receipt (link from the franchisor's email). */
export default async function DisclosureReceipt({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const t = await getTranslations('franchiseSite');
  const d = token && token.length >= 20 ? await getDisclosure(token).catch(() => null) : null;
  if (!d || !token) return <MessagePage icon="lock" title={t('receiptTitle')} body={t('linkInvalid')} />;
  const kb = Math.max(1, Math.round(d.document.sizeBytes / 1024));
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('receiptTitle')}</h1>
      <p className="text-lg text-graphite">{t('receiptIntro', { brand: d.brand.name, name: d.prospectName })}</p>
      <section className="card flex flex-wrap items-center gap-3 p-5">
        <span className="grid size-11 place-items-center rounded-full bg-canvas"><Icon name="file" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">{d.document.title}</h2>
          <p className="text-sm text-graphite">{t('docMeta', { version: d.document.version, size: kb })}</p>
        </div>
        <a className="btn btn-secondary" href={`/api/v1/public/franchise/disclosures/${encodeURIComponent(token)}/document`} target="_blank" rel="noreferrer"><Icon name="download" size={16} />{t('download')}</a>
      </section>
      <p className="text-sm text-graphite">{t('reviewAdvice')}</p>
      <ReceiptForm token={token} signedAt={d.receiptSignedAt} signedName={d.receiptName} />
    </main>
  );
}
