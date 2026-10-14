import type { LocationSummary } from '@/lib/types';

/**
 * Static, dependency-free location map: pins placed by latitude/longitude on a fitted equirectangular
 * grid. Clearly labelled as schematic; each list entry links to real directions.
 */
export function SchematicMap({ items, label, note, hrefFor }: { items: LocationSummary[]; label: string; note: string; hrefFor: (slug: string) => string }) {
  const pts = items.filter((l) => l.geo);
  const W = 600, H = 380, pad = 48;
  let minLat = Math.min(...pts.map((p) => p.geo!.lat)), maxLat = Math.max(...pts.map((p) => p.geo!.lat));
  let minLng = Math.min(...pts.map((p) => p.geo!.lng)), maxLng = Math.max(...pts.map((p) => p.geo!.lng));
  if (!pts.length) { minLat = -60; maxLat = 70; minLng = -170; maxLng = 170; }
  if (maxLat - minLat < 0.5) { minLat -= 0.25; maxLat += 0.25; }
  if (maxLng - minLng < 0.5) { minLng -= 0.25; maxLng += 0.25; }
  const x = (lng: number) => pad + ((lng - minLng) / (maxLng - minLng)) * (W - 2 * pad);
  const y = (lat: number) => H - pad - ((lat - minLat) / (maxLat - minLat)) * (H - 2 * pad);
  return (
    <figure className="card relative overflow-hidden bg-[#EEF1EC]">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block h-auto w-full">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="#D5DCD3" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {pts.map((p) => (
          <a key={p.id} href={hrefFor(p.slug)} aria-label={p.name}>
            <g transform={`translate(${x(p.geo!.lng)},${y(p.geo!.lat)})`}>
              <path d="M0 0c-9-11-14-18-14-25a14 14 0 0 1 28 0c0 7-5 14-14 25z" fill="var(--site-brand)" stroke="#fff" strokeWidth="2" />
              <circle cy="-25" r="5" fill="var(--site-on-brand)" />
              <text y="18" textAnchor="middle" fontSize="13" fontWeight="700" fill="#141414" stroke="#EEF1EC" strokeWidth="4" paintOrder="stroke">{p.name}</text>
            </g>
          </a>
        ))}
      </svg>
      <figcaption className="absolute bottom-2 end-3 rounded-full bg-white/90 px-2 py-0.5 text-xs font-semibold text-stone">{note}</figcaption>
    </figure>
  );
}
