import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHarness } from '../test-support/harness';

// Safari can open the approval window at full-screen size whatever size was
// asked for. The background asks again, and the wallet stays wallet-sized.

describe('the approval window is wallet-sized', () => {
  it('a window opened at the wrong size is resized to 400 by 600', async () => {
    vi.resetModules();
    const h = await createHarness();
    await h.setupWallet();
    h.openWindowsAt = { width: 1800, height: 1100 };
    void h.provider().connect();
    await vi.waitFor(() => expect(h.windowUpdates).toHaveLength(1));
    expect(h.windowUpdates[0]).toMatchObject({ id: h.createdWindows.at(-1)!.id, width: 400, height: 600 });
  });

  it('a window opened at the size asked for is left alone', async () => {
    vi.resetModules();
    const h = await createHarness();
    await h.setupWallet();
    void h.provider().connect();
    await vi.waitFor(() => expect(h.createdWindows).toHaveLength(1));
    await new Promise(r => setTimeout(r, 20));
    expect(h.windowUpdates).toHaveLength(0);
  });

  it('views and dialogs fill the wallet, not a bigger window', () => {
    const css = readFileSync(new URL('../popup/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/#app \{[^}]*position: relative;/);
    expect(css).toMatch(/body \{[^}]*width: 360px;[^}]*margin: 0 auto;/);
  });
});
