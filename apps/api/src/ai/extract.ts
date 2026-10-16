import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Text extraction for knowledge-base uploads, without native dependencies:
 * - Markdown / plain text: as is.
 * - DOCX: the zip's word/document.xml, paragraphs kept, tags stripped.
 * - PDF: text-showing operators (Tj / TJ / ' / ") of every content stream, Flate-decoded. Works for most generated
 *   PDFs; scanned PDFs have no text layer (the assistant reads them with Claude vision when live).
 */
export type ExtractResult = { text: string; method: 'plain' | 'docx' | 'pdf'; pages?: number };

export function extractText(buf: Buffer, mimeType: string, fileName = ''): ExtractResult {
  const name = fileName.toLowerCase();
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return { text: pdfText(buf), method: 'pdf', pages: pdfPageCount(buf) };
  if (mimeType.includes('wordprocessingml') || name.endsWith('.docx')) return { text: docxText(buf), method: 'docx' };
  return { text: buf.toString('utf8').replace(/\r\n/g, '\n'), method: 'plain' };
}

/* ------------------------------ DOCX ------------------------------ */

/** Reads one entry from a zip archive (central directory → local header → stored or deflated data). */
export function unzipEntry(buf: Buffer, entryName: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

export function docxText(buf: Buffer): string {
  const xml = unzipEntry(buf, 'word/document.xml')?.toString('utf8');
  if (!xml) return '';
  const paras = xml.split(/<\/w:p>/).map((p) => {
    const heading = /<w:pStyle w:val="(Heading|Title)\d*"/i.test(p);
    const text = decodeXml((p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim();
    return text ? (heading ? `# ${text}` : text) : '';
  });
  return paras.filter(Boolean).join('\n\n');
}

/* ------------------------------ PDF ------------------------------ */

function pdfPageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_m, c: string) => {
    if (/^\d/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? c;
  });
}

function textFromContent(content: string): string {
  const out: string[] = [];
  // Literal strings inside BT … ET blocks: (text) Tj, [(a) 120 (b)] TJ, ' and ".
  for (const block of content.match(/\bBT\b[\s\S]*?(?:\bET\b|$)/g) ?? []) {
    let line = '';
    for (const m of block.matchAll(/(\[(?:[^\]\\]|\\.)*\]\s*TJ)|(\((?:[^()\\]|\\.)*\)\s*(?:Tj|'|"))|(T\*|Td|TD|Tm)/g)) {
      if (m[3]) {
        if (line.trim()) out.push(line);
        line = '';
        continue;
      }
      const raw = m[1] ?? m[2] ?? '';
      const parts = raw.match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
      line += parts.map((p) => unescapePdfString(p.slice(1, -1))).join('');
    }
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}

export function pdfText(buf: Buffer): string {
  const src = buf.toString('latin1');
  const texts: string[] = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const dict = m[1] ?? '';
    const start = m.index + m[0].length;
    const lenMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
    // Trust /Length only when "endstream" follows it; otherwise use the marker (hand-made or damaged files).
    const byLen = lenMatch ? start + Number(lenMatch[1]) : -1;
    const marker = src.indexOf('endstream', start);
    let end = byLen > start && byLen <= src.length && src.slice(byLen, byLen + 12).includes('endstream') ? byLen : marker;
    if (end > start && src[end - 1] === '\n') end -= src[end - 2] === '\r' ? 2 : 1;
    if (end < 0) break;
    let data = buf.subarray(start, end);
    if (/\/Subtype\s*\/Image/.test(dict) || /\/Type\s*\/XRef/.test(dict)) continue;
    if (/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateRawSync(data.subarray(2));
        } catch {
          continue;
        }
      }
    }
    const t = textFromContent(data.toString('latin1'));
    if (t.trim()) texts.push(t);
    re.lastIndex = end;
  }
  return texts.join('\n\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------ Chunking ------------------------------ */

export interface Chunk { heading: string | null; content: string }

/** Splits a long paragraph on sentence ends (hard cut as a last resort). */
function pieces(para: string, size: number): string[] {
  if (para.length <= size) return [para];
  const out: string[] = [];
  let cur = '';
  for (const sentence of para.split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < sentence.length; i += size) {
      const part = sentence.slice(i, i + size);
      if (cur && cur.length + part.length + 1 > size) {
        out.push(cur);
        cur = '';
      }
      cur += (cur ? ' ' : '') + part;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Splits text into ~1,200-character chunks on headings and paragraphs, carrying the current heading. */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? 1200;
  const overlap = opts.overlap ?? 150;
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push({ heading, content: cur.trim() });
    cur = '';
  };
  for (const raw of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const para = raw.trim();
    if (!para) continue;
    const h = para.match(/^#{1,4}\s+(.{1,140})$/) ?? (para.length < 90 && !/[.:;,]$/.test(para) && /^[A-Z0-9][^a-z]*$/.test(para) ? [para, para] : null);
    if (h) {
      push();
      heading = h[1]!.trim();
      continue;
    }
    for (const piece of pieces(para, size)) {
      if (cur && cur.length + piece.length + 2 > size) {
        // Carry a short tail (from a word boundary) into the next chunk of the same section.
        const tail = overlap > 0 ? cur.slice(-overlap) : '';
        const cut = tail.indexOf(' ');
        push();
        cur = overlap && cut >= 0 ? tail.slice(cut + 1) : '';
      }
      cur += (cur ? '\n\n' : '') + piece;
    }
  }
  push();
  return chunks;
}
