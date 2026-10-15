/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns header-keyed rows. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some((f) => f.trim() !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); if (record.some((f) => f.trim() !== '')) records.push(record); }
  const [head, ...body] = records;
  const headers = (head ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = body.map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])));
  return { headers, rows };
}

/**
 * Raw CSV records (headers kept as written), for the import wizard. The delimiter is detected from the first line
 * (comma, semicolon or tab: European exports often use semicolons).
 */
export function csvRecords(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const nl = src.search(/\r?\n/);
  const firstLine = nl < 0 ? src : src.slice(0, nl);
  const count = (d: string) => firstLine.split(d).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0]!;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delim) { record.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field.trim()); field = '';
      if (record.some((f) => f !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field.trim()); if (record.some((f) => f !== '')) records.push(record); }
  return records;
}
