'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorSummary } from '@/components/forms';
import { call } from '@/lib/client';

export interface ReviewLink { kind: string; label: string; url: string }
export interface ReviewPageData {
  location: { name: string; slug: string };
  business: { name: string; slug: string };
  firstName: string | null;
  submitted: { rating: number; comment: string | null } | null;
  links: ReviewLink[];
}

const LINK_NAMES: Record<string, string> = { google: 'Google', facebook: 'Facebook', tripadvisor: 'Tripadvisor', yelp: 'Yelp', trustpilot: 'Trustpilot' };

/**
 * Rate 1–5 and comment (private feedback to the location's team), then the public review links.
 *
 * NO REVIEW GATING: the public links below are rendered for every customer — before rating, and after rating
 * whatever the rating is. Never branch on `rating` to hide or reorder them: showing public review options only to
 * satisfied customers violates Google's review policy (and the FTC rule on consumer reviews).
 */
export function ReviewForm({ brand, location, token, data }: { brand: string; location: string; token: string; data: ReviewPageData }) {
  const t = useTranslations('reviewPage');
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<boolean>(!!data.submitted);
  const [optedOut, setOptedOut] = useState(false);
  const links = data.links;
  const base = `/public/reviews/${encodeURIComponent(brand)}/${encodeURIComponent(location)}`;

  const submit = async () => {
    if (!rating) { setErr(t('chooseRating')); return; }
    setBusy(true);
    setErr(null);
    const r = await call<{ links: ReviewLink[] }>('POST', base, { t: token, rating, comment: comment.trim() || null });
    setBusy(false);
    if (!r.ok && r.error.code !== 'already_reviewed') { setErr(r.error.message); return; }
    setDone(true);
  };
  const opened = (kind: string) => void call('POST', `${base}/link`, { t: token, kind });

  const publicLinks = links.length > 0 && (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="public-links">
      {links.map((l) => (
        <li key={`${l.kind}:${l.url}`}>
          <a href={l.url} target="_blank" rel="noopener noreferrer" onClick={() => opened(l.kind)} className="btn btn-secondary w-full justify-center">
            {l.label || t('reviewOn', { site: LINK_NAMES[l.kind] ?? t('otherSite') })}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-8 sm:py-12">
      <p className="text-sm font-semibold text-graphite">{data.business.name}</p>
      <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">{done ? t('thanksTitle') : t('title', { location: data.location.name })}</h1>
      {!done ? (
        <section className="card mt-5 p-5 sm:p-6" aria-labelledby="rate-h">
          <h2 id="rate-h" className="text-lg font-bold">{data.firstName ? t('askNamed', { name: data.firstName }) : t('ask')}</h2>
          <div role="radiogroup" aria-label={t('ratingLabel')} className="mt-4 flex justify-between gap-1 sm:justify-start sm:gap-2" onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={t('starLabel', { n })}
                onClick={() => setRating(n)}
                onMouseEnter={() => setHover(n)}
                className="grid size-12 place-items-center rounded-full focus-visible:outline-2 sm:size-14"
              >
                <svg viewBox="0 0 24 24" className={`size-10 sm:size-11 ${(hover || rating) >= n ? 'text-ink' : 'text-line'}`} aria-hidden>
                  <path fill="currentColor" d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
                </svg>
              </button>
            ))}
          </div>
          <p className="mt-1 min-h-5 text-sm text-graphite" aria-live="polite">{rating ? t(`scale.${rating}`) : ''}</p>
          <label className="mt-4 block text-sm font-semibold" htmlFor="review-comment">{t('commentLabel')}</label>
          <textarea id="review-comment" className="field mt-1 min-h-28 w-full" maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <p className="mt-1 text-xs text-graphite">{t('privateNote', { location: data.location.name })}</p>
          <div className="mt-4"><ErrorSummary message={err} /></div>
          <button type="button" className="btn btn-primary mt-2 w-full sm:w-auto" disabled={busy} onClick={() => void submit()} data-testid="submit-review">{t('send')}</button>
        </section>
      ) : (
        <section className="card mt-5 p-5 sm:p-6" role="status">
          <p className="font-semibold">{t('thanksBody', { location: data.location.name })}</p>
        </section>
      )}
      {links.length > 0 && (
        <section className="mt-6" aria-labelledby="public-h">
          <h2 id="public-h" className="text-lg font-bold">{done ? t('publicAfter') : t('publicBefore')}</h2>
          <p className="mt-1 text-sm text-graphite">{t('publicBody')}</p>
          {publicLinks}
        </section>
      )}
      <div className="mt-10 border-t border-line pt-4 text-sm text-graphite">
        {optedOut ? <p role="status">{t('optedOut')}</p> : (
          <button type="button" className="underline" onClick={async () => { const r = await call('POST', `${base}/opt-out`, { t: token }); if (r.ok) setOptedOut(true); }}>{t('optOut')}</button>
        )}
      </div>
    </main>
  );
}
