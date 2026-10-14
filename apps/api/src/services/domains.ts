import { eq } from 'drizzle-orm';
import type { Services } from '../context.ts';
import { domains } from '../db/schema/index.ts';
import { nextDomainState, retryFromFailed, type DomainState } from '../domain/domainState.ts';
import { audit } from './audit.ts';

type DomainRow = typeof domains.$inferSelect;

/** Run DNS + provider checks and advance the state machine. Never skips a precondition. */
export async function verifyDomain(s: Services, d: DomainRow, actorUserId: string | null) {
  let current = d.state as DomainState;
  if (current === 'failed') current = retryFromFailed(current);
  const dns = await s.dns.check(d.hostname, d.dnsRecords);
  const dnsOk = dns.cnameOk && dns.txtOk;
  const provider = await s.domains.status(d.hostname, d.providerHostnameId, dnsOk, (d.checks as { certificate?: string }).certificate);
  const ageHours = (Date.now() - d.createdAt.getTime()) / 3600_000;
  const checks = { cnameOk: dns.cnameOk, txtOk: dns.txtOk, providerOwnershipVerified: provider.ownershipVerified, certificate: provider.certificate, ageHours };
  const t = nextDomainState(current, checks);
  const [updated] = await s.db.update(domains).set({
    state: t.state,
    failureReason: t.state === 'failed' ? t.reason : null,
    checks: { ...checks, reason: t.reason, checkedAt: new Date().toISOString() },
    attempts: d.attempts + 1,
    lastCheckedAt: new Date(),
    readyAt: t.state === 'ready' ? d.readyAt ?? new Date() : d.readyAt,
    updatedAt: new Date(),
  }).where(eq(domains.id, d.id)).returning();
  if (t.state !== d.state) {
    await audit(s.db, { organizationId: d.organizationId, actorUserId, action: 'domain.state_changed', scopeKind: d.locationId ? 'location' : 'organization', scopeId: d.locationId ?? d.organizationId, targetType: 'domain', targetId: d.id, metadata: { from: d.state, to: t.state, reason: t.reason } });
  }
  return { domain: updated!, transition: { from: d.state, to: t.state, reason: t.reason }, checks };
}

export function serializeDomain(d: DomainRow) {
  return {
    id: d.id, hostname: d.hostname, state: d.state, websiteId: d.websiteId, locationId: d.locationId, isPrimary: d.isPrimary,
    dnsRecords: d.dnsRecords, checks: d.checks, failureReason: d.failureReason, attempts: d.attempts, provider: d.provider,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null, readyAt: d.readyAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(),
    instructions: d.state === 'ready'
      ? 'Your domain is connected and secured.'
      : 'Add these DNS records at your domain provider. Keep any existing MX (email) records unchanged. Your included BranchHarbor address keeps working during setup.',
  };
}
