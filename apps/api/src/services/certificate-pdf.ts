/**
 * A tiny, dependency-free PDF generator for completion certificates: one landscape A4 page, built-in Helvetica
 * fonts (WinAnsi), a border and centred text. Characters outside Latin-1 are transliterated or replaced, which is
 * fine for names and course titles in the app's languages.
 */
export interface CertificateInput {
  brand: string;
  learnerName: string;
  courseTitle: string;
  issuedOn: string;
  expiresOn?: string | null;
  code: string;
  verifyUrl?: string | null;
  labels?: { title?: string; awardedTo?: string; forCompleting?: string; issued?: string; validUntil?: string; certificateNo?: string };
}

const W = 842;
const H = 595;

function latin1(s: string) {
  return s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .split('').map((c) => (c.charCodeAt(0) <= 255 ? c : '?')).join('');
}
const esc = (s: string) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Approximate Helvetica width (average glyph widths) so text can be centred without font metrics. */
function width(text: string, size: number, bold = false) {
  let units = 0;
  for (const c of latin1(text)) units += /[il.,:;'| ]/.test(c) ? 280 : /[mwMW]/.test(c) ? 830 : /[A-Z]/.test(c) ? 680 : /[0-9]/.test(c) ? 556 : 520;
  return (units / 1000) * size * (bold ? 1.06 : 1);
}

function centred(text: string, y: number, size: number, font: 'F1' | 'F2', rgb = '0.08 0.08 0.08') {
  const x = Math.max(40, (W - width(text, size, font === 'F2')) / 2);
  return `BT ${rgb} rg /${font} ${size} Tf ${x.toFixed(1)} ${y} Td (${esc(text)}) Tj ET`;
}

export function certificatePdf(c: CertificateInput): Buffer {
  const L = { title: 'Certificate of completion', awardedTo: 'This certifies that', forCompleting: 'has successfully completed', issued: 'Issued', validUntil: 'Valid until', certificateNo: 'Certificate no.', ...c.labels };
  const course = c.courseTitle.length > 70 ? `${c.courseTitle.slice(0, 67)}...` : c.courseTitle;
  const ops = [
    '0.97 0.96 0.93 rg 0 0 842 595 re f',
    '0.08 0.08 0.08 RG 3 w 28 28 786 539 re S',
    '0.84 0.95 0.42 rg 28 520 786 47 re f',
    centred(c.brand.toUpperCase(), 537, 14, 'F2'),
    centred(L.title, 445, 34, 'F2'),
    centred(L.awardedTo, 395, 14, 'F1', '0.36 0.36 0.35'),
    centred(c.learnerName, 345, 30, 'F2'),
    '0.08 0.08 0.08 RG 1 w 220 332 m 622 332 l S',
    centred(L.forCompleting, 300, 14, 'F1', '0.36 0.36 0.35'),
    centred(course, 262, 22, 'F2'),
    centred(`${L.issued}: ${c.issuedOn}${c.expiresOn ? `   ·   ${L.validUntil}: ${c.expiresOn}` : ''}`, 190, 12, 'F1'),
    centred(`${L.certificateNo} ${c.code}`, 120, 10, 'F1', '0.36 0.36 0.35'),
    ...(c.verifyUrl ? [centred(c.verifyUrl, 102, 9, 'F1', '0.36 0.36 0.35')] : []),
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`,
    `<< /Title (${esc(`${L.title} - ${c.learnerName}`)}) /Producer (BranchHarbor) >>`,
  ];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
