import { describe, expect, it } from 'vitest';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { chunkText, docxText, extractText, pdfText } from '../src/ai/extract.ts';
import { extractFieldsFromText } from '../src/ai/skills/documents.ts';
import { outlineFromText } from '../src/ai/skills/course-builder.ts';
import { parseSetup } from '../src/ai/skills/setup.ts';
import { scoreProspectFacts } from '../src/ai/skills/scoring.ts';
import { createSandboxLlm } from '../src/ai/sandbox.ts';

/** A one-file zip (deflated), enough for word/document.xml. */
function zip(name: string, content: Buffer) {
  const data = deflateRawSync(content);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

describe('knowledge extraction', () => {
  it('reads DOCX paragraphs and headings', () => {
    const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Opening</w:t></w:r></w:p><w:p><w:r><w:t>Unlock at 6 &amp; switch on.</w:t></w:r></w:p></w:body></w:document>';
    const buf = zip('word/document.xml', Buffer.from(xml));
    expect(docxText(buf)).toBe('# Opening\n\nUnlock at 6 & switch on.');
    expect(extractText(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').method).toBe('docx');
  });

  it('reads text from compressed PDF content streams', () => {
    const content = Buffer.from('BT /F1 12 Tf (Hello) Tj ( world) Tj T* [(Line) -250 (two)] TJ ET');
    const z = deflateSync(content);
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n4 0 obj << /Length ${z.length} /Filter /FlateDecode >> stream\n`), z, Buffer.from('\nendstream endobj\n%%EOF')]);
    expect(pdfText(pdf)).toBe('Hello world\nLinetwo');
  });

  it('chunks on headings and paragraphs, keeping the heading', () => {
    const text = `# Cleaning\n\n${'Spray mats. '.repeat(150)}\n\n# Closing\n\nLock up.`;
    const chunks = chunkText(text, { size: 600, overlap: 50 });
    expect(chunks[0]!.heading).toBe('Cleaning');
    expect(chunks[chunks.length - 1]).toMatchObject({ heading: 'Closing', content: 'Lock up.' });
    expect(chunks.every((c) => c.content.length <= 700)).toBe(true);
  });
});

describe('deterministic skills (sandbox)', () => {
  it('extracts certificate fields only from what is printed', () => {
    const f = extractFieldsFromText('Certificate of Liability Insurance\nInsurer: Northern Shield Ltd\nPolicy No: GL-2291-A\nEach occurrence limit CAD 2,000,000\nPeriod from 01/03/2026\nExpiry date: 28 Feb 2027');
    expect(f).toMatchObject({ category: 'insurance', issuer: 'Northern Shield Ltd', reference: 'GL-2291-A', coverageAmount: 2000000, currency: 'CAD', issuedOn: '2026-03-01', expiresOn: '2027-02-28' });
    expect(extractFieldsFromText('A letter with no dates').expiresOn).toBeNull();
  });

  it('builds a course outline and quiz from the manual headings', () => {
    const o = outlineFromText('# Arrive\n\nCome early and set up the room before anyone arrives.\n\n# Teach\n\nGreet everyone and explain the class plan clearly.\n\n# Leave\n\nClean up, switch off and lock the doors behind you.', 'Basics');
    expect(o.modules[0]!.lessons.map((l) => l.title)).toEqual(['Arrive', 'Teach', 'Leave']);
    for (const q of o.quiz) expect(q.options[q.correct]).toBeTruthy();
  });

  it('plans a setup from a sentence', () => {
    const p = parseSetup('I run twelve yoga studios in Canada and the UK', { industry: 'studios', name: 'Flow' });
    expect(p.locations).toHaveLength(12);
    expect(p.detectedIndustry).toBe('studios');
    expect(p.team.find((t) => t.role === 'regional_manager')?.count).toBe(2);
  });

  it('explains a franchise candidate score', () => {
    const s = scoreProspectFacts({ id: 'p', name: 'Pat', stage: 'qualified', source: 'referral', liquidCapital: 300000, territoryId: 't', territoryName: 'Downtown', createdAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString() }, []);
    expect(s.factors.find((f) => f.key === 'capital')!.reason).toMatch(/not verified/);
    expect(s.nextBestAction.tool).toBe('move_prospect_stage');
  });

  it('the sandbox engine only answers from tool results and never picks a tool outside the offered set', async () => {
    const llm = createSandboxLlm();
    const tools = [{ name: 'list_locations', input_schema: { type: 'object' as const } }];
    const first = await llm.call({ tier: 'main', system: 's', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'Which locations missed royalties last month?' }] }] });
    expect(first.content.some((b) => b.type === 'tool_use')).toBe(false);
    const ask = await llm.call({ tier: 'main', system: 's', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'list our locations' }] }] });
    const use = ask.content.find((b) => b.type === 'tool_use') as { id: string; name: string };
    expect(use.name).toBe('list_locations');
    const answer = await llm.call({ tier: 'main', system: 's', tools, locale: 'fr', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ summary: '2 sites.' }) }] }] });
    expect((answer.content[0] as { text: string }).text).toBe('2 sites.');
  });
});
