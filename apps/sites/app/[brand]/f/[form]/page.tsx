import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteForm, type PublicFormDef } from '@/components/builder/SiteForms';
import { apiGet, isNotFound } from '@/lib/api';
import { getRouting, loadBrand, makeLinks } from '@/lib/site';

type Props = { params: Promise<{ brand: string; form: string }> };
type FormPage = PublicFormDef & { brand: { slug: string; name: string }; settings: PublicFormDef['settings'] & { landing: { enabled: boolean; heading: string; intro: string; image: string } } };

async function load({ params }: Props) {
  const { brand, form } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(form)) notFound();
  const data = await loadBrand(brand);
  let def: FormPage;
  try {
    def = await apiGet<FormPage>(`/v1/public/forms/${form}`, { revalidate: 30 });
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
  // A form only appears on its own business's site, and only when its landing page is switched on.
  if (def.brand.slug !== data.brand.slug || !def.settings.landing.enabled) notFound();
  return { data, def, brand };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { data, def, brand } = await load(props);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  return { title: `${def.settings.landing.heading || def.name} · ${data.brand.name}`, description: def.settings.landing.intro.slice(0, 160) || undefined, alternates: { canonical: links.brandCanonical(`/f/${def.id}`) } };
}

/** Standalone landing page for a form (Marketing workspace → forms & landing pages). */
export default async function FormLanding(props: Props) {
  const { data, def, brand } = await load(props);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.primaryHost });
  const l = def.settings.landing;
  return (
    <main id="main">
      <section className="bhs-section bhs-bg-muted bhs-pad-normal bhs-align-start">
        <div className="bhs-inner">
          <div className={l.image ? 'bhs-split' : 'bhs-narrow'}>
            <div>
              <h1 className="bhs-h1">{l.heading || def.name}</h1>
              {l.intro && <div className="bhs-lead">{l.intro.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>}
              <SiteForm def={def} pageUrl={links.brandCanonical(`/f/${def.id}`)} />
            </div>
            {l.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={l.image} alt="" className="bhs-media" />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
