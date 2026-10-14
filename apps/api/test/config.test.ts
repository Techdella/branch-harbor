import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  it('treats an empty EMAIL_PROVIDER (as written by a copied .env.example) as auto-detect', () => {
    expect(loadConfig({ EMAIL_PROVIDER: '' }).EMAIL_PROVIDER).toBeUndefined();
    expect(loadConfig({ EMAIL_PROVIDER: 'log' }).EMAIL_PROVIDER).toBe('log');
  });

  it('still rejects an unknown EMAIL_PROVIDER', () => {
    expect(() => loadConfig({ EMAIL_PROVIDER: 'carrier-pigeon' })).toThrow(/EMAIL_PROVIDER/);
  });
});
