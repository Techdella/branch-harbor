/**
 * Agreement e-signature adapters. The built-in provider records a typed-name signature with timestamp, IP and user
 * agent through a signed link (sandbox / small networks). DocuSign and Dropbox Sign implement the same interface;
 * they are selected by environment variables and are NOT wired to the providers' APIs yet (see README → Stubbed).
 *
 * Whatever the provider, BranchHarbor re-checks the jurisdiction rules at the moment of signing and refuses a
 * signature while a waiting period or registration requirement is outstanding.
 */
import { randomToken } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';

export type ESignProviderKey = 'builtin' | 'docusign' | 'dropbox_sign';

export interface SendEnvelopeInput {
  organizationId: string;
  prospectId: string;
  documentTitle: string;
  signer: { name: string; email: string };
  /** Where the signer is sent back to after signing (built-in provider: the hosted signing page). */
  returnUrl?: string;
}

export interface SendEnvelopeResult {
  provider: ESignProviderKey;
  envelopeId: string;
  /** Built-in provider only: raw token for the signing link (never stored, only its hash). */
  token: string | null;
}

export interface ESignProvider {
  key: ESignProviderKey;
  mode: 'builtin' | 'live' | 'not_configured';
  send(input: SendEnvelopeInput): Promise<SendEnvelopeResult>;
}

export const ESIGN_DISCLAIMER =
  'Electronic signatures are legally recognised in many jurisdictions (for example ESIGN/UETA in the US, eIDAS in the EU, the Electronic Transactions Acts in Canada and Australia), but requirements differ. Confirm with counsel that this signature method is acceptable for franchise agreements in each jurisdiction.';

const builtin: ESignProvider = {
  key: 'builtin',
  mode: 'builtin',
  async send() {
    const token = randomToken();
    return { provider: 'builtin', envelopeId: `bh_env_${randomToken(9)}`, token };
  },
};

function notWired(key: Exclude<ESignProviderKey, 'builtin'>, configured: boolean): ESignProvider {
  return {
    key,
    mode: configured ? 'live' : 'not_configured',
    async send() {
      if (!configured) throw new AppError(503, 'esign_not_configured', `${key === 'docusign' ? 'DocuSign' : 'Dropbox Sign'} is not configured. Use the built-in signature or add the provider keys.`);
      // Adapter boundary: create the envelope with the provider's REST API and return its id. Not implemented yet.
      throw new AppError(501, 'esign_not_implemented', `${key === 'docusign' ? 'DocuSign' : 'Dropbox Sign'} sending is not implemented yet. Use the built-in signature.`);
    },
  };
}

export function esignProviders(env: NodeJS.ProcessEnv = process.env): Record<ESignProviderKey, ESignProvider> {
  return {
    builtin,
    docusign: notWired('docusign', !!(env.DOCUSIGN_INTEGRATION_KEY && env.DOCUSIGN_ACCOUNT_ID)),
    dropbox_sign: notWired('dropbox_sign', !!env.DROPBOX_SIGN_API_KEY),
  };
}

export function esignStatus(env: NodeJS.ProcessEnv = process.env) {
  return Object.values(esignProviders(env)).map((p) => ({ key: p.key, mode: p.mode }));
}
