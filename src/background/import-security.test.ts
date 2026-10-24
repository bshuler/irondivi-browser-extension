import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_MNEMONIC, TEST_PASSWORD, type Harness } from '../test-support/harness';

// H4: a phrase pasted with capitals, extra spaces or line breaks must give
// the same wallet as the phrase written normally

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
});

async function importAddress(mnemonic: string): Promise<string> {
  const r = await h.popup('IMPORT_ACCOUNT', { name: 'T', mnemonic, password: TEST_PASSWORD, network: 'testnet' });
  expect(r.success).toBe(true);
  return r.data.account.addresses[0].address;
}

describe('H4 imported phrases are normalised before derivation', () => {
  it('capitals, double spaces and line breaks give the standard wallet', async () => {
    const canonical = await importAddress(TEST_MNEMONIC);
    const words = TEST_MNEMONIC.split(' ');
    const messy = '  ' + words[0].toUpperCase() + '  ' + words.slice(1, 6).join(' ') + '\n' + words.slice(6).join('\t') + ' \n';
    expect(await importAddress(messy)).toBe(canonical);
  });

  it('stores the normalised phrase', async () => {
    const r = await h.popup('IMPORT_ACCOUNT', { name: 'T', mnemonic: TEST_MNEMONIC.toUpperCase(), password: TEST_PASSWORD, network: 'testnet' });
    const out = await h.popup('EXPORT_MNEMONIC', { accountId: r.data.account.id, password: TEST_PASSWORD });
    expect(out.success).toBe(true);
    expect(out.data.mnemonic).toBe(TEST_MNEMONIC);
  });
});
