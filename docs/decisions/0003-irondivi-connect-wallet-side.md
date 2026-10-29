# ADR 0003: The extension is an IronDivi Connect wallet, in the page and over the relay

- **Status:** Accepted
- **Date:** 2026-10-25
- **Decided by:** human (protocol: irondivi-connect ADR 0001)
- **Scope:** this extension's in-page provider (`window.irondivi`), its relay
  client (`src/background/connect-relay.ts`, `src/lib/irondivi-connect.ts`)
  and the pairing screen in Settings
- **Builds on:** [ADR 0001](0001-no-walletconnect.md) (no WalletConnect) and
  `irondivi-connect` `docs/adr/0001-irondivi-connect.md`, which defines the
  protocol in `SPEC.md` v1

## Ruling

The extension implements the wallet side of IronDivi Connect v1 over both
transports the spec defines, and nothing else:

1. **In the page.** `window.irondivi` answers the v1 methods. The browser
   vouches for the page's origin, so this is the transport for anything that
   needs to know who is asking.
2. **Over the relay.** The owner pastes a page's `irondivi-connect:v1?...`
   code, or picks a screenshot of its QR code, in Settings > IronDivi Connect.
   The wallet then long-polls the relay named in the code (the default is
   `https://divi.cx/connect`) and answers the same methods through the same
   checks and approval windows as an in-page request.

There is no WalletConnect, Reown or other third-party relay or SDK, as ADR 0001
rules. Do not add a second remote transport without a new ADR.

## The rules the extension keeps

- **The relay origin is a claim.** The site in a code (`o`) is what the page
  says it is. The pairing list marks it "(claimed)", and every approval window
  for a relayed request shows the claimed site and name, the relay host, and
  that the browser did not verify them. Relay requests are granted under the
  key `relay:<o>`, so a relay pairing and the real site's `window.irondivi`
  never share a connection. Blocking or forgetting the site ends its pairings.
- **Networks must match.** A code for the other network is refused when it is
  pasted, and `irondivi_connect` for the other network is refused with 4901.
  A request on a pairing after the owner switched networks is refused with 4901
  too.
- **Memos are attached or the payment is refused (4200).** `sendTransaction`
  puts `memo` (UTF-8, 1 to 512 bytes) unchanged in one OP_RETURN output, shows
  it in the approval window, and checks at signing that the transaction carries
  exactly that memo. A send option the wallet does not know is refused with
  4200, never dropped, because services such as DNSDivi use the memo to know
  what a payment is for.
- **The capabilities contract.** `window.irondivi.capabilities` and the
  connect answer list the options the wallet honours; today that is
  `["memo"]`. A page must not pass an option the list lacks. A new option is
  added to `CAPABILITIES` (`src/shared/provider-errors.ts`) in the same change
  that implements it, never before.
- **Connect first.** Every method but `irondivi_connect` is answered 4100
  until the owner approves the connection.
- **Limits.** At most two relay pairings at once. A pairing lives in
  `storage.session`, so it survives the service worker stopping but not the
  browser closing. An expired code is refused; the expiry does not end a
  pairing already made (SPEC §5). The owner ends one with End in Settings.

## Details a page can rely on

- Identical requests that arrive while one is waiting share one approval
  window and get the same answer.
- `irondivi_getBalance` answers `unconfirmed: "0"`: the wallet keeps no
  separate unconfirmed figure.
- Errors use the spec's codes: 4001, 4100, 4200, 4900, 4901, -32602, -32603.
  The extension adds 4300 (the site must be allowed first) and 4301 (the site
  is blocked) for its site-access rules.

## Consequences

- A page that needs proof of who is asking uses the in-page transport, or has
  the user sign a challenge naming its origin, as the spec's security section
  says.
- The relay client is a port of the reference library and is tested against
  envelopes that library sealed (`src/lib/fixtures/irondivi-connect-v1.json`).
  A change to the protocol is made in `irondivi-connect` first, then ported.
