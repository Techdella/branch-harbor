import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { createCollectionAdapter, methodTypesFor } from '../src/integrations/finance-collection.ts';
import type { PaymentsProvider } from '../src/integrations/payments.ts';
import { major, toCsv } from '../src/services/finance/exports.ts';
import { renderPdf } from '../src/lib/pdf.ts';

/** Royalty collection against a mocked Stripe client: the live code path without network calls. */
describe('royalty collection adapter (live code path, mocked Stripe)', () => {
  const live = (client: unknown) => createCollectionAdapter({ mode: 'live', client: client as Stripe } as PaymentsProvider);

  it('offers card plus the local bank debit per currency', () => {
    expect(methodTypesFor('USD')).toEqual(['card', 'us_bank_account']);
    expect(methodTypesFor('cad')).toEqual(['card', 'acss_debit']);
    expect(methodTypesFor('GBP')).toEqual(['card', 'bacs_debit']);
    expect(methodTypesFor('EUR')).toEqual(['card', 'sepa_debit']);
    expect(methodTypesFor('AUD')).toEqual(['card', 'au_becs_debit']);
    expect(methodTypesFor('JPY')).toEqual(['card']);
  });

  it('creates the SetupIntent on the franchisor collection account with mandate options', async () => {
    const create = vi.fn(async () => ({ id: 'seti_1', client_secret: 'seti_1_secret' }));
    const a = live({ setupIntents: { create } });
    const r = await a.createSetupIntent({ accountId: 'acct_franchisor', customerId: 'cus_1', methodType: 'acss_debit', currency: 'CAD', metadata: { x: '1' }, idempotencyKey: 'k1' });
    expect(r).toEqual({ id: 'seti_1', clientSecret: 'seti_1_secret' });
    const [params, opts] = create.mock.calls[0] as unknown as [Record<string, any>, Record<string, any>];
    expect(params).toMatchObject({ customer: 'cus_1', usage: 'off_session', allowed_payment_method_types: ['acss_debit'] });
    expect(params.payment_method_options.acss_debit.mandate_options).toEqual({ payment_schedule: 'sporadic', transaction_type: 'business' });
    expect(opts).toEqual({ stripeAccount: 'acct_franchisor', idempotencyKey: 'k1' });
  });

  it('debits off-session as a direct charge on the collection account and maps declines', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ id: 'pi_ok', status: 'processing', last_payment_error: null })
      .mockRejectedValueOnce(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', raw: { payment_intent: { id: 'pi_dec' } } }));
    const a = live({ paymentIntents: { create } });
    const base = { accountId: 'acct_franchisor', customerId: 'cus_1', paymentMethodId: 'pm_1', amountMinor: 16_060, currency: 'CAD', metadata: { bh_target_type: 'royalty_invoice' }, idempotencyKey: 'fin_inv:1:1', description: 'Invoice NL-000001' };
    expect(await a.debit({ ...base, methodType: 'acss_debit' })).toMatchObject({ id: 'pi_ok', status: 'processing' });
    const [params, opts] = create.mock.calls[0] as unknown as [Record<string, any>, Record<string, any>];
    expect(params).toMatchObject({ amount: 16_060, currency: 'cad', customer: 'cus_1', payment_method: 'pm_1', off_session: true, confirm: true, allowed_payment_method_types: ['acss_debit'] });
    expect(params.application_fee_amount).toBeUndefined();
    expect(opts).toEqual({ stripeAccount: 'acct_franchisor', idempotencyKey: 'fin_inv:1:1' });
    expect(await a.debit({ ...base, methodType: 'card', idempotencyKey: 'fin_inv:1:2' })).toEqual({ id: 'pi_dec', status: 'failed', failureCode: 'card_declined', failureMessage: 'Your card was declined.' });
  });

  it('reads payouts with balance transactions linked to payment intents', async () => {
    const a = live({
      payouts: { list: vi.fn(async () => ({ data: [{ id: 'po_1', currency: 'cad', amount: 9_400, status: 'paid', arrival_date: 1_791_000_000 }] })) },
      balanceTransactions: {
        list: vi.fn(async () => ({
          data: [
            { id: 'txn_c', type: 'charge', amount: 10_000, fee: 590, net: 9_410, source: { id: 'ch_1', object: 'charge', payment_intent: 'pi_1' } },
            { id: 'txn_r', type: 'refund', amount: -1_000, fee: 0, net: -1_000, source: { id: 're_1', object: 'refund', payment_intent: 'pi_1' } },
            { id: 'txn_d', type: 'adjustment', reporting_category: 'dispute', amount: 0, fee: 0, net: 990, source: { id: 'du_1', object: 'dispute', charge: { payment_intent: 'pi_2' } } },
            { id: 'txn_p', type: 'payout', amount: -9_400, fee: 0, net: -9_400, source: 'po_1' },
          ],
        })),
      },
    });
    const [po] = await a.listPayouts('acct_loc');
    expect(po).toMatchObject({ id: 'po_1', currency: 'CAD', amountMinor: 9_400, status: 'paid' });
    expect(po!.transactions.map((t) => [t.type, t.sourcePaymentIntent])).toEqual([['charge', 'pi_1'], ['refund', 'pi_1'], ['dispute', 'pi_2']]);
  });

  it('runs deterministic sandbox outcomes without a Stripe client', async () => {
    const a = createCollectionAdapter({ mode: 'sandbox', client: null } as unknown as PaymentsProvider);
    const base = { accountId: null, customerId: 'cus_sandbox_x', amountMinor: 100, currency: 'GBP', metadata: {}, idempotencyKey: 'k', description: 'd' };
    expect((await a.debit({ ...base, paymentMethodId: 'pm_sandbox_card_ok', methodType: 'card' })).status).toBe('succeeded');
    expect((await a.debit({ ...base, paymentMethodId: 'pm_sandbox_bacs_debit_ok', methodType: 'bacs_debit' })).status).toBe('processing');
    expect((await a.debit({ ...base, paymentMethodId: 'pm_sandbox_bacs_debit_decline', methodType: 'bacs_debit' })).failureCode).toBe('insufficient_funds');
    expect(await a.listPayouts('acct_sandbox_1')).toEqual([]);
  });
});

describe('bank-debit schemes by collection-account country and the collection fee', () => {
  const live = (client: unknown) => createCollectionAdapter({ mode: 'live', client: client as Stripe } as PaymentsProvider);

  it('offers the bank debit only where the franchisor collection account can take it', () => {
    expect(methodTypesFor('EUR', 'IE')).toEqual(['card', 'sepa_debit']);
    expect(methodTypesFor('EUR', 'GB')).toEqual(['card', 'sepa_debit']);
    expect(methodTypesFor('EUR', 'CA')).toEqual(['card']);
    expect(methodTypesFor('USD', 'US')).toEqual(['card', 'us_bank_account']);
    expect(methodTypesFor('USD', 'CA')).toEqual(['card']);
    expect(methodTypesFor('CAD', 'CA')).toEqual(['card', 'acss_debit']);
    expect(methodTypesFor('GBP', 'IE')).toEqual(['card']);
    expect(methodTypesFor('AUD', 'au')).toEqual(['card', 'au_becs_debit']);
    expect(methodTypesFor('EUR', null)).toEqual(['card', 'sepa_debit']);
  });

  it('reads the account country, passes the flat fee as the platform fee and reports micro-deposit verification', async () => {
    const retrieve = vi.fn(async () => ({ country: 'us' }));
    const create = vi.fn(async () => ({ id: 'pi_1', status: 'processing', last_payment_error: null }));
    const siRetrieve = vi.fn(async () => ({ status: 'requires_action', payment_method: 'pm_1', mandate: null, next_action: { type: 'verify_with_microdeposits', verify_with_microdeposits: { hosted_verification_url: 'https://payments.stripe.com/microdeposit/x' } } }));
    const a = live({ accounts: { retrieve }, paymentIntents: { create }, setupIntents: { retrieve: siRetrieve } });
    expect(await a.accountCountry('acct_hq')).toBe('US');
    expect(await a.accountCountry('acct_hq')).toBe('US');
    expect(retrieve).toHaveBeenCalledTimes(1);
    await a.debit({ accountId: 'acct_hq', customerId: 'cus_1', paymentMethodId: 'pm_1', methodType: 'us_bank_account', amountMinor: 50_000, currency: 'USD', metadata: {}, idempotencyKey: 'k', description: 'd', applicationFeeMinor: 100 });
    expect((create.mock.calls[0] as unknown as [Record<string, unknown>])[0].application_fee_amount).toBe(100);
    expect(await a.retrieveSetupIntent({ accountId: 'acct_hq', id: 'seti_1' })).toMatchObject({ status: 'requires_action', verificationUrl: 'https://payments.stripe.com/microdeposit/x' });
  });
});

describe('export and document helpers', () => {
  it('formats minor units per currency exponent and neutralises spreadsheet formulas', () => {
    expect(major(123_456, 'CAD')).toBe('1234.56');
    expect(major(-5, 'GBP')).toBe('-0.05');
    expect(major(1_500, 'JPY')).toBe('1500');
    expect(toCsv(['a', 'b'], [['=HYPERLINK("x")', '-12.50'], ['Smith, J', '@x']])).toBe('a,b\r\n"\'=HYPERLINK(""x"")",-12.50\r\n"Smith, J",\'@x\r\n');
  });

  it('renders a valid PDF with WinAnsi text', () => {
    const pdf = renderPdf([{ texts: [{ x: 50, y: 800, text: 'Total 12.00 € (paid)' }] }], { title: 'Invoice NL-000001' }).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('(Total 12.00 \\200 \\(paid\\)) Tj');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
  });
});
