import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security review's EXT-28: requests and answers went
// over window.postMessage, where any script on the page could read a request
// id and answer first with a fake txid or signature

vi.setConfig({ testTimeout: 30000 });

const ticks = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  await h.setupWallet();
});

describe('EXT-28 the provider talks to the wallet over a private port', () => {
  it('the provider still works end to end', async () => {
    await h.connectPage();
    const signed = h.provider().signMessage('hello');
    const req = await h.waitForPending('sign_message');
    expect((await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD })).success).toBe(true);
    expect(await signed).toBeTruthy();
  });

  it('nothing of a request or answer is posted to the window', async () => {
    const seen: any[] = [];
    h.onWindowMessage(e => seen.push(e.data));
    await h.connectPage();
    expect(await h.provider().isConnected()).toBe(true);
    await ticks();
    expect(seen).toEqual([]);
  });

  it('a request a page script posts to the window is not forwarded', async () => {
    const chrome = (globalThis as any).chrome;
    const forwarded: any[] = [];
    const realSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (msg: any, cb?: any) => { forwarded.push(msg); return realSend(msg, cb); };
    h.windowPost({ type: 'IRONDIVI_PROVIDER_MESSAGE', id: 'x', method: 'CONNECT' });
    await ticks();
    expect(forwarded).toEqual([]);
    expect(h.createdWindows).toHaveLength(0);
  });

  it('a forged answer posted to the window does not settle a pending request', async () => {
    await h.connectPage();
    let settled: unknown = 'pending';
    h.provider().signMessage('hello').then((v: unknown) => { settled = v; }, () => { settled = 'rejected'; });
    const req = await h.waitForPending('sign_message');
    // A page script answers every id it could have seen, with a fake signature
    for (const id of [req.id, 'any']) {
      h.windowPost({ type: 'IRONDIVI_PROVIDER_RESPONSE', id, response: { success: true, data: { signature: 'fake' } } });
    }
    await ticks();
    expect(settled).toBe('pending');
    expect((await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD })).success).toBe(true);
    await ticks();
    expect(JSON.stringify(settled)).not.toContain('fake');
  });

  it('a page that asks for the port later gets none', async () => {
    const w = (globalThis as any).window;
    const offered: MessagePort[] = [];
    w.addEventListener('irondivi:port', (e: MessageEvent) => offered.push(...e.ports));
    w.dispatchEvent(new Event('irondivi:ready'));
    await ticks();
    expect(offered).toEqual([]);
  });

  it('a port the page offers later is not taken by the content script', async () => {
    const { port1, port2 } = new MessageChannel();
    (port1 as any).unref?.();
    const got: any[] = [];
    port1.onmessage = e => got.push(e.data);
    const w = (globalThis as any).window;
    const taken = !w.dispatchEvent(new MessageEvent('irondivi:port', { ports: [port2], cancelable: true }));
    expect(taken).toBe(false);
    port1.postMessage({ id: 'x', method: 'IS_CONNECTED' });
    await ticks();
    expect(got).toEqual([]);
    port1.close();
  });

  it('works when the content script runs before the provider', async () => {
    // Fresh copies in the other order: the content script waits, the provider offers
    const w = (globalThis as any).window;
    delete w.__irondiviBridge;
    const cs = '../content/content-script?first';
    await import(/* @vite-ignore */ cs);
    // a page script listening after it never sees the port
    let offeredTo = 0;
    w.addEventListener('irondivi:port', () => { offeredTo++; });
    const { port1, port2 } = new MessageChannel();
    (port1 as any).unref?.();
    // the provider's offer, made after the content script listens
    expect(w.dispatchEvent(new MessageEvent('irondivi:port', { ports: [port2], cancelable: true }))).toBe(false);
    expect(offeredTo).toBe(0);
    const answer = new Promise<any>(r => { port1.onmessage = e => r(e.data); });
    port1.postMessage({ id: 'y', method: 'GET_NETWORK' });
    expect((await answer).response.success).toBe(true);
    port1.close();
  });

  it('neither script uses window.postMessage', () => {
    for (const f of ['../injected/provider.ts', '../content/content-script.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/window\.postMessage\(|addEventListener\('message'/);
    }
  });
});
