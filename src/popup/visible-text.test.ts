import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { visibleText } from './visible-text';

// Regression tests for the security review's L7: approval messages were cut
// at 200 characters, and bidi and control characters were not shown

vi.setConfig({ testTimeout: 30000 });

vi.mock('./ui-state', () => ({
  showLoading: () => {}, hideLoading: () => {}, showToast: () => {},
  showView: () => {}, hideView: () => {},
  formatAmount: (n: number) => n.toFixed(8).replace(/\.?0+$/, ''),
}));

// Just enough of a DOM for showSigningRequestView: text and children only,
// so any markup the view tried to inject would show up as literal text
class FakeNode {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  value = '';
  disabled = false;
  classList = { add: (c: string) => { this.className = `${this.className} ${c}`.trim(); } };
  constructor(public tag: string) {}
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) { this.children = nodes; }
  closest() { return null; }
  get innerHTML(): string { throw new Error('innerHTML read'); }
  set innerHTML(_v: string) { throw new Error('innerHTML written'); }
  text(): string { return this.textContent + this.children.map(c => c.text()).join(' '); }
}

let byId: Record<string, FakeNode>;

beforeEach(() => {
  vi.resetModules();
  byId = {};
  (globalThis as any).document = {
    body: { dataset: { network: 'mainnet' } },
    getElementById: (id: string) => (byId[id] ??= new FakeNode('div')),
    createElement: (tag: string) => new FakeNode(tag),
  };
});

async function render(request: any): Promise<FakeNode> {
  const { showSigningRequestView } = await import('./signing-request-ui');
  showSigningRequestView({ id: 'r', origin: 'https://games.divi.domains', accountId: 'a', createdAt: 0, ...request });
  return byId['signing-details'];
}

describe('L7 hidden characters are made visible', () => {
  it('bidi overrides, isolates and marks are shown as markers', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
      const v = visibleText(`a${String.fromCharCode(cp)}b`);
      expect(v.text).toBe(`a⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩b`);
      expect(v.hidden).toBe(1);
    }
  });

  it('control, zero-width and separator characters are shown', () => {
    const v = visibleText('\u0000\u0007\u001b\u007f\u0085\u200b\u200c\u200d\u2060\ufeff\u2028\u2029');
    expect(v.hidden).toBe(12);
    expect(v.text).not.toMatch(/[\u0000-\u0008\u001b\u007f\u0085\u200b-\u200d\u2060\ufeff\u2028\u2029]/);
    expect(v.text).toContain('⟨U+001B⟩');
    expect(v.text).toContain('⟨U+2029⟩');
  });

  it('ordinary text, newlines, tabs and non-Latin scripts are left alone', () => {
    const plain = 'Sign in to games.divi.domains\nNonce:\t42\nПривет 你好 مرحبا 🎲';
    expect(visibleText(plain)).toEqual({ text: plain, hidden: 0 });
  });
});

describe('L7 the approval window shows the whole request', () => {
  it('a long message is shown whole, not cut at 200 characters', async () => {
    const message = 'x'.repeat(5000) + 'THE-END';
    const details = await render({ type: 'sign_message', data: { message } });
    expect(details.text()).toContain(message);
  });

  it('a message with a right-to-left override shows the marker and a warning', async () => {
    const details = await render({ type: 'sign_message', data: { message: 'pay \u202eevil' } });
    const text = details.text();
    expect(text).toContain('pay ⟨U+202E⟩evil');
    expect(text).not.toContain('\u202e');
    expect(details.children.some(c => c.className.includes('hidden-chars'))).toBe(true);
    expect(text).toMatch(/1 hidden or direction-changing character,/);
  });

  it('a clean message has no warning', async () => {
    const details = await render({ type: 'sign_message', data: { message: 'hello' } });
    expect(details.children.some(c => c.className.includes('hidden-chars'))).toBe(false);
  });

  it('markup in a message is shown as text, never parsed', async () => {
    const details = await render({ type: 'sign_message', data: { message: '<img src=x onerror=alert(1)>' } });
    expect(details.text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('the destination and OP_RETURN of a payment are checked too', async () => {
    const details = await render({ type: 'send_transaction', data: { to: 'D\u200babc', amount: 1, fee: 0.00005, opReturn: 'x\u202ey' } });
    const text = details.text();
    expect(text).toContain('D⟨U+200B⟩abc');
    expect(text).toContain('x⟨U+202E⟩y');
    expect(text).toMatch(/2 hidden or direction-changing characters/);
    expect(text).toContain('1.00005 DIVI');
  });

  it('the view no longer builds markup or truncates', () => {
    const src = readFileSync(new URL('./signing-request-ui.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/innerHTML/);
    expect(src).not.toMatch(/substring\(0,\s*200\)/);
  });
});
