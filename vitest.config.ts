import { defineConfig } from 'vitest/config';

// Unit tests live next to the code as *.test.ts. tests/*.spec.ts are Playwright
// end-to-end tests (`npm test`) and must not be collected by vitest.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // setupWallet derives keys with the real KDF; with every file running at
    // once a beforeEach can take longer than the 10 s default
    hookTimeout: 30000,
    // Inlined so a test can mock the @noble/hashes functions it calls
    server: { deps: { inline: [/@scure\/bip32/] } },
  },
});
