import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Regression tests for the security review's L12 and L13, and EXT-20/21:
// provider.js had a fixed URL any site could probe for, every page got the
// content script, and release builds shipped source maps

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('L12, EXT-20/21 no page can find or load the wallet\'s scripts', () => {
  for (const name of ['manifest.json', 'manifest.firefox.json', 'manifest.safari.json']) {
    it(`${name} declares no content script for every page and no web-accessible file`, () => {
      const m = JSON.parse(read(name));
      expect(m.web_accessible_resources).toBeUndefined();
      expect(m.content_scripts).toBeUndefined();
    });
  }

  it('the provider is registered in the page\'s own world, not loaded from a URL', () => {
    const src = read('src/background/site-scripts.ts');
    expect(src).toMatch(/world: 'MAIN'/);
    expect(read('src/content/content-script.ts')).not.toMatch(/getURL|createElement\('script'\)/);
  });
});

describe('every browser loads the background as the ES module it is built as', () => {
  // Safari's override once replaced the background without "type": "module",
  // so Safari never ran it: the popup stuck on "Loading..." and no site could
  // find the wallet. esbuild.config.js shallow-merges each override.
  for (const name of ['manifest.firefox.json', 'manifest.safari.json']) {
    it(`${name} keeps "type": "module"`, () => {
      const merged = { ...JSON.parse(read('manifest.json')), ...JSON.parse(read(name)) };
      expect(merged.background.type).toBe('module');
    });
  }

  it('the background is built as ESM', () => {
    expect(read('esbuild.config.js')).toMatch(/format: 'esm'/);
  });
});

describe('L13 release builds ship no source maps', () => {
  it('source maps follow the dev flag, and each build starts from an empty folder', () => {
    const src = read('esbuild.config.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/sourcemap: isDev\b/);
    expect(src).toMatch(/rmSync\(outdir, \{ recursive: true, force: true \}\)/);
  });
});
