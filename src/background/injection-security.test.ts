import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness } from '../test-support/harness';

// Regression tests for the security review's M1 (a web page's content script
// could read the encrypted vault from storage) and M11 (the provider was
// injected by three paths, so a page could get two bridges)

vi.setConfig({ testTimeout: 30000 });

async function ticks(n = 20) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  vi.resetModules();
});

describe('M1 the content script never reads extension storage', () => {
  it('asks the background whether the page may use the wallet', async () => {
    const h = await createHarness();
    const r = await h.fromTab('SITE_ALLOWED');
    expect(r).toEqual({ success: true, data: { allowed: true } });
    expect(h.provider()).toBeDefined();
  });

  it('a page that is not https is told no and gets no provider', async () => {
    const h = await createHarness('http://evil.example/', { grantedOrigins: ['http://evil.example/*'] });
    const r = await h.fromTab('SITE_ALLOWED');
    expect(r).toEqual({ success: true, data: { allowed: false } });
    expect(h.provider()).toBeUndefined();
  });

  it('an https page off the default list gets the provider, but only its status', async () => {
    const h = await createHarness('https://evil.example/');
    expect(await h.fromTab('SITE_ALLOWED')).toEqual({ success: true, data: { allowed: true } });
    expect(await h.provider().getAccessStatus()).toBe('not_allowed');
    expect(await h.fromTab('GET_ADDRESSES')).toMatchObject({ success: false, code: 4300 });
  });

  it('a page cannot ask SITE_ALLOWED through the provider bridge', async () => {
    const h = await createHarness();
    const r = await h.pagePost('SITE_ALLOWED');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/unsupported/i);
  });

  it('loading the content script sends one SITE_ALLOWED and nothing else', async () => {
    await createHarness();
    const chrome = (globalThis as any).chrome;
    delete (globalThis as any).window.__irondiviBridge;
    const sent: any[] = [];
    const realSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (msg: any, cb?: any) => { sent.push(msg); return realSend(msg, cb); };
    const path = '../content/content-script?fresh';
    await import(/* @vite-ignore */ path);
    await ticks();
    expect(sent.map(m => m.type)).toEqual(['SITE_ALLOWED']);
  });

  it('the content script does not touch chrome.storage', () => {
    const src = readFileSync(new URL('../content/content-script.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/storage\.(local|session|get|set)|getSettings|import \{[^}]*storage/);
  });

  it('the manifest asks only for what the wallet needs: https pages, so sites can ask, and its own hosts', () => {
    const m = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    expect(m.permissions).toEqual(['storage', 'alarms', 'idle', 'scripting']);
    expect(m.host_permissions).toEqual([
      'https://*/*', 'https://games.divi.domains/*', 'https://services.divi.domains/*', 'https://vps1.divi.domains/*',
    ]);
    // Local pages only for a development build, and only if the developer grants them
    expect(m.optional_host_permissions).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
  });
});

describe('M11 the wallet is injected once, through one path', () => {
  it('a second copy of the content script adds no second relay and no second provider', async () => {
    const h = await createHarness();
    const chrome = (globalThis as any).chrome;
    const created: unknown[] = [];
    const doc = (globalThis as any).document;
    const realCreate = doc.createElement;
    doc.createElement = (...a: any[]) => { created.push(a[0]); return realCreate(...a); };

    const path = '../content/content-script?second';
    await import(/* @vite-ignore */ path);
    await ticks();
    expect(created).toEqual([]);

    const forwarded: any[] = [];
    const realSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (msg: any, cb?: any) => { forwarded.push(msg); return realSend(msg, cb); };
    await h.pagePost('IS_CONNECTED');
    await ticks();
    expect(forwarded.filter(m => m.type === 'IS_CONNECTED')).toHaveLength(1);
  });

  it('window.irondivi cannot be replaced by the page', async () => {
    const h = await createHarness();
    const w = (globalThis as any).window;
    const original = h.provider();
    expect(original.isIronDivi).toBe(true);
    expect(() => { 'use strict'; w.irondivi = {}; }).toThrow();
    expect(() => Object.defineProperty(w, 'irondivi', { value: {} })).toThrow();
    expect(h.provider()).toBe(original);
  });

  it('a second copy of the provider does not throw or replace the first', async () => {
    const h = await createHarness();
    const original = h.provider();
    const path = '../injected/provider?second';
    await expect(import(/* @vite-ignore */ path)).resolves.toBeDefined();
    expect(h.provider()).toBe(original);
  });

  it('the background does not inject on navigation or tab switch', () => {
    for (const file of ['./service-worker.ts', './site-scripts.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(src).not.toMatch(/webNavigation|executeScript|tabs\.onActivated/);
    }
  });
});
