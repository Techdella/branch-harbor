import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config.ts';
import { checkAttachments, createMailer } from '../src/integrations/mailer.ts';
import { call, createLocation, createOrg, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

/** Email attachments (Postmark, Resend and the sandbox) and purchase orders sent with their PDF and CSV attached. */
const quiet = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never;
const pdf = { filename: 'PO-0001.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 test').toString('base64') };
const csv = { filename: 'PO-0001.csv', contentType: 'text/csv', contentBase64: Buffer.from('po_number,sku\nPO-0001,OIL\n').toString('base64') };

describe('mailer attachments', () => {
  afterAll(() => { vi.unstubAllGlobals(); });

  it('Postmark and Resend send the files; the sandbox keeps them in the outbox', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ MessageID: 'pm-1', id: 're-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const postmark = createMailer({ EMAIL_FROM: 'BranchHarbor <hello@branchharbor.com>', POSTMARK_SERVER_TOKEN: 'pm-token' } as Config, quiet);
    await postmark.send({ to: 'orders@supplier.example', subject: 'PO', text: 'See attached', attachments: [pdf, csv] });
    const pmBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(pmBody.Attachments).toEqual([{ Name: 'PO-0001.pdf', Content: pdf.contentBase64, ContentType: 'application/pdf' }, { Name: 'PO-0001.csv', Content: csv.contentBase64, ContentType: 'text/csv' }]);

    const resend = createMailer({ EMAIL_FROM: 'hello@branchharbor.com', RESEND_API_KEY: 're-key' } as Config, quiet);
    await resend.send({ to: 'orders@supplier.example', subject: 'PO', text: 'See attached', attachments: [pdf] });
    const reBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body);
    expect(reBody.attachments).toEqual([{ filename: 'PO-0001.pdf', content: pdf.contentBase64, content_type: 'application/pdf' }]);

    // Without attachments nothing extra is sent.
    await postmark.send({ to: 'a@b.example', subject: 'x', text: 'y' });
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, { body: string }])[1].body).Attachments).toBeUndefined();

    const sandbox = createMailer({ EMAIL_FROM: 'hello@branchharbor.com' } as Config, quiet);
    await sandbox.send({ to: 'orders@supplier.example', subject: 'PO', text: 'See attached', attachments: [pdf, csv] });
    expect(sandbox.outbox[0]!.attachments!.map((a) => a.filename)).toEqual(['PO-0001.pdf', 'PO-0001.csv']);
  });

  it('keeps file names to one safe line and refuses too many or too large files', () => {
    expect(checkAttachments([{ ...pdf, filename: 'a"b\r\nc/d.pdf' }])[0]!.filename).toBe('a_b__c_d.pdf');
    expect(() => checkAttachments(Array.from({ length: 11 }, () => pdf))).toThrow(/Too many/);
    expect(() => checkAttachments([{ ...pdf, contentBase64: 'A'.repeat(15 * 1024 * 1024) }])).toThrow(/too large/);
  });
});

describe.skipIf(!hasDb)('purchase orders are emailed with the PDF and CSV attached (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('a sent order carries its PDF and CSV', async () => {
    const owner = await verifiedUser(app, 'PO Owner');
    const orgId = (await createOrg(app, owner.token, { name: `PO ${uid()}`, industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    const loc = await createLocation(app, owner.token, orgId, { name: 'Seattle Ballard', timeZone: 'America/Los_Angeles', currency: 'USD', address: { line1: '1 Market St', city: 'Seattle', region: 'WA', country: 'US' } });
    const S = `/v1/orgs/${orgId}/supply`;
    const orderEmail = `orders-${uid()}@nwfoods.example`;
    const sup = await call(app, 'POST', `${S}/suppliers`, { token: owner.token, body: { name: 'Northwest Foodservice', countries: ['US'], currency: 'USD', orderEmail, orderFormat: 'pdf' } });
    expect(sup.status, JSON.stringify(sup.body)).toBe(201);
    const item = await call(app, 'POST', `${S}/suppliers/${sup.body.id}/items`, { token: owner.token, body: { sku: 'OIL-5L', name: 'Extra virgin olive oil', packLabel: 'Case of 4 × 5 L', prices: { USD: 9_800 }, leadTimeDays: 3 } });
    const po = await call(app, 'POST', `${S}/orders`, { token: owner.token, body: { locationId: loc.id, supplierId: sup.body.id, lines: [{ itemId: item.body.id, quantity: 2 }], submit: true } });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const msg = app.ctx.mailer.outbox.filter((m) => m.to === orderEmail).at(-1)!;
    expect(msg.tag).toBe('supply_po_sent');
    expect(msg.text).toContain('attached as PDF and CSV');
    const number = po.body.purchaseOrder?.number ?? po.body.number;
    expect(msg.attachments!.map((a) => [a.filename, a.contentType])).toEqual([[`${number}.pdf`, 'application/pdf'], [`${number}.csv`, 'text/csv']]);
    expect(Buffer.from(msg.attachments![0]!.contentBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const csvText = Buffer.from(msg.attachments![1]!.contentBase64, 'base64').toString('utf8');
    expect(csvText).toContain(number);
    expect(csvText).toContain('OIL-5L');
  });
});
