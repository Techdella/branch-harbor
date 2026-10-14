import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageContent } from '@/components/PageContent';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; page: string }> };

async function load({ params }: Props) {
  const { brand, page } = await params;
  const data = await loadBrand(brand);
  const p = data.pages.find((x) => x.slug === page && page !== 'home');
  if (!p) notFound();
  return { data, p, brand };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { data, p, brand } = await load(props);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  return {
    title: p.seo.title ?? `${p.title} · ${data.brand.name}`,
    description: p.seo.description ?? undefined,
    alternates: { canonical: links.brandCanonical(`/pages/${p.slug}`) },
  };
}

export default async function BrandPage(props: Props) {
  const { p } = await load(props);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-4xl font-extrabold tracking-tight">{p.title}</h1>
      <div className="mt-6"><PageContent page={p} /></div>
    </main>
  );
}
