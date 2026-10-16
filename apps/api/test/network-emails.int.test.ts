import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema/index.ts';
import { runComplianceJobs } from '../src/services/compliance.ts';
import { renderNetworkEmail } from '../src/services/network-emails.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, verifiedUser, uid } from './helpers.ts';

/** Compliance reminders and survey invitations go by email in each recipient's own language. */
describe('network emails in the recipient’s language', () => {
  it('renders every kind in the five app languages (other locales read English)', async () => {
    const e = { kind: 'compliance_expiring' as const, business: 'Northlight', label: 'Business licence (Galway Docks)', expiresOn: '2026-11-20', daysLeft: 30, url: 'https://app.example/compliance' };
    const subjects = await Promise.all(['en', 'fr', 'es', 'de', 'pt-BR', 'ja'].map(async (locale) => (await renderNetworkEmail(e, { name: 'Aoife', locale })).subject));
    expect(subjects).toEqual([
      'Expires in 30 days: Business licence (Galway Docks)', 'Expire dans 30 jours : Business licence (Galway Docks)', 'Vence en 30 días: Business licence (Galway Docks)',
      'Läuft in 30 Tagen ab: Business licence (Galway Docks)', 'Vence em 30 dias: Business licence (Galway Docks)', 'Expires in 30 days: Business licence (Galway Docks)',
    ]);
    const fr = await renderNetworkEmail(e, { name: 'Aoife', locale: 'fr-CA' });
    expect(fr.locale).toBe('fr');
    expect(fr.text).toContain('20 novembre 2026');
    expect(fr.html).toContain('lang="fr"');
    expect(fr.html).toContain('Déposer le document');
    const survey = await renderNetworkEmail({ kind: 'survey_invite', business: 'Northlight', title: 'Q4 pulse', closesOn: '2026-10-30', anonymous: true, url: 'https://app.example/surveys/1/respond' }, { name: 'Jonas', locale: 'de' });
    expect(survey.subject).toBe('Umfrage: Q4 pulse');
    expect(survey.text).toContain('Ihre Antworten sind anonym.');
    expect(survey.text).toContain('https://app.example/surveys/1/respond');
  });
});

describe.skipIf(!hasDb)('compliance reminders and survey invitations by email (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('a French-speaking franchise owner gets the missing-document reminder and the survey invitation in French', async () => {
    const sent: Array<{ to: string; subject: string; text: string; html?: string; tag?: string }> = [];
    const orig = app.ctx.jobs.enqueue.bind(app.ctx.jobs);
    app.ctx.jobs.enqueue = async (name: string, data: any, o?: any) => { if (name === 'email.send') sent.push(data); return orig(name, data, o); };
    try {
      const owner = await verifiedUser(app, 'Emails HQ');
      const O = (await createOrg(app, owner.token, { name: `Emails ${uid()}`, country: 'CA', defaultCurrency: 'CAD' })).id;
      const g = (await call(app, 'POST', `/v1/orgs/${O}/owner-groups`, { token: owner.token, body: { name: 'Groupe Plateau' } })).body;
      const loc = await createLocation(app, owner.token, O, { name: 'Montréal Plateau', ownerGroupId: g.id, address: { line1: '1 Rue Saint-Denis', city: 'Montréal', region: 'QC', country: 'CA' } });
      const fo = await memberWithRole(app, owner.token, O, 'franchise_owner', { kind: 'owner_group', id: g.id }, 'Camille Roy');
      await app.ctx.db.update(users).set({ locale: 'fr-CA' }).where(eq(users.id, fo.userId));
      const req = await call(app, 'POST', `/v1/orgs/${O}/compliance/requirements`, { token: owner.token, body: { name: 'Permis d’exploitation', category: 'licence' } });
      expect(req.status, JSON.stringify(req.body)).toBe(201);

      await runComplianceJobs(app.ctx, new Date(), O);
      const missing = sent.find((m) => m.to === fo.email && m.tag === 'compliance_missing');
      expect(missing?.subject).toBe(`Manquant : Permis d’exploitation (${loc.name})`);
      expect(missing?.text).toContain('Bonjour Camille Roy,');
      expect(missing?.html).toContain('lang="fr"');

      const list = await call(app, 'GET', `/v1/orgs/${O}/surveys`, { token: owner.token });
      const sv = await call(app, 'POST', `/v1/orgs/${O}/surveys`, { token: owner.token, body: { ...list.body.starter, title: 'Pouls du réseau' } });
      expect(sv.status, JSON.stringify(sv.body)).toBe(201);
      sent.length = 0;
      expect((await call(app, 'POST', `/v1/orgs/${O}/surveys/${sv.body.id}/launch`, { token: owner.token })).status).toBe(200);
      const invite = sent.find((m) => m.to === fo.email && m.tag === 'survey_invite');
      expect(invite?.subject).toBe('Enquête : Pouls du réseau');
      expect(invite?.text).toContain(`/surveys/${sv.body.id}/respond`);
      // The person who launched it is not invited by email.
      expect(sent.some((m) => m.to === owner.email && m.tag === 'survey_invite')).toBe(false);
    } finally {
      app.ctx.jobs.enqueue = orig;
    }
  });
});
