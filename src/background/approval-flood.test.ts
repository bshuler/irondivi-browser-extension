import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness, TEST_PASSWORD, type Harness } from '../test-support/harness';

// Regression tests for the security review's M5: a site could open approval
// windows without limit, and Connect alone granted signing and sending

vi.setConfig({ testTimeout: 30000 });

function storedPermissions(h: Harness): string[] {
  const all = h.storage.connections ?? {};
  for (const byOrigin of Object.values(all) as any[]) {
    const c = byOrigin['https://app.divi.domains'];
    if (c) return c.permissions;
  }
  return [];
}

let h: Harness;

beforeEach(async () => {
  vi.resetModules();
  h = await createHarness();
  await h.setupWallet();
  await h.connectPage();
});

describe('M5 a site cannot flood the owner with approval windows', () => {
  it('a second request while one is waiting is refused without a window', async () => {
    const first = h.fromTab('SIGN_MESSAGE', { message: 'one' });
    const req = await h.waitForPending('sign_message');
    const windows = h.createdWindows.length;
    const second = await h.fromTab('SIGN_MESSAGE', { message: 'two' });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already has a request waiting/i);
    expect(h.createdWindows.length).toBe(windows);
    await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req.id });
    expect((await first).success).toBe(false);
  });

  it('the same request asked twice still shares one window', async () => {
    const a = h.fromTab('SIGN_MESSAGE', { message: 'same' });
    const req = await h.waitForPending('sign_message');
    const b = h.fromTab('SIGN_MESSAGE', { message: 'same' });
    const windows = h.createdWindows.length;
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect((await a).success).toBe(true);
    expect((await b).success).toBe(true);
    expect(h.createdWindows.length).toBe(windows);
  });

  it('no more than five approval windows a minute, even when each is answered', async () => {
    // Connecting opened the first one
    let refused: any;
    for (let i = 0; i < 8 && !refused; i++) {
      const sent = h.fromTab('SIGN_MESSAGE', { message: `m${i}` });
      const r = await Promise.race([sent, new Promise(res => setTimeout(() => res(null), 50))]);
      if (r) { refused = r; break; }
      const req = await h.waitForPending('sign_message');
      await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req.id });
      await sent;
    }
    expect(refused?.success).toBe(false);
    expect(refused?.error).toMatch(/too many requests/i);
    expect(h.createdWindows.length).toBe(5);
  });

  it('another site is not held up by the first one\'s waiting request', async () => {
    h.fromTab('SIGN_MESSAGE', { message: 'one' });
    await h.waitForPending('sign_message');
    const { connectionManager } = await import('./connection-manager');
    const other = connectionManager.requestConnection('https://other.example', 'x');
    other.catch(() => {});
    const all = connectionManager.getAllPendingRequests();
    expect(all.map(r => r.origin).sort()).toEqual(['https://app.divi.domains', 'https://other.example']);
  });
});

describe('M5 Connect grants only the address', () => {
  it('a new connection holds view_address and nothing else', async () => {
    expect(storedPermissions(h)).toEqual(['view_address']);
  });

  it('the first approved signature adds sign_message, and marks the request as a first use', async () => {
    const signed = h.fromTab('SIGN_MESSAGE', { message: 'hi' });
    const req = await h.waitForPending('sign_message');
    const listed = await h.approvalWindow('GET_PENDING_SIGNING_REQUESTS');
    expect(listed.data.requests.find((r: any) => r.id === req.id).firstUse).toBe(true);
    await h.approvalWindow('APPROVE_SIGNING_REQUEST', { requestId: req.id, password: TEST_PASSWORD });
    expect((await signed).success).toBe(true);
    expect(storedPermissions(h).sort()).toEqual(['sign_message', 'view_address']);

    const again = h.fromTab('SIGN_MESSAGE', { message: 'again' });
    const req2 = await h.waitForPending('sign_message');
    const listed2 = await h.approvalWindow('GET_PENDING_SIGNING_REQUESTS');
    expect(listed2.data.requests.find((r: any) => r.id === req2.id).firstUse).toBe(false);
    await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req2.id });
    await again;
  });

  it('a rejected request grants nothing', async () => {
    const signed = h.fromTab('SIGN_MESSAGE', { message: 'hi' });
    const req = await h.waitForPending('sign_message');
    await h.approvalWindow('REJECT_SIGNING_REQUEST', { requestId: req.id });
    await signed;
    expect(storedPermissions(h)).toEqual(['view_address']);
  });

  it('a site that is not connected cannot ask at all', async () => {
    const { connectionManager } = await import('./connection-manager');
    await expect(connectionManager.createSigningRequest('sign_message', 'https://other.example', 'x', {}))
      .rejects.toThrow(/not connected/i);
  });

  it('the connect screen says what Connect does and does not allow', () => {
    const src = readFileSync(new URL('../popup/signing-request-ui.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/cannot sign or send anything without asking you/);
    expect(src).not.toMatch(/request approvals\?/);
  });
});

describe('M5 Approve ignores clicks that land as the window appears', () => {
  const src = readFileSync(new URL('../popup/signing-request-ui.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('showing a request arms Approve after a delay', () => {
    expect(src).toMatch(/APPROVE_DELAY_MS = \d{3,}/);
    expect(src).toMatch(/showView\(elements\.view\);\s*armApprove\(\);/);
  });

  it('handleApprove refuses before the delay, which also covers Enter', () => {
    const body = src.slice(src.indexOf('async function handleApprove'));
    expect(body.slice(0, 200)).toMatch(/if \(Date\.now\(\) < armedAt\) return;/);
  });

  it('losing focus disarms Approve and coming back re-arms it', () => {
    expect(src).toMatch(/addEventListener\('blur', \(\) => \{ if \(currentRequest\) disarmApprove\(\); \}\)/);
    expect(src).toMatch(/addEventListener\('focus', \(\) => \{ if \(currentRequest\) armApprove\(\); \}\)/);
  });
});
