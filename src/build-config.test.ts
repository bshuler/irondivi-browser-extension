import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Regression tests for the security review's L12 and L13: provider.js had a
// fixed URL any site could probe for, and release builds shipped source maps

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('L12 provider.js is not at a fixed URL on Chromium', () => {
  it('the base manifest asks for a per-session URL', () => {
    const [entry] = JSON.parse(read('manifest.json')).web_accessible_resources;
    expect(entry.resources).toEqual(['provider.js']);
    expect(entry.use_dynamic_url).toBe(true);
  });

  for (const browser of ['firefox', 'safari']) {
    it(`${browser} keeps provider.js web-accessible without the Chromium-only key`, () => {
      const [entry] = JSON.parse(read(`manifest.${browser}.json`)).web_accessible_resources;
      expect(entry.resources).toEqual(['provider.js']);
      expect(entry.use_dynamic_url).toBeUndefined();
    });
  }
});

describe('L13 release builds ship no source maps', () => {
  it('source maps follow the dev flag, and each build starts from an empty folder', () => {
    const src = read('esbuild.config.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/sourcemap: isDev\b/);
    expect(src).toMatch(/rmSync\(outdir, \{ recursive: true, force: true \}\)/);
  });
});
