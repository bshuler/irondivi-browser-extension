// Empty shim for Node.js `crypto` module.
// The browser already provides `globalThis.crypto` (Web Crypto API).
// WalletConnect SDK does `import "crypto"` as a side-effect import
// just to ensure the crypto global is available in Node; in the browser
// this is unnecessary, so we provide an empty module.
export default globalThis.crypto;
