import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { feeText, pickRequest } from './signing-request-ui';

// Regression tests for the security review's M4: an approval window opened
// for one request showed the first pending request instead when its own was
// gone, so a user could approve another site's request in the wrong window

const reqs = [{ id: 'a' }, { id: 'b' }] as any[];

describe('M4 an approval window shows only its own request', () => {
  it('finds the request it was opened for', () => {
    expect(pickRequest(reqs, 'b')?.id).toBe('b');
  });

  it('shows nothing when its request is no longer pending', () => {
    expect(pickRequest(reqs, 'gone')).toBeUndefined();
    expect(pickRequest([], 'gone')).toBeUndefined();
  });

  it('the plain popup still shows the oldest pending request', () => {
    expect(pickRequest(reqs)?.id).toBe('a');
    expect(pickRequest([])).toBeUndefined();
  });

  it('there is no other path that substitutes the first request', () => {
    const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src.match(/requests\[0\]/g)).toHaveLength(1);
    expect(src).toMatch(/if \(requestId\) return requests\.find/);
  });

  it('rejecting in an approval window closes it instead of loading another request', () => {
    const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8');
    const reject = src.slice(src.indexOf('async function handleReject'));
    expect(reject.slice(0, reject.indexOf('\n}\n'))).toMatch(/boundRequestId \? false : await checkPendingRequests\(\)/);
  });
});

// The approval window showed "Transaction sent successfully" and closed for
// any reply, so a refused password or a failed send looked like a success
describe('the approval window acts on the wallet\'s reply', () => {
  const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8');
  const body = (name: string) => {
    const from = src.slice(src.indexOf(`async function ${name}`));
    return from.slice(0, from.indexOf('\n}\n'));
  };

  it('every approve and reject message checks success before showing it', () => {
    for (const name of ['approveCurrent', 'handleReject']) {
      const fn = body(name);
      const sends = fn.match(/await sendMessage\(/g) ?? [];
      const checked = fn.match(/const response = await sendMessage\([\s\S]*?\}\);\s*(\/\/.*\n\s*)*if \(!response\?\.success\) throw/g) ?? [];
      expect(sends.length).toBeGreaterThan(0);
      expect(checked).toHaveLength(sends.length);
    }
  });
});

// EXT-24: a fee the background did not report was shown as 0.00005 DIVI, so
// the total understated what the payment would cost
describe('EXT-24 a fee that is not known is not guessed', () => {
  it.each([undefined, null, NaN, -1, '0.1', Infinity])('%s is unknown', (fee) => {
    expect(feeText(fee)).toEqual({ text: 'unknown', known: false });
  });

  it('a reported fee, 0 included, is shown as it is', () => {
    expect(feeText(0)).toEqual({ text: '0 DIVI', known: true });
    expect(feeText(0.0002).known).toBe(true);
  });

  it('there is no default fee, and an unknown fee blocks Approve', () => {
    const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/0\.00005/);
    expect(src).toMatch(/if \(!fee\.known\) \{\s*blocked = true;/);
    expect(src).toMatch(/!blocked && !approving\) approveBtn\.disabled = false/);
  });
});

// EXT-6: a second click while the first approval was in flight sent it again
describe('EXT-6 the approval window sends one approval at a time', () => {
  const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8');
  it('handleApprove returns while one is in flight and clears the flag after', () => {
    const fn = src.slice(src.indexOf('async function handleApprove'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/if \(!currentRequest \|\| approving \|\| blocked\) return;/);
    expect(body).toMatch(/approving = true;[\s\S]*finally \{\s*approving = false;/);
  });
});

// EXT-8 and EXT-18: what the approval window shows
describe('EXT-8 and EXT-18 the approval window', () => {
  const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
  it('shows the account it is from, the recipient note and what is left', () => {
    expect(src).toMatch(/detailRow\('From:'/);
    expect(src).toMatch(/recipient-note \$\{request\.recipient\.level\}/);
    expect(src).toMatch(/detailRow\('Left after:'/);
  });

  it('has a place for the security phrase, set as text', () => {
    expect(html).toMatch(/id="signing-security-phrase"/);
    expect(html).toMatch(/id="setting-security-phrase"[^>]*maxlength="40"/);
    const fn = src.slice(src.indexOf('function showSecurityPhrase'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).not.toMatch(/innerHTML/);
  });
});

// The network the wallet is on, on every view, in that network's colour
describe('the network colour bar', () => {
  const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  it('is the first thing in the popup', () => {
    expect(html).toMatch(/<div id="app">\s*(<!--[^>]*-->\s*)?<div class="network-bar"/);
  });

  it('says which network, and follows the network colour', () => {
    expect(css).toMatch(/\.network-bar \{[^}]*background: var\(--accent\)/);
    expect(css).toMatch(/\.network-bar::after \{\s*content: "Mainnet/);
    expect(css).toMatch(/body\[data-network="testnet"\] \.network-bar::after \{\s*content: "Testnet/);
  });

  it('the approval window colours itself by the request\'s network', () => {
    const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/document\.body\.dataset\.network = network;/);
  });
});
