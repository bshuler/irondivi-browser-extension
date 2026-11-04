# ADR 0002: Safari build stays ad-hoc signed until artwork lands

- **Status:** Accepted
- **Date:** 2026-10-10
- **Decided by:** human
- **Scope:** the Safari target (`scripts/safari.sh`, `npm run build:safari:app`)

## Ruling

The Safari build is signed **ad-hoc** ("sign to run locally") and is a local
install only: Safari > Develop > Allow Unsigned Extensions, then Settings >
Extensions. No Apple team, bundle id or distribution channel is committed to.
Revisit this ADR once issue #1 (real IronDivi artwork) is closed; the choice
made then (Mac App Store under a team, or Developer ID + notarization) becomes
permanent on first submission and must supersede this ADR.

## Context (verified facts)

- Safari only loads web extensions packaged inside a signed macOS app. The
  converter path works: `dist/safari` → Xcode project → `IronDivi Wallet.app`,
  and the ad-hoc app registers `domains.divi.irondivi.Extension` with macOS
  (pluginkit). It has not yet been enabled or exercised inside Safari.
- Two Apple identities exist on the build Mac under two different teams:
  Apple Development (F56QS6SHKK) and Apple Distribution (VGX52CQGPT). Neither
  is a Developer ID certificate, so a notarized download is not possible today.
- Automatic signing with F56QS6SHKK failed locally: no account is added in
  Xcode > Settings > Accounts and no "Mac Development" private key was found.
- The other three browsers are also not end-user installable yet (Chrome/Edge
  load-unpacked only, Firefox .xpi unsigned), so Safari is not the long pole.

## Consequences

- `SAFARI_SIGN` defaults to `adhoc`; the team path in `scripts/safari.sh` stays
  available but unused.
- DEPLOY.md keeps Safari out of the vps1 download set.
