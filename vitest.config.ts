import { defineConfig } from 'vitest/config';

// Unit tests live next to the code as *.test.ts. tests/*.spec.ts are Playwright
// end-to-end tests (`npm test`) and must not be collected by vitest.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Inlined so a test can mock the @noble/hashes functions it calls
    server: { deps: { inline: [/@scure\/bip32/] } },
  },
});
