# Vendored: @divi/electrum-client

`divi-electrum-client.esm.js` is `packages/divi-electrum-client/dist/divi-electrum-client.esm.js`
from divi-infrastructure, branch `ws/electrum-client`, commit
`acdf72f7f9d6b055431b08a8550c4bac8f81f4b3`, copied unchanged. It is the
Electrum-over-WebSocket client and `ElectrumBackend` shared with the web wallet and the
Telegram app. `src/vendor.test.ts` fails if the file's
sha256 differs from the one below, so an edit here is deliberate.

    sha256 93326882ef54fa8e73382eede225f844a0a279049ab76bbd983a59c51e4c1904

To update: rebuild the package (`npm run build` there), copy `dist/divi-electrum-client.esm.js`
over this file, change the commit and sha256 here and in `src/vendor.test.ts`.
`divi-electrum-client.esm.d.ts` is ours: it only types what the extension uses.
