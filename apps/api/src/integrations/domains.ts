import { promises as dnsPromises } from 'node:dns';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';
import type { DnsRecord } from '../db/schema/index.ts';

export interface HostnameRegistration {
  providerHostnameId: string | null;
  records: DnsRecord[];
}

export interface ProviderStatus {
  ownershipVerified: boolean;
  certificate: 'none' | 'pending' | 'active' | 'failed';
}

export interface DomainProvider {
  readonly mode: 'cloudflare' | 'sandbox';
  register(hostname: string, verificationToken: string): Promise<HostnameRegistration>;
  status(hostname: string, providerHostnameId: string | null, dnsOk: boolean, previousCertificate: string | undefined): Promise<ProviderStatus>;
  remove(providerHostnameId: string | null): Promise<void>;
}

export interface DnsChecker {
  check(hostname: string, records: DnsRecord[]): Promise<{ cnameOk: boolean; txtOk: boolean }>;
}

export function baseRecords(cfg: Config, hostname: string, token: string): DnsRecord[] {
  return [
    { type: 'CNAME', name: hostname, value: cfg.DOMAINS_CNAME_TARGET, purpose: 'Routes traffic for your domain to BranchHarbor', ttl: 300 },
    { type: 'TXT', name: `_bh-verify.${hostname}`, value: `bh-verify=${token}`, purpose: 'Proves you control this domain', ttl: 300 },
  ];
}

/** Real DNS lookups through the system resolver. */
export const systemDnsChecker: DnsChecker = {
  async check(hostname, records) {
    const cname = records.find((r) => r.type === 'CNAME');
    const txt = records.find((r) => r.type === 'TXT' && r.name.startsWith('_bh-verify.'));
    const cnameOk = cname
      ? await dnsPromises.resolveCname(hostname).then((v) => v.some((x) => x.replace(/\.$/, '').toLowerCase() === cname.value.toLowerCase())).catch(() => false)
      : true;
    const txtOk = txt
      ? await dnsPromises.resolveTxt(txt.name).then((v) => v.some((chunks) => chunks.join('') === txt.value)).catch(() => false)
      : true;
    return { cnameOk, txtOk };
  },
};

/** Sandbox DNS checker that treats records as present (DOMAINS_SANDBOX_AUTO_VERIFY=true). */
export const autoPassDnsChecker: DnsChecker = { check: async () => ({ cnameOk: true, txtOk: true }) };

/**
 * Cloudflare for SaaS custom hostnames. Without CLOUDFLARE_API_TOKEN/ZONE_ID, runs a sandbox
 * provider where ownership verifies once DNS is in place and the certificate becomes active on
 * the following check (simulating issuance latency).
 */
export function createDomainProvider(cfg: Config, log: FastifyBaseLogger): DomainProvider {
  const live = !!(cfg.CLOUDFLARE_API_TOKEN && cfg.CLOUDFLARE_ZONE_ID);
  if (!live) log.warn('[domains] Cloudflare for SaaS not configured — custom domains run in SANDBOX mode');
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfg.CLOUDFLARE_ZONE_ID}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = (await res.json()) as { success: boolean; result: any; errors: Array<{ message: string }> };
    if (!body.success) throw new Error(`Cloudflare: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.result;
  };

  if (!live) {
    return {
      mode: 'sandbox',
      async register(hostname, token) {
        return { providerHostnameId: null, records: baseRecords(cfg, hostname, token) };
      },
      async status(_h, _id, dnsOk, prev) {
        if (!dnsOk) return { ownershipVerified: false, certificate: 'none' };
        return { ownershipVerified: true, certificate: prev === 'pending' || prev === 'active' ? 'active' : 'pending' };
      },
      async remove() {},
    };
  }

  return {
    mode: 'cloudflare',
    async register(hostname, token) {
      const result = await api('/custom_hostnames', {
        method: 'POST',
        body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } }, custom_metadata: { bh_token: token } }),
      });
      const records = baseRecords(cfg, hostname, token);
      const ov = result.ownership_verification;
      if (ov?.type === 'txt') records.push({ type: 'TXT', name: ov.name, value: ov.value, purpose: 'Certificate authority ownership verification', ttl: 300 });
      return { providerHostnameId: result.id as string, records };
    },
    async status(_hostname, id) {
      if (!id) return { ownershipVerified: false, certificate: 'none' };
      const r = await api(`/custom_hostnames/${id}`);
      const ssl: string = r.ssl?.status ?? 'initializing';
      const certificate = ssl === 'active' ? 'active' : /failed|timed_out|deleted/.test(ssl) ? 'failed' : 'pending';
      return { ownershipVerified: r.status === 'active', certificate };
    },
    async remove(id) {
      if (id) await api(`/custom_hostnames/${id}`, { method: 'DELETE' });
    },
  };
}
