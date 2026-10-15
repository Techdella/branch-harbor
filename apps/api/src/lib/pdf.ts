/**
 * Minimal PDF writer (no dependencies): A4 pages of text in the standard Helvetica fonts with WinAnsi encoding.
 * Enough for invoices and statements; not a layout engine.
 */

export interface PdfText { x: number; y: number; text: string; size?: number; bold?: boolean; align?: 'left' | 'right' }
export interface PdfLine { x1: number; y1: number; x2: number; y2: number }
export interface PdfPage { texts: PdfText[]; lines?: PdfLine[] }

const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

/** Encodes text as a PDF string literal in WinAnsi; characters outside it become '?'. */
function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = WIN_ANSI[ch] ?? ch.codePointAt(0)!;
    const c = code <= 0xff ? code : 0x3f;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += `\\${String.fromCharCode(c)}`;
    else if (c < 0x20 || c > 0x7e) out += `\\${c.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(c);
  }
  return `(${out})`;
}

/** Approximate Helvetica width (average glyph width) for right alignment. */
const widthOf = (s: string, size: number, bold: boolean) => s.length * size * (bold ? 0.56 : 0.52);

export function renderPdf(pages: PdfPage[], meta: { title: string }): Buffer {
  const objects: string[] = [];
  const add = (body: string) => (objects.push(body), objects.length);
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const ops: string[] = [];
    for (const l of p.lines ?? []) ops.push(`0.8 0.8 0.8 RG 0.5 w ${l.x1} ${l.y1} m ${l.x2} ${l.y2} l S`);
    for (const t of p.texts) {
      const size = t.size ?? 10;
      const x = t.align === 'right' ? t.x - widthOf(t.text, size, !!t.bold) : t.x;
      ops.push(`BT /${t.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${t.y.toFixed(2)} Td ${pdfString(t.text)} Tj ET`);
    }
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(meta.title)} /Producer (BranchHarbor) >>`);
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
