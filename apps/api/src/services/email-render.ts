/**
 * Email builder renderer: email document → MJML → email-safe HTML, plus a plain-text part. Brand-aware (theme
 * palette and fonts), personalised with tokens (escaped), and always carrying the legally required footer: the
 * sender's postal address and a one-click unsubscribe link. Optional privacy-friendly tracking (off by default):
 * an open pixel and click redirects, only when the business turned them on.
 */
import mjml2html from 'mjml';
import { SITE_FONT_FAMILIES, personalise, type EmailDocument, type EmailToken, type Palette, type SiteFont } from '@bh/shared';

export interface EmailBrand { name: string; logoUrl: string | null; palette: Palette; fonts: { heading: SiteFont; body: SiteFont } }

export interface RenderEmailInput {
  document: EmailDocument;
  subject: string;
  preheader?: string;
  brand: EmailBrand;
  values: Partial<Record<EmailToken, string | null>>;
  postalAddress: string;
  unsubscribeUrl: string;
  locale?: string;
  /** Click tracking: returns the redirect URL for link `index` (only when enabled). */
  trackLink?: (href: string, index: number) => string;
  openPixelUrl?: string | null;
}

export interface RenderedEmail { subject: string; html: string; text: string; links: string[]; warnings: string[] }

const FOOTER_COPY: Record<string, { unsubscribe: string; why: string }> = {
  en: { unsubscribe: 'Unsubscribe', why: 'You are receiving this email because you agreed to hear from {business}.' },
  fr: { unsubscribe: 'Se désabonner', why: 'Vous recevez cet e-mail car vous avez accepté d’avoir des nouvelles de {business}.' },
  es: { unsubscribe: 'Darse de baja', why: 'Recibes este correo porque aceptaste recibir noticias de {business}.' },
  de: { unsubscribe: 'Abmelden', why: 'Sie erhalten diese E-Mail, weil Sie Nachrichten von {business} zugestimmt haben.' },
  pt: { unsubscribe: 'Cancelar inscrição', why: 'Você recebe este e-mail porque aceitou receber novidades de {business}.' },
  nl: { unsubscribe: 'Afmelden', why: 'Je ontvangt deze e-mail omdat je hebt ingestemd met berichten van {business}.' },
  it: { unsubscribe: 'Annulla iscrizione', why: 'Ricevi questa email perché hai accettato di ricevere notizie da {business}.' },
  ar: { unsubscribe: 'إلغاء الاشتراك', why: 'تتلقى هذا البريد لأنك وافقت على تلقي رسائل من {business}.' },
};

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const attr = esc;
const font = (f: SiteFont) => (f === 'system' ? 'Helvetica, Arial, sans-serif' : `'${SITE_FONT_FAMILIES[f].family}', ${SITE_FONT_FAMILIES[f].kind === 'serif' ? 'Georgia, serif' : 'Helvetica, Arial, sans-serif'}`);
const radius = (shape: EmailDocument['style']['buttonShape']) => (shape === 'pill' ? '999px' : shape === 'rounded' ? '8px' : '0px');

export async function renderEmail(input: RenderEmailInput): Promise<RenderedEmail> {
  const { document: doc, brand, values } = input;
  const p = brand.palette;
  const copy = FOOTER_COPY[(input.locale ?? 'en').split('-')[0]!] ?? FOOTER_COPY.en!;
  const warnings: string[] = [];
  const links: string[] = [];
  const html = (t: string) => esc(personalise(t, values)).replace(/\n/g, '<br/>');
  const plain = (t: string) => personalise(t, values);
  const link = (href: string) => {
    if (!href) return '';
    links.push(href);
    return input.trackLink ? input.trackLink(href, links.length - 1) : href;
  };
  const textParts: string[] = [];
  const parts: string[] = [];
  const hasFooter = doc.blocks.some((b) => b.type === 'footer');
  const blocks = hasFooter ? doc.blocks : [...doc.blocks, { id: 'auto-footer', type: 'footer' as const, text: '', address: '' }];

  for (const b of blocks) {
    switch (b.type) {
      case 'header': {
        const logo = b.showLogo && brand.logoUrl ? `<mj-image src="${attr(brand.logoUrl)}" alt="${attr(brand.name)}" width="140px" align="center" padding="8px 0" />` : `<mj-text align="center" font-size="22px" font-weight="700" font-family="${attr(font(brand.fonts.heading))}">${esc(brand.name)}</mj-text>`;
        parts.push(`<mj-section padding="24px 0 8px">${`<mj-column>${logo}${b.title ? `<mj-text align="center" color="${p.subtle}">${html(b.title)}</mj-text>` : ''}</mj-column>`}</mj-section>`);
        textParts.push(brand.name, b.title ? plain(b.title) : '');
        break;
      }
      case 'text': {
        if (!b.text.trim()) break;
        const size = b.size === 'heading' ? 'font-size="26px" line-height="1.2" font-weight="700"' : b.size === 'small' ? 'font-size="13px"' : '';
        const family = b.size === 'heading' ? `font-family="${attr(font(brand.fonts.heading))}"` : '';
        parts.push(`<mj-section padding="0"><mj-column><mj-text align="${b.align}" ${size} ${family}>${html(b.text)}</mj-text></mj-column></mj-section>`);
        textParts.push(plain(b.text));
        break;
      }
      case 'image': {
        if (!b.src) { warnings.push('image_missing'); break; }
        if (!b.alt) warnings.push('image_alt_missing');
        parts.push(`<mj-section padding="0"><mj-column><mj-image src="${attr(b.src)}" alt="${attr(b.alt)}" width="${b.width}px"${b.href ? ` href="${attr(link(b.href))}"` : ''} border-radius="8px" /></mj-column></mj-section>`);
        if (b.alt) textParts.push(`[${b.alt}]`);
        break;
      }
      case 'button': {
        if (!b.label || !b.href) { warnings.push('button_incomplete'); break; }
        parts.push(`<mj-section padding="8px 0"><mj-column><mj-button href="${attr(link(b.href))}" align="${b.align}">${esc(personalise(b.label, values))}</mj-button></mj-column></mj-section>`);
        textParts.push(`${plain(b.label)}: ${b.href}`);
        break;
      }
      case 'columns': {
        const col = (c: typeof b.left) => `<mj-column>${c.image ? `<mj-image src="${attr(c.image)}" alt="${attr(c.imageAlt)}" border-radius="8px" />` : ''}${c.text ? `<mj-text>${html(c.text)}</mj-text>` : ''}</mj-column>`;
        parts.push(`<mj-section padding="0">${col(b.left)}${col(b.right)}</mj-section>`);
        textParts.push(plain(b.left.text), plain(b.right.text));
        break;
      }
      case 'divider':
        parts.push(`<mj-section padding="0"><mj-column><mj-divider border-color="${p.border}" border-width="1px" /></mj-column></mj-section>`);
        textParts.push('—');
        break;
      case 'spacer':
        parts.push(`<mj-section padding="0"><mj-column><mj-spacer height="${b.height}px" /></mj-column></mj-section>`);
        break;
      case 'social': {
        const valid = b.links.filter((l) => l.href);
        if (!valid.length) break;
        parts.push(`<mj-section padding="0"><mj-column><mj-text align="center">${valid.map((l) => `<a href="${attr(link(l.href))}" style="color:${p.link};font-weight:700;text-decoration:underline;margin:0 8px">${esc(l.network)}</a>`).join(' ')}</mj-text></mj-column></mj-section>`);
        textParts.push(valid.map((l) => `${l.network}: ${l.href}`).join('\n'));
        break;
      }
      case 'footer': {
        const address = (b.address || input.postalAddress).trim();
        if (!address) warnings.push('postal_address_missing');
        const why = copy.why.replace('{business}', brand.name);
        // The unsubscribe link is never tracked or rewritten.
        parts.push(`<mj-section padding="24px 0"><mj-column><mj-divider border-color="${p.border}" border-width="1px" /><mj-text align="center" font-size="12px" color="${p.subtle}">${b.text ? `${html(b.text)}<br/><br/>` : ''}${esc(why)}<br/>${esc(brand.name)}${address ? ` · ${esc(address)}` : ''}<br/><br/><a href="${attr(input.unsubscribeUrl)}" style="color:${p.subtle};text-decoration:underline">${esc(copy.unsubscribe)}</a></mj-text></mj-column></mj-section>`);
        textParts.push('', '--', b.text ? plain(b.text) : '', why, `${brand.name}${address ? ` · ${address}` : ''}`, `${copy.unsubscribe}: ${input.unsubscribeUrl}`);
        break;
      }
    }
  }

  const bodyBg = doc.style.background === 'tinted' ? p.muted : '#F4F4F2';
  const pixel = input.openPixelUrl ? `<mj-section padding="0"><mj-column><mj-image src="${attr(input.openPixelUrl)}" alt="" width="1px" height="1px" padding="0" /></mj-column></mj-section>` : '';
  const fonts = [...new Set([brand.fonts.heading, brand.fonts.body])].filter((f) => SITE_FONT_FAMILIES[f].google).map((f) => `<mj-font name="${attr(SITE_FONT_FAMILIES[f].family)}" href="https://fonts.googleapis.com/css2?family=${SITE_FONT_FAMILIES[f].google}&amp;display=swap" />`).join('');
  const source = `<mjml lang="${attr(input.locale ?? 'en')}"><mj-head><mj-title>${esc(personalise(input.subject, values))}</mj-title>${input.preheader ? `<mj-preview>${esc(personalise(input.preheader, values))}</mj-preview>` : ''}${fonts}<mj-attributes><mj-all font-family="${attr(font(brand.fonts.body))}" /><mj-text color="${p.text}" font-size="16px" line-height="1.6" padding="8px 24px" /><mj-button background-color="${p.primary}" color="${p.onPrimary}" border-radius="${radius(doc.style.buttonShape)}" font-weight="700" font-size="16px" inner-padding="14px 28px" /><mj-section background-color="${p.surface}" /></mj-attributes></mj-head><mj-body background-color="${bodyBg}" width="600px">${parts.join('')}${pixel}</mj-body></mjml>`;
  const out = await mjml2html(source, { validationLevel: 'soft', minify: false, keepComments: false });
  return {
    subject: personalise(input.subject, values),
    html: out.html,
    text: textParts.filter((t, i, a) => t !== '' || a[i - 1] !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    links,
    warnings: [...new Set([...warnings, ...out.errors.map((e) => `mjml:${e.tagName}`)])],
  };
}
