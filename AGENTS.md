# Agent notes

- **No WalletConnect / Reown, ever.** Divi uses its own dApp connection mechanism
  (the injected `window.irondivi` provider plus the web wallet's `DIVI_SIGN_*` bridge).
  Read [ADR 0001](docs/decisions/0001-no-walletconnect.md) before touching dApp
  connectivity. `src/no-walletconnect.test.ts` enforces it.
- Architecture decisions live in `docs/decisions/`. Add a new ADR rather than
  reversing one silently.
