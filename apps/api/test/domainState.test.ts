import { describe, expect, it } from 'vitest';
import { DNS_TIMEOUT_HOURS, nextDomainState, normaliseHostname, retryFromFailed, type DomainChecks } from '../src/domain/domainState.ts';

const base: DomainChecks = { cnameOk: false, txtOk: false, providerOwnershipVerified: false, certificate: 'none', ageHours: 1 };

describe('domain state machine', () => {
  it('waits for DNS until both records are present', () => {
    expect(nextDomainState('awaiting_dns', base).state).toBe('awaiting_dns');
    expect(nextDomainState('awaiting_dns', { ...base, cnameOk: true }).reason).toMatch(/TXT/);
  });

  it('advances awaiting_dns → verifying → certificate_pending → ready', () => {
    const dns = { ...base, cnameOk: true, txtOk: true };
    expect(nextDomainState('awaiting_dns', dns).state).toBe('verifying');
    expect(nextDomainState('verifying', { ...dns, providerOwnershipVerified: true, certificate: 'pending' }).state).toBe('certificate_pending');
    expect(nextDomainState('certificate_pending', { ...dns, providerOwnershipVerified: true, certificate: 'active' }).state).toBe('ready');
  });

  it('never skips ownership verification even if a certificate is reported', () => {
    expect(nextDomainState('awaiting_dns', { ...base, cnameOk: true, txtOk: true, certificate: 'active' }).state).toBe('verifying');
  });

  it('fails on certificate failure or DNS timeout, and retry restarts at awaiting_dns', () => {
    expect(nextDomainState('certificate_pending', { ...base, cnameOk: true, txtOk: true, providerOwnershipVerified: true, certificate: 'failed' }).state).toBe('failed');
    expect(nextDomainState('awaiting_dns', { ...base, ageHours: DNS_TIMEOUT_HOURS + 1 }).state).toBe('failed');
    expect(nextDomainState('failed', base).state).toBe('failed');
    expect(retryFromFailed('failed')).toBe('awaiting_dns');
    expect(() => retryFromFailed('ready')).toThrow();
  });

  it('a ready domain whose DNS disappears goes back to awaiting_dns', () => {
    expect(nextDomainState('ready', { ...base, txtOk: true }).state).toBe('awaiting_dns');
  });

  it('normalises hostnames and rejects invalid or platform hostnames', () => {
    expect(normaliseHostname('https://WWW.Example.co.uk/path')).toBe('www.example.co.uk');
    expect(normaliseHostname('not a domain')).toBeNull();
    expect(normaliseHostname('shop.branchharbor.com')).toBeNull();
  });
});
