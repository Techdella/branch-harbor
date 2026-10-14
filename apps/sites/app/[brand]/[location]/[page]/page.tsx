import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageContent } from '@/components/PageContent';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; location: string; page: string }> };

async function load({ params }: Props) {
  const { brand, location, page } = await params;
  const data = await loadLocation(brand, location);
  const p = data.pages.find((x) => x.slug === page && page !== 'home');
  if (!p) notFound();
  return { data, p, brand, location };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { data, p, brand, location } = await load(props);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return {
    title: p.seo.title ?? `${p.title} · ${data.brand.name} ${data.location.name}`,
    description: p.seo.description ?? undefined,
    alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, `/${p.slug}`) },
  };
}

/** Additional published pages of a location site (only published versions ever reach here). */
export default async function LocationPage(props: Props) {
  const { p } = await load(props);
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-4xl font-extrabold tracking-tight">{p.title}</h1>
      <div className="mt-6"><PageContent page={p} /></div>
    </main>
  );
}
