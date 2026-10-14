import type { domainStates } from '@bh/shared';

export type DomainState = (typeof domainStates)[number];

export interface DomainChecks {
  /** CNAME for the hostname resolves to our edge target (or provider sees traffic routed). */
  cnameOk: boolean;
  /** _bh-verify TXT record contains the expected token. */
  txtOk: boolean;
  /** Provider (e.g. Cloudflare for SaaS) reports ownership verified. */
  providerOwnershipVerified: boolean;
  certificate: 'none' | 'pending' | 'active' | 'failed';
  /** Hours since the domain was added. */
  ageHours: number;
}

export interface Transition {
  state: DomainState;
  reason: string | null;
}

/** Give up waiting for DNS after this long; the customer can retry from `failed`. */
export const DNS_TIMEOUT_HOURS = 72;

/**
 * Pure domain-connection state machine.
 *   awaiting_dns → verifying → certificate_pending → ready
 *   any non-ready → failed (certificate failure or DNS timeout); failed → awaiting_dns via retry.
 * One verify call advances as far as the checks allow, never skipping a precondition.
 */
export function nextDomainState(current: DomainState, c: DomainChecks): Transition {
  if (current === 'ready') {
    // A ready domain whose DNS was removed degrades back so the UI can show the repair action.
    if (!c.cnameOk) return { state: 'awaiting_dns', reason: 'DNS record no longer points to BranchHarbor' };
    return { state: 'ready', reason: null };
  }
  if (current === 'failed') return { state: 'failed', reason: 'Retry the connection to start verification again' };

  if (c.certificate === 'failed') return { state: 'failed', reason: 'Certificate could not be issued' };

  if (!c.cnameOk || !c.txtOk) {
    if (c.ageHours >= DNS_TIMEOUT_HOURS) return { state: 'failed', reason: `DNS records not found after ${DNS_TIMEOUT_HOURS} hours` };
    const missing = [!c.cnameOk && 'CNAME', !c.txtOk && 'TXT'].filter(Boolean).join(' and ');
    return { state: 'awaiting_dns', reason: `${missing} record not found yet. DNS changes can take time to propagate.` };
  }
  // DNS is in place → at least verifying.
  if (!c.providerOwnershipVerified) return { state: 'verifying', reason: 'Waiting for ownership verification' };
  if (c.certificate !== 'active') return { state: 'certificate_pending', reason: 'Certificate is being issued' };
  return { state: 'ready', reason: null };
}

export function retryFromFailed(current: DomainState): DomainState {
  if (current !== 'failed') throw new Error(`Cannot retry a domain in state ${current}`);
  return 'awaiting_dns';
}

const HOSTNAME_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;
export function normaliseHostname(input: string): string | null {
  const h = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!HOSTNAME_RE.test(h)) return null;
  if (h.endsWith('branchharbor.com')) return null;
  return h;
}
