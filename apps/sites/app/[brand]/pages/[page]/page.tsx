import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { PageContent } from '@/components/PageContent';
import { BrandDocument } from '@/components/builder/SiteContent';
import { apiGet } from '@/lib/api';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; page: string }> };

async function load({ params }: Props) {
  const { brand, page } = await params;
  const data = await loadBrand(brand);
  const p = data.pages.find((x) => x.slug === page && page !== 'home');
  if (!p) {
    let to: string | null = null;
    try { to = (await apiGet<{ to: string }>(`/v1/public/sites/redirect?brand=${encodeURIComponent(brand)}&slug=${encodeURIComponent(page)}`, { revalidate: 60 })).to; } catch { /* no redirect */ }
    if (to) permanentRedirect(makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost }).brand(`/pages/${to}`));
    notFound();
  }
  return { data, p, brand };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { data, p, brand } = await load(props);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  return {
    title: p.seo.title ?? `${p.title} · ${data.brand.name}`,
    description: p.seo.description ?? undefined,
    alternates: { canonical: links.brandCanonical(`/pages/${p.slug}`) },
    ...(p.seo.socialImage ? { openGraph: { images: [p.seo.socialImage] } } : {}),
    ...(p.seo.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function BrandPage(props: Props) {
  const { data, p, brand } = await load(props);
  if (p.document) {
    const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
    return <main id="main"><BrandDocument doc={p.document} brand={data.brand} pageUrl={links.brandCanonical(`/pages/${p.slug}`)} /></main>;
  }
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-4xl font-extrabold tracking-tight">{p.title}</h1>
      <div className="mt-6"><PageContent page={p} /></div>
    </main>
  );
}
