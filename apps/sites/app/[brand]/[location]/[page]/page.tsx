import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { PageContent } from '@/components/PageContent';
import { LocationDocument } from '@/components/builder/SiteContent';
import { apiGet } from '@/lib/api';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string; page: string }> };

async function load({ params }: Props) {
  const { brand, location, page } = await params;
  const data = await loadLocation(brand, location);
  const p = data.pages.find((x) => x.slug === page && page !== 'home');
  if (!p) {
    // A page whose address changed: answer with a permanent redirect to its new address.
    let to: string | null = null;
    try { to = (await apiGet<{ to: string }>(`/v1/public/sites/redirect?brand=${encodeURIComponent(brand)}&location=${encodeURIComponent(location)}&slug=${encodeURIComponent(page)}`, { revalidate: 60 })).to; } catch { /* no redirect */ }
    if (to) permanentRedirect(makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost }).location(location, `/${to}`));
    notFound();
  }
  return { data, p, brand, location };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { data, p, brand, location } = await load(props);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return {
    title: p.seo.title ?? `${p.title} · ${data.brand.name} ${data.location.name}`,
    description: p.seo.description ?? undefined,
    alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, `/${p.slug}`) },
    ...(p.seo.socialImage ? { openGraph: { images: [p.seo.socialImage] } } : {}),
    ...(p.seo.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/** Additional published pages of a location site (only published versions ever reach here). */
export default async function LocationPage(props: Props) {
  const { data, p, brand, location } = await load(props);
  if (p.document) {
    const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
    return (
      <main id="main">
        <LocationDocument doc={p.document} site={data} brandSlug={brand} locationSlug={location} href={(x) => links.location(location, x)} brandHref={(x) => links.brand(x)} pageUrl={links.locationCanonical(location, data.site.primaryHost, `/${p.slug}`)} />
      </main>
    );
  }
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-4xl font-extrabold tracking-tight">{p.title}</h1>
      <div className="mt-6"><PageContent page={p} /></div>
    </main>
  );
}
