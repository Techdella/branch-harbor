/**
 * Renders a website page document with a resolved theme. Shared by apps/sites (public pages, server components)
 * and the dashboard website builder (WYSIWYG preview inside Puck). Content strings come from the document; the few
 * built-in strings (opening hours, empty states…) come from `labels` so each host translates them. No hooks, so
 * it runs as a server component.
 */
import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import { resolvedStyle, themeCss, type PageDocument, type ResolvedTheme, type Section, type SiteFont } from '@bh/shared';

export interface SiteLabels {
  hours: string;
  contact: string;
  closed: string;
  directions: string;
  call: string;
  email: string;
  map: string;
  /** Industry block placeholder in the builder (live data appears on the published site). */
  livePreview: string;
  empty: Record<'class_schedule' | 'programmes' | 'services' | 'product_grid' | 'menu' | 'listings' | 'rooms', string>;
  order: string;
  viewAll: string;
  formUnavailable: string;
  highlighted: string;
}

export interface LiveItem { id: string; title: string; subtitle?: string | null; meta?: string | null; price?: string | null; image?: string | null; href?: string | null; badge?: string | null }

export interface SiteLocationInfo {
  name: string;
  addressLines: string[];
  phone: string | null;
  email: string | null;
  geo: { lat: number; lng: number } | null;
  hours: { summary: string | null; weekly: Array<{ day: number; opens: string; closes: string }> | null };
  directionsUrl: string;
}

export interface SiteContext {
  brandName: string;
  locale: string;
  location?: SiteLocationInfo | null;
  /** Link to the location's main module page (book / order / shop). */
  moduleHref?: string | null;
}

export interface SiteRenderProps {
  document: PageDocument;
  theme: ResolvedTheme;
  ctx: SiteContext;
  labels: SiteLabels;
  /** Live data for industry blocks keyed by section id. `null` = not available here (renders the empty state). */
  live?: Record<string, LiveItem[] | null>;
  /** Host slot for form sections (interactive on sites, a disabled preview in the builder). */
  renderForm?: (a: { sectionId: string; formId: string }) => ReactNode;
  renderNewsletter?: (a: { sectionId: string; buttonLabel: string }) => ReactNode;
  /** Builder preview: industry blocks show a placeholder instead of live data. */
  preview?: boolean;
  /** Maps a font key to a self-hosted CSS variable (apps/sites next/font). */
  fontVar?: (f: SiteFont) => string | null;
  scheme?: 'light' | 'dark';
}

type Txt = ReactNode;
const isNode = (v: unknown): v is ReactNode => isValidElement(v);
/** Text props are strings on sites; inside the builder inline-editable props arrive as elements. */
export const txt = (v: unknown): Txt => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : isNode(v) ? v : '');
const has = (v: unknown) => (typeof v === 'string' ? v.trim().length > 0 : isNode(v));
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function Paras({ v, className }: { v: unknown; className?: string }) {
  if (isNode(v)) return <div className={className}>{v}</div>;
  const text = s(v).trim();
  if (!text) return null;
  return <div className={className}>{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>;
}

function Heading({ v, level = 2, className }: { v: unknown; level?: 1 | 2 | 3; className?: string }) {
  if (!has(v)) return null;
  const H = `h${level}` as 'h1';
  return <H className={className ?? 'bhs-h2'}>{txt(v)}</H>;
}

function Btn({ label, href, kind = 'primary' }: { label: unknown; href: unknown; kind?: 'primary' | 'secondary' }) {
  if (!has(label)) return null;
  const h = s(href) || '#';
  return <a className={`bhs-btn bhs-btn-${kind}`} href={h} {...(/^https:/.test(h) ? { rel: 'noopener' } : {})}>{txt(label)}</a>;
}

function Img({ src, alt, className, focal }: { src: unknown; alt: unknown; className?: string; focal?: { x: number; y: number } }) {
  const url = s(src);
  if (!url) return <div className={`bhs-img-ph ${className ?? ''}`} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={s(alt)} loading="lazy" decoding="async" className={className} style={focal ? { objectPosition: `${focal.x}% ${focal.y}%` } : undefined} />;
}

function videoEmbed(url: string): { kind: 'file' | 'iframe'; src: string } | null {
  if (!url) return null;
  const yt = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,20})/.exec(url);
  if (yt) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&mute=1&loop=1&playlist=${yt[1]}&controls=0&playsinline=1` };
  const vm = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})/.exec(url);
  if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm[1]}?background=1&dnt=1` };
  if (/^https:\/\/\S+\.(mp4|webm)(\?\S*)?$/i.test(url)) return { kind: 'file', src: url };
  return null;
}

function LivePlaceholder({ label, count = 3 }: { label: string; count?: number }) {
  return (
    <div>
      <p className="bhs-note">{label}</p>
      <div className="bhs-grid bhs-cols-3" aria-hidden>
        {Array.from({ length: count }, (_, i) => <div key={i} className="bhs-card bhs-ph-card"><div className="bhs-ph-line" /><div className="bhs-ph-line bhs-ph-short" /></div>)}
      </div>
    </div>
  );
}

function LiveList({ items, empty, cols = 3 }: { items: LiveItem[] | null | undefined; empty: string; cols?: number }) {
  if (!items || !items.length) return <p className="bhs-empty">{empty}</p>;
  return (
    <ul className={`bhs-grid bhs-cols-${cols}`} role="list">
      {items.map((it) => (
        <li key={it.id} className="bhs-card bhs-live">
          {it.image && <Img src={it.image} alt="" className="bhs-live-img" />}
          <div className="bhs-live-body">
            {it.badge && <span className="bhs-badge">{it.badge}</span>}
            {it.meta && <p className="bhs-meta">{it.meta}</p>}
            <h3 className="bhs-h3">{it.href ? <a href={it.href}>{it.title}</a> : it.title}</h3>
            {it.subtitle && <p className="bhs-subtle">{it.subtitle}</p>}
            {it.price && <p className="bhs-price">{it.price}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const DAY_INDEX = [1, 2, 3, 4, 5, 6, 0];
function dayName(locale: string, day: number) {
  // 2023-01-01 was a Sunday.
  try { return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + day))); } catch { return String(day); }
}

function HoursTable({ loc, locale, closed }: { loc: SiteLocationInfo; locale: string; closed: string }) {
  if (!loc.hours.weekly) return loc.hours.summary ? <p>{loc.hours.summary}</p> : null;
  return (
    <dl className="bhs-hours">
      {DAY_INDEX.map((d) => {
        const slots = loc.hours.weekly!.filter((w) => w.day === d);
        return (
          <div key={d} className="bhs-hours-row">
            <dt>{dayName(locale, d)}</dt>
            <dd>{slots.length ? slots.map((w) => `${w.opens}–${w.closes}`).join(', ') : closed}</dd>
          </div>
        );
      })}
    </dl>
  );
}

const SOCIAL_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', x: 'X', pinterest: 'Pinterest', whatsapp: 'WhatsApp' };

export interface SectionViewProps extends Omit<SiteRenderProps, 'document' | 'theme'> {
  section: Pick<Section, 'id' | 'type' | 'props' | 'style'>;
  /** First hero on the page renders an h1. */
  first?: boolean;
}

/** One section. Exported for the builder, which renders sections individually. */
export function SectionView({ section, ctx, labels, live, renderForm, renderNewsletter, preview, first }: SectionViewProps) {
  const p = section.props;
  const st = resolvedStyle(section);
  const focal = { x: st.focalX, y: st.focalY };
  const cls = `bhs-section bhs-${section.type} bhs-bg-${st.background} bhs-pad-${st.spacing} bhs-align-${st.align}`;
  const wrap = (children: ReactNode, extra = '') => <section id={`s-${section.id}`} className={`${cls} ${extra}`} data-section={section.type}><div className="bhs-inner">{children}</div></section>;
  const loc = ctx.location ?? null;
  const liveItems = live?.[section.id];

  switch (section.type) {
    case 'hero':
    case 'hero_split': {
      const imageStart = section.type === 'hero_split' && p.imageSide === 'start';
      return (
        <section id={`s-${section.id}`} className={`${cls} bhs-hero${section.type === 'hero_split' ? ' bhs-hero-split' : ''}${imageStart ? ' bhs-image-start' : ''}`} data-section={section.type}>
          <div className="bhs-inner bhs-hero-grid">
            <div className="bhs-hero-copy">
              {has(p.eyebrow) && <p className="bhs-eyebrow">{txt(p.eyebrow)}</p>}
              <Heading v={p.heading} level={first ? 1 : 2} className="bhs-h1" />
              <Paras v={p.body} className="bhs-lead" />
              <div className="bhs-actions"><Btn label={p.ctaLabel} href={p.ctaHref} /><Btn label={p.secondaryLabel} href={p.secondaryHref} kind="secondary" /></div>
            </div>
            <div className="bhs-hero-media"><Img src={p.image} alt={p.imageAlt} className="bhs-hero-img" focal={focal} /></div>
          </div>
        </section>
      );
    }
    case 'hero_video': {
      const v = videoEmbed(s(p.videoUrl));
      return (
        <section id={`s-${section.id}`} className={`${cls} bhs-hero bhs-hero-video`} data-section={section.type}>
          <div className="bhs-video-bg" aria-hidden>
            {v?.kind === 'file' ? <video src={v.src} poster={s(p.image) || undefined} autoPlay muted loop playsInline preload="metadata" /> : v?.kind === 'iframe' ? <iframe src={v.src} title="" tabIndex={-1} allow="autoplay; fullscreen" loading="lazy" /> : <Img src={p.image} alt="" focal={focal} />}
          </div>
          <div className="bhs-inner bhs-video-copy">
            <Heading v={p.heading} level={first ? 1 : 2} className="bhs-h1" />
            <Paras v={p.body} className="bhs-lead" />
            <div className="bhs-actions"><Btn label={p.ctaLabel} href={p.ctaHref} /></div>
          </div>
        </section>
      );
    }
    case 'text':
      return wrap(<div className="bhs-prose"><Heading v={p.heading} /><Paras v={p.body} /></div>);
    case 'image_text':
      return wrap(
        <div className={`bhs-split${p.imageSide === 'end' ? ' bhs-image-end' : ''}`}>
          <Img src={p.image} alt={p.imageAlt} className="bhs-media" focal={focal} />
          <div><Heading v={p.heading} /><Paras v={p.body} /><div className="bhs-actions"><Btn label={p.ctaLabel} href={p.ctaHref} /></div></div>
        </div>,
      );
    case 'gallery':
      return wrap(<><Heading v={p.heading} /><ul className={`bhs-grid bhs-cols-${s(p.columns) || '3'} bhs-gallery`} role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => <li key={i}><figure><Img src={it.image} alt={it.alt} className="bhs-media" />{has(it.caption) && <figcaption className="bhs-meta">{txt(it.caption)}</figcaption>}</figure></li>)}</ul></>);
    case 'logos':
      return wrap(<><Heading v={p.heading} className="bhs-h3 bhs-center" /><ul className="bhs-logos" role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => <li key={i}>{s(it.href) ? <a href={s(it.href)} rel="noopener"><Img src={it.image} alt={it.alt} /></a> : <Img src={it.image} alt={it.alt} />}</li>)}</ul></>);
    case 'features':
      return wrap(<><div className="bhs-head"><Heading v={p.heading} /><Paras v={p.intro} className="bhs-lead" /></div><ul className={`bhs-grid bhs-cols-${s(p.columns) || '3'}`} role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => <li key={i} className="bhs-card"><span className={`bhs-icon bhs-icon-${s(it.icon) || 'check'}`} aria-hidden /><h3 className="bhs-h3">{txt(it.title)}</h3><Paras v={it.body} className="bhs-subtle" /></li>)}</ul></>);
    case 'testimonials':
      return wrap(<><Heading v={p.heading} /><ul className="bhs-grid bhs-cols-3" role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => <li key={i} className="bhs-card bhs-quote"><blockquote><Paras v={it.quote} /></blockquote><p className="bhs-cite"><strong>{txt(it.author)}</strong>{has(it.role) && <span className="bhs-subtle"> · {txt(it.role)}</span>}</p></li>)}</ul></>);
    case 'faq':
      return wrap(<div className="bhs-narrow"><Heading v={p.heading} /><div className="bhs-faq">{arr<Record<string, unknown>>(p.items).map((it, i) => <details key={i}><summary>{txt(it.question)}</summary><Paras v={it.answer} /></details>)}</div></div>);
    case 'cta':
      return wrap(<div className="bhs-cta-box"><Heading v={p.heading} /><Paras v={p.body} className="bhs-lead" /><div className="bhs-actions"><Btn label={p.ctaLabel} href={p.ctaHref} /><Btn label={p.secondaryLabel} href={p.secondaryHref} kind="secondary" /></div></div>);
    case 'contact_map': {
      if (!loc) return preview ? wrap(<><Heading v={p.heading} /><p className="bhs-empty">{labels.livePreview}</p></>) : null;
      const map = p.showMap !== false && loc.geo ? `https://www.openstreetmap.org/export/embed.html?bbox=${loc.geo.lng - 0.006}%2C${loc.geo.lat - 0.004}%2C${loc.geo.lng + 0.006}%2C${loc.geo.lat + 0.004}&layer=mapnik&marker=${loc.geo.lat}%2C${loc.geo.lng}` : null;
      return wrap(
        <div className={map ? 'bhs-split' : ''}>
          <div>
            <Heading v={has(p.heading) ? p.heading : labels.contact} />
            <address className="bhs-address"><strong>{loc.name}</strong>{loc.addressLines.map((l, i) => <span key={i}><bdi>{l}</bdi></span>)}</address>
            <Paras v={p.note} className="bhs-subtle" />
            <div className="bhs-actions">
              <a className="bhs-btn bhs-btn-primary" href={loc.directionsUrl} rel="noopener">{labels.directions}</a>
              {p.showPhone !== false && loc.phone && <a className="bhs-btn bhs-btn-secondary" href={`tel:${loc.phone.replace(/\s+/g, '')}`}>{labels.call}</a>}
              {p.showEmail !== false && loc.email && <a className="bhs-btn bhs-btn-secondary" href={`mailto:${loc.email}`}>{labels.email}</a>}
            </div>
          </div>
          {map && <iframe className="bhs-map" src={map} title={labels.map} loading="lazy" referrerPolicy="no-referrer" />}
        </div>,
      );
    }
    case 'hours':
      if (!loc && !preview) return null;
      return wrap(<div className="bhs-narrow"><Heading v={has(p.heading) ? p.heading : labels.hours} />{loc ? <HoursTable loc={loc} locale={ctx.locale} closed={labels.closed} /> : <p className="bhs-empty">{labels.livePreview}</p>}<Paras v={p.note} className="bhs-subtle" /></div>);
    case 'team':
      return wrap(<><div className="bhs-head"><Heading v={p.heading} /><Paras v={p.intro} className="bhs-lead" /></div><ul className="bhs-grid bhs-cols-4" role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => <li key={i} className="bhs-person"><Img src={it.image} alt={it.alt} className="bhs-avatar" /><h3 className="bhs-h3">{txt(it.name)}</h3>{has(it.role) && <p className="bhs-meta">{txt(it.role)}</p>}<Paras v={it.bio} className="bhs-subtle" /></li>)}</ul></>);
    case 'pricing':
      return wrap(<><div className="bhs-head"><Heading v={p.heading} /><Paras v={p.intro} className="bhs-lead" /></div><ul className="bhs-grid bhs-cols-3" role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => (
        <li key={i} className={`bhs-card bhs-plan${it.highlighted === true ? ' bhs-plan-hi' : ''}`}>
          {it.highlighted === true && <span className="bhs-badge">{labels.highlighted}</span>}
          <h3 className="bhs-h3">{txt(it.name)}</h3>
          {has(it.price) && <p className="bhs-plan-price">{txt(it.price)}{has(it.period) && <span className="bhs-subtle"> / {txt(it.period)}</span>}</p>}
          {s(it.features) && <ul className="bhs-ticks">{s(it.features).split('\n').filter((x) => x.trim()).map((f, j) => <li key={j}>{f}</li>)}</ul>}
          <Btn label={it.ctaLabel} href={it.ctaHref} kind={it.highlighted === true ? 'primary' : 'secondary'} />
        </li>
      ))}</ul></>);
    case 'blog_list':
      return wrap(<><Heading v={p.heading} /><ul className="bhs-grid bhs-cols-3" role="list">{arr<Record<string, unknown>>(p.items).map((it, i) => <li key={i} className="bhs-card bhs-post">{s(it.image) && <Img src={it.image} alt="" className="bhs-media" />}{has(it.date) && <p className="bhs-meta">{txt(it.date)}</p>}<h3 className="bhs-h3">{s(it.href) ? <a href={s(it.href)}>{txt(it.title)}</a> : txt(it.title)}</h3><Paras v={it.excerpt} className="bhs-subtle" /></li>)}</ul></>);
    case 'form':
      return wrap(<div className="bhs-narrow"><Heading v={p.heading} /><Paras v={p.intro} className="bhs-lead" />{s(p.formId) && renderForm ? renderForm({ sectionId: section.id, formId: s(p.formId) }) : <p className="bhs-empty">{labels.formUnavailable}</p>}</div>);
    case 'newsletter':
      return wrap(<div className="bhs-cta-box bhs-newsletter"><Heading v={p.heading} /><Paras v={p.body} className="bhs-lead" />{renderNewsletter?.({ sectionId: section.id, buttonLabel: s(p.buttonLabel) })}</div>);
    case 'footer': {
      const variant = s(p.variant) || 'columns';
      return (
        <footer id={`s-${section.id}`} className={`${cls} bhs-footer bhs-footer-${variant}`} data-section="footer">
          <div className="bhs-inner bhs-footer-grid">
            <div><p className="bhs-footer-brand">{ctx.brandName}</p><Paras v={p.text} className="bhs-subtle" /></div>
            {p.showAddress !== false && loc && <address className="bhs-address"><strong>{loc.name}</strong>{loc.addressLines.map((l, i) => <span key={i}><bdi>{l}</bdi></span>)}{loc.phone && <a href={`tel:${loc.phone.replace(/\s+/g, '')}`}>{loc.phone}</a>}</address>}
            {p.showHours !== false && loc?.hours.weekly && <div><p className="bhs-footer-title">{labels.hours}</p><HoursTable loc={loc} locale={ctx.locale} closed={labels.closed} /></div>}
            {(arr(p.links).length > 0 || arr(p.socials).length > 0) && (
              <nav aria-label={ctx.brandName}>
                <ul className="bhs-footer-links" role="list">{arr<Record<string, unknown>>(p.links).map((l, i) => <li key={i}><a href={s(l.href) || '#'}>{txt(l.label)}</a></li>)}</ul>
                <ul className="bhs-socials" role="list">{arr<Record<string, unknown>>(p.socials).map((l, i) => <li key={i}><a href={s(l.href) || '#'} rel="noopener me" aria-label={SOCIAL_NAMES[s(l.network)] ?? s(l.network)}>{SOCIAL_NAMES[s(l.network)] ?? s(l.network)}</a></li>)}</ul>
              </nav>
            )}
          </div>
        </footer>
      );
    }
    case 'class_schedule': case 'programmes': case 'services': case 'product_grid': case 'menu': case 'listings': case 'rooms': {
      const type = section.type;
      // Brand-level pages have no single location: live blocks only make sense on location sites.
      if (!loc && !preview) return null;
      const body = preview ? <LivePlaceholder label={labels.livePreview} /> : <LiveList items={liveItems} empty={labels.empty[type]} cols={type === 'menu' ? 2 : 3} />;
      return wrap(
        <>
          <div className="bhs-head bhs-head-row"><Heading v={p.heading} />{ctx.moduleHref && !preview && (type !== 'menu' || p.showOrderButton !== false) && <a className="bhs-btn bhs-btn-secondary" href={ctx.moduleHref}>{type === 'menu' ? labels.order : labels.viewAll}</a>}</div>
          {body}
        </>,
      );
    }
    default:
      return null;
  }
}

/** Full page: theme CSS scoped to the root, then every visible section. */
export function SiteDocument(props: SiteRenderProps) {
  const { document, theme, scheme } = props;
  const visible = document.sections.filter((x) => !x.hidden);
  const firstHero = visible.findIndex((x) => x.type.startsWith('hero'));
  return (
    <div className="bhs-root" data-theme-id={theme.id} data-hero={theme.layout.hero} data-cards={theme.layout.cards} data-divider={theme.layout.divider} data-deco={theme.decoration} data-scheme={scheme} style={{} as CSSProperties}>
      <style dangerouslySetInnerHTML={{ __html: themeCss(theme, '.bhs-root', props.fontVar) }} />
      {visible.map((section, i) => <SectionView key={section.id} {...props} section={section} first={i === firstHero} />)}
    </div>
  );
}

/** Theme root without content (the builder renders sections itself inside it). */
export function SiteThemeRoot({ theme, children, fontVar, scheme }: { theme: ResolvedTheme; children: ReactNode; fontVar?: (f: SiteFont) => string | null; scheme?: 'light' | 'dark' }) {
  return (
    <div className="bhs-root" data-theme-id={theme.id} data-hero={theme.layout.hero} data-cards={theme.layout.cards} data-divider={theme.layout.divider} data-deco={theme.decoration} data-scheme={scheme}>
      <style dangerouslySetInnerHTML={{ __html: themeCss(theme, '.bhs-root', fontVar) }} />
      {children}
    </div>
  );
}

export interface SiteHeaderProps {
  theme: ResolvedTheme;
  brandName: string;
  logoUrl: string | null;
  homeHref: string;
  links: Array<{ label: string; href: string; current?: boolean }>;
  extra?: ReactNode;
  navLabel: string;
}

/** Site header in the theme's header style (bar, centered, boxed, minimal). */
export function SiteHeader({ theme, brandName, logoUrl, homeHref, links, extra, navLabel }: SiteHeaderProps) {
  return (
    <header className="bhs-header" data-header={theme.layout.header}>
      <div className="bhs-header-inner">
        <a href={homeHref} className="bhs-logo">
          {logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logoUrl} alt={brandName} />
            : <><span className="bhs-logo-mark" aria-hidden>{brandName.slice(0, 1)}</span><span className="bhs-logo-name" dir="auto">{brandName}</span></>}
        </a>
        <nav aria-label={navLabel} className="bhs-nav">
          <ul role="list">{links.map((l) => <li key={l.href}><a href={l.href} aria-current={l.current ? 'page' : undefined}>{l.label}</a></li>)}</ul>
        </nav>
        {extra && <div className="bhs-header-extra">{extra}</div>}
      </div>
    </header>
  );
}
