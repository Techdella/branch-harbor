/**
 * Minimal XLSX reader (no dependency): reads the first worksheet of an Office Open XML workbook into rows of strings.
 * Handles shared strings, inline strings, booleans, numbers and date-formatted cells (written as YYYY-MM-DD).
 * Formulas give their cached value. Enough for spreadsheet imports; not a general spreadsheet library.
 */
import { inflateRawSync } from 'node:zlib';

export class XlsxError extends Error {}

/** Reads the entries of a ZIP archive (stored or deflated) by name. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new XlsxError('Not a valid .xlsx file (no ZIP directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Corrupt ZIP directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError('Corrupt ZIP entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }));
  }
  return out;
}

const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&';
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function dateStyles(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) custom.set(Number(m[1]), decode(m[2]!));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].forEach((m, i) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1]!)?.[1] ?? 0);
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? '';
    if (BUILTIN_DATE_FORMATS.has(id) || (/[dy]/i.test(code) && !/^[#0.,%\s]+$/.test(code))) out.add(i);
  });
  return out;
}

const serialToDate = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86_400_000)).toISOString().slice(0, 10);

/** First worksheet → rows of cell strings (empty trailing rows dropped). */
export function readXlsx(buf: Buffer): string[][] {
  const z = unzip(buf);
  const wb = z.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new XlsxError('Not a valid .xlsx file (no workbook)');
  const rid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const rels = z.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = rid ? new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1] : undefined;
  const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : 'xl/worksheets/sheet1.xml';
  const sheet = (z.get(path) ?? z.get('xl/worksheets/sheet1.xml'))?.toString('utf8');
  if (!sheet) throw new XlsxError('The workbook has no worksheet');
  const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const dates = dateStyles(z.get('xl/styles.xml')?.toString('utf8'));
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(/\br="(\d+)"/.exec(rm[1]!)?.[1] ?? rows.length + 1) - 1;
    const row: string[] = [];
    for (const cm of rm[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : row.length;
      const t = /\bt="(\w+)"/.exec(attrs)?.[1];
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = texts(body);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') val = decode(v ?? '');
      else if (v !== undefined) val = dates.has(style) && /^-?\d+(\.\d+)?$/.test(v) ? serialToDate(Number(v)) : v;
      while (row.length < idx) row.push('');
      row[idx] = val.trim();
    }
    while (rows.length < r) rows.push([]);
    rows[r] = row;
  }
  while (rows.length && rows[rows.length - 1]!.every((c) => !c)) rows.pop();
  return rows.filter((r, i) => i === 0 || r.some((c) => c !== ''));
}

/** Builds a tiny .xlsx (tests and the downloadable templates): one sheet, inline strings. */
export function writeXlsx(rows: string[][]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i: number) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  // Stored (uncompressed) ZIP.
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
