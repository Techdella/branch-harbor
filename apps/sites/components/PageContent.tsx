import type { PublishedPage } from '@/lib/types';

/**
 * Renders published page fields as text. Rich text is shown as plain paragraphs (no raw HTML injection);
 * image/url fields render only when they are https URLs.
 */
export function PageContent({ page, skip = [] }: { page: PublishedPage; skip?: string[] }) {
  const entries = Object.entries(page.content).filter(([k]) => !skip.includes(k));
  return (
    <div className="space-y-5">
      {entries.map(([key, value]) => {
        if (typeof value !== 'string' || !value.trim()) return null;
        if (/^https:\/\/\S+\.(png|jpe?g|webp|avif|gif)(\?\S*)?$/i.test(value)) {
          // eslint-disable-next-line @next/next/no-img-element
          return <img key={key} src={value} alt="" className="w-full rounded-2xl object-cover" />;
        }
        if (/^https:\/\/\S+$/.test(value)) return <p key={key}><a href={value} className="link" rel="noopener">{value}</a></p>;
        return <p key={key} className="whitespace-pre-line text-lg leading-relaxed">{value}</p>;
      })}
    </div>
  );
}
