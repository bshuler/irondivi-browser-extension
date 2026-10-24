import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickRequest } from './signing-request-ui';

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
    for (const name of ['handleApprove', 'handleReject']) {
      const fn = body(name);
      const sends = fn.match(/await sendMessage\(/g) ?? [];
      const checked = fn.match(/const response = await sendMessage\([\s\S]*?\}\);\s*(\/\/.*\n\s*)*if \(!response\?\.success\) throw/g) ?? [];
      expect(sends.length).toBeGreaterThan(0);
      expect(checked).toHaveLength(sends.length);
    }
  });
});
