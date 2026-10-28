import { describe, expect, it } from 'vitest';
import { cleanServerUrl, normalizeServerConfig, serverLabel, serverUrl } from './server-config';

describe('server settings', () => {
  it('is the default for a wallet that never set anything', () => {
    expect(normalizeServerConfig(undefined)).toEqual({ mainnet: { mode: 'default' }, testnet: { mode: 'default' } });
  });

  it('keeps a good own address and drops anything else to the default', () => {
    const c = normalizeServerConfig({
      mainnet: { mode: 'own', url: 'wss://box.tail1234.ts.net:50004' },
      testnet: { mode: 'own', url: 'ws://box.local' },
    });
    expect(c.mainnet).toEqual({ mode: 'own', url: 'wss://box.tail1234.ts.net:50004' });
    expect(c.testnet).toEqual({ mode: 'default' });
  });

  it('accepts only wss:// addresses without credentials', () => {
    expect(cleanServerUrl('wss://electrum.irondivi.com/testnet')).toBe('wss://electrum.irondivi.com/testnet');
    for (const bad of ['ws://x.example', 'https://x.example', 'wss://u:p@x.example', 'wss://', 'x.example', 5, 'wss://x.example/#a']) {
      expect(cleanServerUrl(bad)).toBeNull();
    }
  });

  it('maps a choice to its address', () => {
    expect(serverUrl({ mode: 'default' }, 'mainnet')).toBeNull();
    expect(serverUrl({ mode: 'public' }, 'testnet')).toBe('wss://electrum.irondivi.com/testnet');
    expect(serverLabel({ mode: 'own', url: 'wss://a.ts.net:50004' })).toBe('My own server · a.ts.net:50004');
  });
});
