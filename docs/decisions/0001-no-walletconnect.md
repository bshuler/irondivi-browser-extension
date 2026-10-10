# ADR 0001: No WalletConnect, use Divi's own connection mechanism

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Bert Shuler
- **Scope:** this extension and every Divi wallet (`divi-infrastructure/divi-wallet`,
  the NFT marketplace's `wallet-bridge.ts`, any future dApp integration)

## Ruling

Divi wallets do **not** use WalletConnect, Reown WalletKit, Reown AppKit or any other
`@walletconnect/*` / `@reown/*` package. dApp connection and signing go through
Divi's own mechanism, described below. Do not reintroduce WalletConnect, not even
as an optional or default-off feature, without a new ADR that supersedes this one.

## Context (verified facts)

- **Divi's own mechanism exists and is live.** The web wallet at
  `https://services.divi.domains/wallet/` speaks a `postMessage` protocol:
  `DIVI_SIGN_REQUEST` → `DIVI_SIGN_RESPONSE` / `DIVI_SIGN_CANCEL`, keyed by a
  `requestId` and checked against a strict origin allowlist. It is implemented in
  `divi-infrastructure/divi-wallet/lib/messaging.js` (added 2026-02-16, before the WalletConnect prototype) and
  used by `divi-infrastructure/nft-marketplace/frontend/src/services/wallet-bridge.ts`.
  The marketplace tries, in order: the browser-extension injected provider, then
  the web-wallet popup bridge, then manual input. No third-party relay is involved.
- **WalletConnect was tried and not shipped.** It was prototyped in
  `divi-wallet` from 2026-03-23 to 2026-03-24 (commits `cb93fa2`, `1683859`,
  `41f0744`, `a66ce91`, `41b308c`, `90b75e6`) and not adopted. A build of it was
  found still deployed on the services testnet wallet and removed on 2026-10-05
  (see `divi-infrastructure/docs/runbooks/divi-wallet-deploy.md`). The
  mainnet web wallets contain no WalletConnect code.
- **The Reown project is unused.** Reown Cloud project
  `d76f568633ae643cf0455df1caff8b59` exists with no allowed domains. Nothing
  production-facing uses it.
- **This extension inherited WalletConnect code** from the Divi extension it was
  forked from (`src/background/walletconnect.ts`, `src/popup/walletconnect-ui.ts`,
  Node shims in the build). It was removed on 2026-10-05. The background bundle
  dropped to about 290 KB and carries no Node polyfills.

## Rationale

WalletConnect's value is its ecosystem of dApps and its relay network. Divi uses
its own `divi:` chain namespace, so it gets none of the ecosystem, but still takes
on a third-party relay, a vendor account, an origin allowlist kept on someone
else's dashboard, and a large dependency tree in a wallet that holds keys. The
DIVI_SIGN bridge and the injected provider cover the same need with code we own.

## Consequences

- dApps integrate with the extension through `window.irondivi` (see `src/injected/provider.ts`).
  For the web wallet, they use the DIVI_SIGN bridge.
- **Enforcement:** `src/no-walletconnect.test.ts` runs with `npx vitest run` locally and with `npm run check:remote` on hp2 (`scripts/remote-check.sh`); run it before every push. It fails if
  `package.json` declares a WalletConnect/Reown dependency or if any file under
  `src/` references one.
