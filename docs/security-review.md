# IronDivi Wallet — Adversarial Security Review

**Reviewed:** the worktree `scratchpad/ext` at HEAD `43aa060`. Some changes in the working tree were not yet committed; where one of them matters, the finding says so.

**How it was reviewed:**
- The code was read: manifests, build, docs/decisions, all of `src/` except the wordlists, and the tests.
- Offline probes were run from `scratchpad/review/review.test.ts` (vitest, 15 tests, all passing).
- No network calls were made. No real keys were used: only random throwaway keys, which were never printed, plus public test vectors.

## Executive summary

The cryptographic primitives are sound:
- SHA-256 and RIPEMD-160 match Node on fuzzed inputs.
- BIP39, the BIP32 vectors 1 and 2, the RFC 6979 vectors, low-S, strict DER, and Base58Check addresses all pass.
- Messaging trust boundaries and XSS escaping in the approval UI are well built.

The serious problems are in how the wallet trusts its RPC node and in what it fails to check before signing.

1. **Critical (C1).** The wallet serialises node-supplied UTXO fields into the unsigned transaction with no framing checks. It then re-parses that hex, and the parser ignores trailing bytes. It signs whatever the re-parse yields, without comparing it to what the user approved. As a result, whoever controls the RPC endpoint can get the wallet to sign a transaction of their own design on the user's next send. That covers a compromised `services.divi.domains`, its operator, or anyone who can impersonate it. The approval UI keeps showing the user's intended recipient and amount. The two parser weaknesses were verified by running; the end-to-end consequence was inferred from reading.
2. **High.**
   - Nothing caps the fee, which a dApp can choose. The fee is also left out of every spending limit (verified: a 900 DIVI fee was accepted).
   - Legacy SIGHASH_ALL does not commit to input amounts, and the wallet trusts the node's UTXO amounts. A lying node can therefore silently inflate the real fee, and can fake the balance to defeat the percentage limit.
   - The daily limits in Settings are never enforced.
   - Imported recovery phrases are validated after normalisation but turned into a seed without it. A phrase with capitals, double spaces or newlines imports "successfully" but derives a wallet no other BIP39 wallet can recover (verified).
3. **Medium.** These are mostly defence-in-depth gaps:
   - the content script on every site can read `storage.local`, which holds the encrypted vault;
   - the session key-wrapping key is not secret;
   - the unconfirmed new-account mnemonic and password sit in plaintext in session storage and are shown again without a password;
   - an approval window can show a different request from the one it was opened for;
   - nothing limits how many approval windows can open, and the Connect window needs no password;
   - all of `*.divi.domains` is trusted by default;
   - the popup's send confirmation shows a truncated address;
   - at HEAD, Firefox fell back to persistent storage for session secrets (fixed in the uncommitted working tree).

**Recommendation.** Do not put mainnet funds in this wallet until C1 and H1–H4 are fixed. The single most important fix is to validate every RPC field strictly and to compare the parsed transaction to the approved intent just before signing.

## Fix status

Fixes land in `bshuler/irondivi-browser-extension` on `main`. Each one has regression tests that fail on the old code.

| Finding | Status | Commit | Tests |
|---|---|---|---|
| C1, H1, H2, H3, M9, L4, L5 | Fixed | 04039f2 | `send-security.test.ts`, `wallet-core.test.ts` |
| H4 | Fixed | 54dcd7f | `import-security.test.ts` |
| M10 | Fixed | 5125ecd | the live Firefox run (no unit test) |
| M1, M11 | Fixed. M1 was incomplete (it held only on Chromium 140+) and is completed by EXT-3 below | da46c0c, 36d3414, 7edb478 | `injection-security.test.ts`, `site-scripts.test.ts`, `records-seal.test.ts` |
| M2 | Fixed: the unlocked phrase is held only in the background's memory. A worker restart, or the timeout even without the alarm, locks the wallet, and an unlock deletes what older versions stored | c3e6b6a | `session-security.test.ts` |
| M3 | Fixed: a wallet being created keeps its phrase in session storage only encrypted with the chosen password, and the password is never stored. Resuming asks for the password, an approval window never resumes a setup, and a plain-text record from an older version is deleted | 750d25a | `pending-account.test.ts` |
| M4 | Fixed: an approval window shows only the request it was opened for; if that one is gone it says so and closes. Rejecting there closes the window instead of loading another site's request | 98bf5e5 | `signing-request.test.ts` |
| M5 | Fixed: a site may have one request waiting and open five approval windows a minute. Connect grants only the address; signing and sending are granted by the first password approval of each, which is marked as a first use. Approve does nothing until the window has been in front for 600 ms, and leaving the window disarms it | a5f7ed2 | `approval-flood.test.ts` |
| M6 | Fixed: the default list names `games.divi.domains` and `services.divi.domains` exactly, with no wildcard. `localhost` and `127.0.0.1` are allowed only in a development build (`npm run build:dev` or `npm run watch`). A wallet that stored the 0.0.3 default gets the new one; a list the user changed is kept | 86cf1ec | `allowed-sites.test.ts` |
| M7 | Fixed: the confirm screen shows the whole address in groups of four. It names a saved contact, says so when the address is your own, warns when the address is not in your contacts, and gives a red warning when it starts and ends like a contact but differs in the middle. Server transaction history is not used to vouch for an address | 871f1fc | `recipient-check.test.ts` |
| M8 | Fixed: unlock waits for the upgrade. The new blob is decrypted and checked against the phrase before it is written, and it replaces the old one only if the old one is still what is stored. Every change to the secrets map now runs one at a time, so a migration can no longer put back a deleted secret or drop a new one. A separate pointer key was not needed: one `storage.local.set` replaces the map whole, so a crash leaves the old blob or the new one | d98e70c | `secret-migration.test.ts` (5 of its 7 tests fail on the old code) |
| L1 | Fixed: patterns are matched label by label. `*.` is exactly one label, `**.` one or more, and neither matches the bare domain. A pattern without a port allows only the default port; `:8080` allows that port and `:*` any. `?` is no longer a wildcard. Over-broad patterns such as `*.com`, malformed ones and more than 50 are refused; an invalid pattern matches nothing | a8d8810 | `site-patterns.test.ts` |
| L2 | Fixed: UPDATE_SETTINGS takes only known keys with checked values, and allowing a new site, raising or removing a limit, or a longer lock time needs the password. The popup checks the sites list and asks for the password first | 39e941d | settings-security.test.ts |
| L7 | Fixed: the approval window shows the whole message in a scrollable box, built from text nodes with no innerHTML. Control, bidi, zero-width and separator characters in the message, address, destination and OP_RETURN are shown as ⟨U+XXXX⟩ with a warning row. Completed by EXT-10 below: a message must be text of 1 byte to 8 KB | 7fb2aea, eb101c6 | visible-text.test.ts, approval-security.test.ts |
| L8 | Fixed: `importAccount`, the only path that encrypts a phrase, refuses a password that is not a string of at least 8 characters before anything is derived or stored | 347ab5b | account-input.test.ts |
| L9 | Fixed: `addContact` refuses an unknown network and any address that `Address.validate` rejects for the contact's own network; names and notes are type- and length-checked on add and update, and an update still cannot change the address | 347ab5b | account-input.test.ts |
| L10 | Fixed: every password check (unlock, approve, verify, export, delete, new address, network set-up) goes through `unlockSecret` in unlock-limit.ts, which keeps the count in `storage.local` so a browser or worker restart does not reset it. Attempts run one at a time, so parallel guesses cannot pass the limit; unknown account ids are not counted; the tier is kept for 24 h after the last failure; a lockout read from storage is capped at 24 h. Residual: setting the system clock forward ends a lockout early, since an extension has no monotonic clock that survives a restart | 60aac9d | rate-limit.test.ts |
| L3 | Fixed: sending wipes the master key and every derived key (private key and chain code), not only the input keys; `derive()` wipes the keys part way down the path; `deriveChild` wipes its HMAC input and output; signing a message, adding an address, and creating, importing or setting up an account wipe their seed. Residual: `addPrivateKeys` works through BigInt, and JavaScript cannot wipe a BigInt | 18a8412 | key-wipe.test.ts |
| L6 | Fixed: the Copy Words button is gone and the phrase modal says why: other apps can read the clipboard, and clipboard history keeps it after it is cleared | ce616f5 | recovery-phrase.test.ts |
| L11 | Fixed: the input script is rebuilt from the coin's own address with `p2pkhScript(input.address)`; the script the node reports is ignored | 04039f2, e96efa6 | send-security.test.ts |
| L12, L13 | Fixed: on Chrome and Edge, provider.js is served at a URL that changes each session (`use_dynamic_url`), so a site cannot probe a fixed path to learn the wallet is installed; Firefox and Safari already use a random per-install id. Source maps are written only for a dev build, and each build empties its output folder first | 48d674d | build-config.test.ts |
| L14 | Fixed: every dependency is pinned to an exact version that matches the lockfile, `.npmrc` saves new ones exactly, and packaging writes `SHA256SUMS-v<version>` for every package. Residual: the extension is not yet in the browser stores, so it has no store review or auto-update. Completed by EXT-19 and EXT-1 below: the checksum file is signed and `deploy.sh` refuses an unsigned release; the release key waits for the owner's approval | c0a63e9, a2cf867, d8ecd67 | supply-chain.test.ts, release-signing.test.ts |
| L15 | Fixed: popup message signing takes an account id and refuses it unless the session unlocked that account; it signs from an address the account owns on its own network and returns that address. Completed by EXT-7 below: dApp signing checks the session's account too | ffa421f, 9245ef7, e0a33b3 | sign-message-account.test.ts, approval-security.test.ts |
| I2, I3 | Fixed: `isValidPrivateKey` checks that a key is 32 bytes from 1 to n - 1. Transaction and message signing refuse any other key and refuse s = 0; BIP32 refuses a master key outside that range, IL of n or more, and a child key of 0 | 7f40d75 | key-range.test.ts |
| T1 | Fixed: the approval window checks the wallet's reply to approve and reject, and shows an error and keeps the window open when it is refused | 25f0b53 | signing-request.test.ts, dapp-security.spec.ts |
| I1, I4, I5, I6, I7 | Accepted as they stand; see each finding for why | | |

Checked against the live networks on 2026-10-24:
- H2's check needs the node's raw transaction to hash to the txid it reports. On mainnet and testnet, every transaction in the last 15 blocks of each, 62 in all and including coinbase and coinstake, parses and re-serialises byte for byte, and hashes to its txid. Divi's `baretxid` is a different hash and is not used.
- H4 normalises at the import boundary: the phrase is normalised, then validated, then stored, so `Mnemonic.toSeed` only ever sees the canonical form. `toSeed` itself stays plain BIP39, because normalising inside it would change the seed of a wallet imported before the fix.

## Second review (2026-10-25): EXT-1 to EXT-31

A second adversarial review of `main` at `4d84d32` found no Critical or High issue, and 4 Medium, 14 Low and 13 Info findings (EXT-1 to EXT-31). It also found four fixes above incomplete: M1, L7, L14 and L15. Each fix below has regression tests that fail on the old code.

| Finding | Status | Commit | Tests |
|---|---|---|---|
| EXT-1 Install path turns off browser integrity checks; checksums unsigned | Fixed in code: `scripts/sign-release.sh` signs `SHA256SUMS-v<version>` through the 1Password SSH agent, so the key never touches disk; `scripts/verify-release.sh` checks the signature and every package; `deploy.sh` refuses an unsigned release and publishes the `.sig`; the page no longer tells Firefox users to turn off `xpinstall.signatures.required`. The release key itself and its published fingerprint wait for the owner's 1Password approval, and store listings (signed, auto-updating installs) need the owner's store accounts | d8ecd67 | release-signing.test.ts |
| EXT-2 Sends and signatures need no password inside the auto-lock window | Fixed: every send and signature carries the password; the wallet locks when its last window closes and when the screen locks | 593fedc, 7654b11 | session-security.test.ts, send-security.test.ts, sign-message-account.test.ts, injection-security.test.ts |
| EXT-3 M1 works only on Chromium 140+; unencrypted records can be changed | Fixed: the wallet's scripts run only on allowed sites, and accounts, settings, connections and contacts are sealed with an HMAC key kept inside the encrypted secret; changes made outside the wallet are undone on unlock, and a failed `setAccessLevel` is reported | 36d3414, 7edb478 | site-scripts.test.ts, records-seal.test.ts, unlock-retry.test.ts |
| EXT-4 `signMessage` is the Divi Games spend key but shown as plain text | Fixed: `signGameTx` shows a game transaction as a transaction (kind, recipient, amount, token), only for the Divi Games origin, and `signMessage` refuses text that parses as one | e68435e | game-tx-signing.test.ts, game-tx.test.ts |
| EXT-5 A site learns the spendable balance | Fixed: a site gets one plain refusal for over-limit and over-balance payments | a3b3f12 | approval-security.test.ts |
| EXT-6 A second approval can run while the first is in flight | Fixed | 813f128, 2b92fe0 | approval-security.test.ts, signing-request.test.ts |
| EXT-7 dApp signing does not check the session's account (L15 residual) | Fixed | e0a33b3 | approval-security.test.ts |
| EXT-8 The approval window hides the paying account and skips recipient checks | Fixed | 61caf4b | approval-context.test.ts, signing-request.test.ts |
| EXT-9 CONNECT can return another account's address | Fixed | c19d20a | approval-security.test.ts |
| EXT-10 `sign_message` takes any type and length (L7 residual) | Fixed: text of 1 byte to 8 KB | eb101c6 | approval-security.test.ts |
| EXT-11 Connections are not scoped to a network | Fixed | 12d4e0a | approval-security.test.ts, approval-flood.test.ts |
| EXT-12 Packaging ships a development build | Fixed | 724d448 | packaging.test.ts |
| EXT-13 deploy.sh stages through fixed `/tmp` names | Fixed | 703a5af | deploy.test.ts |
| EXT-14 Builds are not reproducible | Fixed: a release rebuilds byte for byte and `releases.json` names its commit. Residual: the Safari zip (Xcode output) is not reproducible | 35e87ea | packaging.test.ts, supply-chain.test.ts |
| EXT-15 The RPC host is also a default dApp | Fixed in the extension: `services.divi.domains` is no longer a default site. Moving the RPC off the VPS that hosts the other trust roles is infrastructure work | 7eac1b5 | allowed-sites.test.ts |
| EXT-16 Limits use the node's balance and default to nearly none | Fixed: a 25% daily limit by default, percentages of the highest balance seen | 6801549 | send-security.test.ts, settings-security.test.ts |
| EXT-17 Hand-rolled secp256k1, no BIP32 vectors | Fixed: pinned `@noble/secp256k1`, `@scure/bip32`, `@scure/bip39`; BIP32/BIP39 vectors and fixtures from 0.0.4 wallets, whose addresses and signatures do not change | c2ae7b7 | vectors.test.ts, key-range.test.ts |
| EXT-18 A site can open a look-alike approval window | Fixed: approval windows show the owner's security phrase | 153cbd3 | approval-context.test.ts, signing-request.test.ts |
| EXT-19 The supply-chain test fails at HEAD | Fixed | a2cf867 | supply-chain.test.ts |
| EXT-20 Firefox serves `provider.js` at a fixed per-install URL | Fixed: it is injected only on allowed sites | 36d3414 | site-scripts.test.ts, build-config.test.ts |
| EXT-21 The content script wakes the worker on every page | Fixed: it runs only on allowed sites | 36d3414 | site-scripts.test.ts |
| EXT-22 The faucet reply is not validated | Fixed | 7772ced | faucet.test.ts |
| EXT-23 The unlock limiter can lock the owner out | Fixed: lockouts last at most 15 minutes, and new passwords need 12 characters or a strong passphrase | 26642da | rate-limit.test.ts, password-strength.test.ts, extension.spec.ts |
| EXT-24 The approval window shows a made-up fee | Fixed | 813f128 | signing-request.test.ts |
| EXT-25 Amounts pass through `Number` | Fixed: amounts are parsed to satoshis exactly | d760c16 | amounts.test.ts |
| EXT-26 The decrypted phrase is copied into strings | Fixed: the unlocked seed is kept as bytes. Residual: the phrase string exists briefly at unlock | c0e8e58 | session-seed.test.ts, key-wipe.test.ts |
| EXT-27 Coins spent in the mempool are offered again | Fixed. Residual: coins of a dropped transaction stay locked for up to 24 h | 0375e27 | pending-spends.test.ts |
| EXT-28 In-page provider spoofing | Fixed: requests go over a private MessageChannel port. Residual: if the content script never runs, a page could take the port by sending `irondivi:ready` first; `window.irondivi` still shares the page's trust | 741e2b0 | provider-channel.test.ts, dapp-security.spec.ts |
| EXT-29 The Divi Games SDK keeps a session key in `localStorage` | Fixed in `divi_games` (not this repository): 8bcd8aa keeps the session key in the tab's `sessionStorage` for one day and deletes the old `localStorage` entry; 89410d1 caps what a session key can stake at 5000 GOLD; the chain still refuses withdrawals signed by a session key | divi_games 8bcd8aa, 89410d1 | divi_games tests |
| EXT-30 The test image is pinned by tag | Fixed: pinned by sha256 digest | 7825235 | supply-chain.test.ts |
| EXT-31 The download page loads Google Fonts | Fixed: fonts are self-hosted and the CSP allows only the site. Residual: only the Latin subset is hosted | bbd9e8e | deploy.test.ts |

Also changed in this round:
- A coloured bar across the top of the popup and approval windows names the network (d862735, signing-request.test.ts).
- The popup opens even when the browser cannot connect a port to the background (86c399e).
- Until the store reviews are done, sites may use the wallet on testnet only. On mainnet a site can read the network, and nothing else; the owner can still use mainnet from the popup (de92354, testnet-only.test.ts).

The four incomplete fixes are now complete:
- **M1** by EXT-3: the scripts run only on allowed sites, and the records are sealed.
- **L7** by EXT-10.
- **L14** by EXT-19 and EXT-1. The release key's approval and the store listings are still pending.
- **L15** by EXT-7.

Residual risks that remain after these fixes:
- **Rollback.** Someone who can write `storage.local` can put back an older encrypted blob together with its seal. Nothing on the machine records which version is current.
- **First unlock after the upgrade.** The first unlock seals whatever records are stored at that moment, trusting them on first use.
- **Deleting a secret.** Deleting the encrypted secret denies the owner the wallet until they restore it from the phrase. The spend ledger and cached balances are not sealed, so changing them only affects the limits shown, not what is signed.
- **Safari and Firefox storage.** `storage.session` is visible to content scripts there. The wallet's scripts now run only on allowed sites.
- **Addresses.** Every unlock derives the addresses again, and at most 1000 addresses per network are kept.
- **Chinese phrases.** Some phrases are valid in both Chinese wordlists. Either one gives the same seed.
- **Reconnecting.** Connections made before networks were recorded must be made again.
- **The security phrase.** The approval windows show a security phrase, which is stored unencrypted: it only helps the owner spot a fake window.
- **Releases.** `releases.json` is replaced at each release, so each release is tagged in git.
- **Mainnet in the popup.** The testnet-only rule covers sites, not the popup.

## Findings

### Critical

#### C1. A malicious RPC node can get an attacker-designed transaction signed (unframed txid plus a lenient re-parse)

**Location:**
- `src/background/rpc-client.ts:173-177`: UTXO fields are copied unvalidated.
- `src/lib/transaction.ts:143`: `toHex` writes `reverseHex(input.txid)` with no length check.
- `src/lib/transaction.ts:26-131`: `fromHex` never checks that it consumed the whole buffer.
- `src/background/wallet-core.ts:216-257`: `signTransaction` re-parses `built.hex` and signs the parsed result.
- `src/background/service-worker.ts:76-101`: `sendFromAccount` broadcasts with no comparison to the request.

**Attack scenario:**
- **Attacker:** whoever controls the JSON-RPC responses. That means the operator of `services.divi.domains`, anyone who compromises that host or its TLS (a mis-issued certificate, or a CDN or proxy in front of it), or a future user-configurable RPC.
- **Action:** the victim makes any ordinary send, from the popup or an approved dApp request. The attacker answers `getaddressutxos` with a UTXO whose `txid` string is not 64 hex characters but carries extra bytes.
  - Those bytes go straight into the serialised input with no length prefix.
  - `fromHex` reads the stream front to back, stops when it has a complete transaction, and drops the wallet's real outputs as trailing junk.
  - The wallet hands each parsed input the private key it derived for the selected UTXOs. The `pubKeyHash` used in the sighash also comes from the parsed, node-supplied script.
  - The signature is therefore valid for the attacker-shaped transaction, which is then broadcast, to the attacker's own node.
- **Gain:** the attacker chooses the outputs and can spend any of the victim's coins held under the keys being used. The user saw and approved only their own recipient and amount.

**Evidence:**
- Verified by running (`review.test.ts`, "parser robustness"):
  - `Transaction.fromHex` accepts a transaction with trailing bytes (`trailingBytes: accepted`);
  - `buildTransaction` accepts a txid of 66 bytes and of 1 byte (`txid66bytes: accepted`, `txid1byte: accepted`).
- Inferred from reading: the full chain from a crafted RPC response to a signed attacker transaction. On purpose, no end-to-end exploit transaction was built.

**Fix (all of these):**
1. In `rpc-client.getUtxos`, strictly validate each UTXO:
   - `txid` matches `/^[0-9a-f]{64}$/i`;
   - `outputIndex` is an integer from 0 to 2³²−1;
   - `satoshis` is a safe integer greater than 0;
   - `script` is exactly the P2PKH for `address`, where `address` is one of the account's own addresses. Rebuild the script locally rather than trusting it.
2. In `Transaction.toHex`, assert that `txid` is 64 hex characters and that script hex has even length.
3. In `fromHex`, throw if `offset !== buf.length` after the locktime.
4. Do not sign by re-parsing a hex string. Keep the structured `Transaction` from `buildTransaction` and sign that object.
5. Just before signing, assert that:
   - the outputs are exactly `[to: amount]` plus optional change to one of the user's own addresses;
   - every input outpoint is one of the selected UTXOs;
   - the fee equals the inputs minus the outputs and is within a cap (see H1).

   Use the derived address's own `pubKeyHash`, never the script supplied with the input.

### High

#### H1. No fee cap; a dApp sets the fee, and the fee is outside every limit

**Location:**
- `src/background/wallet-core.ts:79-86`: the fee is only checked to be finite and ≥ 0.
- `src/background/service-worker.ts:361-405`: SEND_TRANSACTION passes `fee` through from the dApp.
- `src/background/service-worker.ts:53-63`: limits test `request.amount` only.

**Attack scenario:**
- **Attacker:** a malicious or compromised connected dApp.
- **Action:** it requests a 1 DIVI send with `fee: 900`. The approval UI does show the fee, but users anchor on the amount and the recipient.
- **Gain:** the user burns their balance to miners. A dApp that mines, or is colluding with a miner, captures it.
- **Bypass:** absolute and percentage limits never see the fee, so a user who set "max 10 DIVI per tx" is not protected.

**Evidence:** verified by running (`FEE_CAP`). A 900 DIVI fee on a 1 DIVI send from a 1000 DIVI UTXO was accepted, with outputs of 1 and 99 DIVI.

**Fix:**
- Compute the fee in the background from the transaction size times a fee rate. Ignore any fee from a dApp, or accept it only as a rate clamped to a sane band.
- Enforce a hard maximum fee, for example 0.01 DIVI or 1% of the amount, with an explicit override in the popup only.
- Apply every limit to `amount + fee`.

#### H2. Node-supplied UTXO amounts and balances are trusted (hidden fee inflation; limit bypass)

**Location:**
- `src/background/rpc-client.ts:176`;
- `src/lib/transaction.ts:212-247`: the sighash contains no input amounts (legacy SIGHASH_ALL);
- `src/background/service-worker.ts:50-61`: the percentage limit uses the node-reported balance.

**Attack scenario:**
- **Attacker:** the RPC operator, or a man in the middle.
- **Action:** report a 100 DIVI UTXO as 1 DIVI.
- **Gain:**
  - The wallet computes change from the fake amount, so up to 99 DIVI silently becomes fee. The signature remains valid because input values are not signed.
  - Separately, inflating the reported balance raises the cap of the percentage limit (for example, "≤10% of balance").

**Evidence:** inferred from reading. The structure of the sighash was confirmed in code, and the vector tests confirm the sighash construction is standard legacy.

**Fix:**
- For every selected input, fetch the previous transaction (`getrawtransaction`). Verify that its hash equals the txid, and read the value and script from that output.
- Base the limits on values verified this way.
- Display the computed fee, inputs minus outputs from verified data, and refuse if it is above the cap.
- Longer term, query two independent nodes.

#### H3. Daily spending limits are never enforced

**Location:**
- `src/shared/storage.ts:53-55,169-170` and `src/popup/settings-ui.ts:294-303`: the limits are defined and editable;
- `src/background/service-worker.ts:43-71`: they are never read.

**Attack scenario:**
- **Attacker:** a malicious dApp, or someone who has the unlocked session.
- **Action:** split a drain into many sends, each under the per-transaction limit.
- **Gain:** a user who set a daily limit believes they are protected and is not.

**Evidence:** inferred from reading (grep: no consumer of `dailyLimit*` in `src/background`).

**Fix:**
- Keep a rolling 24-hour ledger of sent amounts plus fees per account in `storage.local`, and enforce it in `buildSend`.
- Alternatively, remove the setting from the UI until it is enforced.

#### H4. Imported phrases are validated in normalised form but derived raw (an unrecoverable wallet)

**Location:**
- `src/background/account-manager.ts:84,106`: `toSeed(mnemonic)` and `saveSecret(id, mnemonic, …)` get the raw string.
- `src/lib/mnemonic.ts:61`: `validate` trims, lowercases and splits on whitespace.
- `src/popup/account-ui.ts:233,296`: the popup only applies `trim()`.

**Attack scenario:**
- **Attacker:** none; this is a self-inflicted loss.
- **What happens:** a user pastes their phrase with a capital letter (mobile autocapitalisation), double spaces, or line breaks.
  - The import "succeeds" and funds are received at the derived addresses.
  - Those addresses are not the standard BIP39 wallet for that phrase. Restoring in any other wallet, or in IronDivi from a written backup in normal form, shows an empty wallet.
  - The user believes the funds are lost.
  - The opposite case is also possible: a user imports an existing wallet and sees zero balance, then sends funds to the "new" addresses.

**Evidence:** verified by running (`NORMALIZATION`). An uppercase phrase, a double-spaced phrase, and a newline-separated phrase each `validate()` as true but produce a different seed from the canonical phrase. Only the trimmed form matches.

**Fix:** normalise once at the boundary with `phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ')`. Use that normalised string for validation, seed derivation and storage, in the background (`importAccount`), not only in the popup.

### Medium

#### M1. The content script on every page can read the encrypted vault and every wallet record

**Location:**
- the manifests: the content script is on `<all_urls>`;
- `src/content/content-script.ts`: it uses `chrome.storage.local`;
- `src/shared/storage.ts`: the vault, accounts, addresses, address book and `allowedSites` all live in `storage.local`.

**Attack scenario:**
- **Attacker:** a renderer exploit on any web page. Content scripts share that renderer process.
- **Action:** read the PBKDF2-protected vault and brute-force it offline. Alternatively, write to `storage.local` to swap the stored receive addresses, add `*` to `allowedSites`, or poison the address book.

**Evidence:** inferred from reading.

**Fix:**
- Call `chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})`, which is the default but should be asserted. Have the content script read nothing directly; it should ask the background only for "is this origin allowed".
- Keep the vault in `storage.local` only, never readable by content scripts. Move the decision on `allowedSites` to the background.

#### M2. The session wrap key can be derived from data stored beside it

**Location:** `src/background/signing-session.ts:172-207`.

**Attack scenario:** the AES-KW wrap key comes from `installation_id`, kept in `storage.local`, plus a fixed salt. Anyone who reads both storage areas, through malware or a forensic image taken while the browser is running, can unwrap the session key and decrypt the mnemonic without the password. The wrapping therefore adds nothing beyond what storage.session already gives.

**Evidence:** inferred from reading.

**Fix:**
- Generate the session key as non-extractable and keep it in memory in the service worker. If the worker is killed, require a fresh unlock.
- Alternatively, generate a random wrap key per unlock, keep it only in memory, and accept re-authentication after the worker restarts.

#### M3. The unconfirmed new account (mnemonic plus password) sits in plaintext in session storage and is shown again without a password

**Location:**
- `src/popup/account-ui.ts:24-38,162`;
- `src/popup/popup.ts:139` (`checkPendingAccountCreation`).

**Attack scenario:** the user abandons the "confirm your phrase" step. Until the browser restarts, anyone who opens the popup sees the full phrase. That includes a person at the machine, or the popup opening as a dApp approval window. The plaintext password and mnemonic also sit in `storage.session`.

**Evidence:** inferred from reading.

**Fix:**
- Keep the pending phrase only in popup memory, or encrypt it with the session key.
- Never store the password.
- Require the password to resume.
- Never resume inside an approval window.

#### M4. An approval window can display a different request from the one it was opened for

**Location:** `src/popup/signing-request-ui.ts:66-73` (falls back to `requests[0]`).

**Attack scenario:** a malicious dApp queues a request at the right moment, or the requested id has already expired. The user then reviews and approves another site's pending request, whose origin is shown, in a window they expected to belong to the site they are using.

**Evidence:** inferred from reading.

**Fix:** if the requested id is not pending, show an error and close. Never substitute another request.

#### M5. Unlimited approval windows; Connect needs no password and always opens in the same place

**Location:**
- `src/background/connection-manager.ts`: approval windows are not limited;
- the Connect approval needs no password, and approving it grants `sign_message` and `send_transaction`.

**Attack scenario:** a hostile page floods connection requests until the user clicks Approve to get rid of them. Or it times a click-through so the user's double-click lands on Approve; the window sits at a predictable centred position.

**Evidence:** inferred from reading.

**Fix:**
- Allow one pending request per origin, and rate-limit window creation.
- Ignore clicks for about 500 ms after the window gains focus.
- Grant `view_address` only on Connect, and ask separately for signing permissions.

#### M6. Everything under `*.divi.domains` is trusted by default

**Location:** `src/shared/storage.ts:164`.

**Attack scenario:** any subdomain that is compromised, or user-content, takeover-prone or forgotten, can talk to the wallet: faucet, explorer, vps1, staging. Every dApp action still needs approval, but this trust raises the success of the phishing and flood attacks in M5.

**Evidence:** inferred from reading.

**Fix:** list the exact production hosts. Ship `localhost` and `127.0.0.1` only in development builds.

#### M7. The popup's send confirmation shows a truncated recipient address

**Location:** `src/popup/send-ui.ts` (confirm view uses `formatAddress`, the first 8 and last 8 characters; `ui-state.ts:90`).

**Attack scenario:** clipboard-hijacking malware swaps in a vanity address that matches the first and last characters. The user checks the truncated form and approves.

**Evidence:** inferred from reading. The dApp approval window does show the full address, which is correct.

**Fix:** show the full address on the confirm screen, chunked for readability, and flag recipients not seen before.

#### M8. A storage race in `migrateSecret`

**Location:** `src/shared/storage.ts` (`migrateSecret` is not awaited).

**Attack scenario:** a legacy vault at 100k iterations is re-encrypted at 600k in the background. If the worker is killed mid-write, or two unlocks race, the vault may be left half-written or the upgrade lost.

**Evidence:** inferred from reading.

**Fix:**
- Await the migration.
- Write the new blob under a new key, verify it decrypts, then switch the pointer atomically.

#### M9. A gap between what the user approved and what is signed

**Location:** `src/background/service-worker.ts:599-682`.

**Attack scenario:** the transaction is rebuilt from freshly fetched UTXOs at approval time, so the inputs, change and fee signed may differ from anything previewed. Combined with H2 and C1, this means the user never approves concrete transaction bytes.

**Evidence:** inferred from reading.

**Fix:** build at request time, show the computed fee and inputs, and sign exactly that built object after re-verifying it (see C1, fix 5).

#### M10. Session secrets fell back to persistent storage on Firefox (HEAD only)

**Location:** `src/shared/browser-polyfill.ts` at HEAD.

**Attack scenario:** with `storage.session` absent (Firefox < 115, while the minimum was 109), the session mnemonic ciphertext and wrap material were written to `storage.local` and survived restarts.

**Evidence:** inferred from reading. **Fixed in the uncommitted working tree:** the polyfill now throws, and `strict_min_version` is 128. Commit it.

**Fix:** commit the working-tree change.

#### M11. Extension scripts are injected into every page on every navigation, and the injection is not idempotent

**Location:** `src/background/service-worker.ts:724-796`.
- `executeScript` runs on every navigation.
- The `tabs.onActivated` check of `window.irondivi` runs in the isolated world, so it is always false and the provider is always re-injected.
- The content script is registered twice.

**Attack scenario:** duplicate listeners relay each request twice. Two approval windows open, and racing providers make responses ambiguous. A page can also tell that the wallet is present.

**Evidence:** inferred from reading.

**Fix:**
- Choose either a static content script or dynamic registration, not both.
- Guard the provider with a non-configurable `Object.defineProperty`.
- Drop the per-activation injection.

### Low

- **L1. The glob matcher is wrong.**
  - **Location:** `src/shared/origin.ts:30-37`.
  - **Problem:** `**` is rewritten to `.[^.]*`, so `**.divi.domains` does not match `a.b.divi.domains`. `?` matches a dot. The port is ignored, so any port on an allowed host is accepted.
  - **Evidence:** verified by running (`GLOB`). It fails closed for `**` and open for `?` and for ports.
  - **Fix:** match exact hosts or `*.` suffixes with label-aware code instead of regexes; treat `?` as `[^.]`; compare the port.
- **L2. `UPDATE_SETTINGS` does not validate.**
  - **Location:** `src/background/service-worker.ts:464-496`; `src/popup/settings-ui.ts:316`.
  - **Problem:** `updates` is merged unvalidated, and a password is needed only to switch network. Content cannot reach it, but a compromised popup can set `allowedSites: ['*']` or zero the limits without a password.
  - **Evidence:** inferred from reading.
  - **Fix:** validate against a schema, require the password to loosen limits or `allowedSites`, and validate the `allowedSites` textarea.
- **L3. Derived private keys are never wiped.**
  - **Location:** `src/background/service-worker.ts:85-95`.
  - **Problem:** keys derived in `sendFromAccount` and the `HDKey` chain are never `secureWipe`d; only the seed is.
  - **Evidence:** inferred from reading.
  - **Fix:** wipe them in `finally`.
- **L4. `hexToBytes` does not validate.**
  - **Location:** `src/lib/hex.ts:4`.
  - **Problem:** odd lengths and non-hex characters silently become NaN, then 0.
  - **Evidence:** inferred from reading.
  - **Fix:** throw on invalid input (this hardens C1).
- **L5. Large amounts pass through JS `number`.**
  - **Location:** `src/background/wallet-core.ts:58,192`.
  - **Problem:** output values go through `Number(sats)` and `satoshisToDivi`. Above 2^53 satoshis (about 90 million DIVI per output), precision may be lost, and the difference becomes fee or invalidates the transaction. A fee of 0 or below one satoshi is also accepted, and such a transaction will not relay.
  - **Evidence:** verified by running (`PRECISION`). 1e21 throws, and a 123,456,789 DIVI change output happened to round-trip exactly.
  - **Fix:** keep BigInt end to end, serialise with `DataView.setBigUint64`, and enforce a minimum relay fee.
- **L6. The mnemonic is copied to the clipboard and never cleared.**
  - **Location:** `src/popup/modals.ts:190`.
  - **Evidence:** inferred from reading.
  - **Fix:** remove the copy button, or clear the clipboard after 30 seconds and warn the user.
- **L7. Approval messages are truncated, and bidi and control characters are not neutralised.**
  - **Location:** `src/popup/signing-request-ui.ts:136-137`.
  - **Problem:** a dApp can hide content after character 200. Bidi and control characters can also hide or reorder text.
  - **Evidence:** inferred from reading.
  - **Fix:** show the full message, scrollable, with control and bidi characters escaped visibly.
- **L8. The 8-character password minimum is enforced only in the popup.**
  - **Location:** `src/popup/account-ui.ts:270,306`. There is no check in `src/background/account-manager.ts`.
  - **Evidence:** inferred from reading.
  - **Fix:** enforce it in the background too.
- **L9. Address-book entries are not validated.**
  - **Location:** `src/background/address-book.ts:9,41` (`addContact`, `updateContact`).
  - **Evidence:** inferred from reading.
  - **Fix:** run `Address.validate` with the network.
- **L10. The unlock rate limit resets on browser restart.**
  - **Location:** `src/background/signing-session.ts:85,113`. The state lives in `storage.session`.
  - **Evidence:** inferred from reading.
  - **Fix:** persist the counter in `storage.local`.
- **L11. The node-supplied scriptPubKey is not checked against the UTXO's address.**
  - **Location:** `src/background/wallet-core.ts:167-172,231-237`.
  - **Problem:** a wrong script yields an invalid signature, which is a denial of service, and it feeds C1.
  - **Evidence:** inferred from reading.
  - **Fix:** rebuild the script from the address.
- **L12. Fingerprinting.**
  - **Location:** `manifest.json:39-43`.
  - **Problem:** `provider.js` is web-accessible on `<all_urls>`, so any site can detect the extension.
  - **Evidence:** inferred from reading.
  - **Fix:** use `use_dynamic_url: true`, or inject without web-accessible resources.
- **L13. Source maps ship in production.**
  - **Location:** `esbuild.config.js:14`.
  - **Evidence:** inferred from reading.
  - **Fix:** turn off `sourcemap` for release builds.
- **L14. Supply chain.**
  - **Location:** `package.json`; `install-site/install.js`; ADR 0002.
  - **Problems:**
    - caret ranges;
    - an `@anthropic-ai/sdk` devDependency at HEAD (removed in the uncommitted working tree);
    - packages distributed as unsigned or ad-hoc-signed zips from `vps1.divi.domains`, with no checksums or signatures;
    - placeholder store links;
    - no auto-update.
  - **Evidence:** inferred from reading.
  - **Fix:** pin exact versions, publish SHA-256 sums and a signature, and get store listings with auto-update before mainnet.
- **L15. Popup message signing uses the session's account implicitly.**
  - **Location:** `src/background/service-worker.ts:352-356`.
  - **Problem:** the signature is made with the session's account rather than an explicit one, which can surprise a user who has several accounts.
  - **Evidence:** inferred from reading.
  - **Fix:** pass the account id explicitly.

### Info

- **I1. Variable-time scalar multiplication.**
  - **Location:** `src/lib/secp256k1.ts:97-105`.
  - **Problem:** it is variable-time BigInt double-and-add. A timing side channel is impractical in an extension, but the code is not constant-time.
  - **Evidence:** inferred from reading.
- **I2. BIP32 does not check that IL < n or that the child key is non-zero.**
  - **Location:** `src/lib/hdkey.ts:112-116`.
  - **Problem:** the probability is negligible, but the spec says to skip such indices.
  - **Evidence:** inferred from reading.
- **I3. `signHash` accepts a zero private key and signs with it.**
  - **Location:** `src/lib/signer.ts:78`. `derivePublicKey` does reject it.
  - **Evidence:** verified by running (`ZERO_KEY`).
- **I4. RFC 6979 is passed the raw hash rather than `int2octets(h mod n)`.**
  - **Location:** `src/lib/signer.ts:35-49`.
  - **Problem:** this is equivalent except for hashes ≥ n.
  - **Evidence:** verified by running. A signature over a digest of all 0xff bytes still verified.
- **I5. P2SH destinations are refused.**
  - **Location:** `src/background/wallet-core.ts:178-187` (P2PKH output only).
  - **Problem:** this is safe, but users will hit it.
  - **Evidence:** inferred from reading.
- **I6. `window.irondivi` is writable, not frozen.**
  - **Location:** `src/injected/provider.ts:242`.
  - **Problem:** it runs at the page's trust level, so this is cosmetic.
  - **Evidence:** inferred from reading.
- **I7. The test harness contains a test phrase and password.**
  - **Location:** `src/test-support/harness.ts`.
  - **Problem:** it contains a public BIP39 test-vector phrase and a test password. It is not bundled into any entry point; keep it that way.
  - **Evidence:** inferred from reading the esbuild entry points.

### Found while testing the fixes

- **T1. The approval window showed a refused approval as a success.**
  - **Location:** `src/popup/signing-request-ui.ts`, `handleApprove` and `handleReject`.
  - **Problem:** the popup's `sendMessage` resolves with the wallet's reply and does not throw when the reply says `success: false`. The window treated any reply as approved, so a wrong password or a send the wallet refused showed a success message and closed, while the site was told the request failed. No funds moved, but the user was told something false about a payment.
  - **Evidence:** verified by running. The end-to-end send test showed "approved" while the site received an error.
  - **Fix:** throw on a reply without `success`, so the error is shown and the window stays open.

## Checked and found sound

- **Hashes.** SHA-256 matches Node for every length from 0 to 300 bytes, and RIPEMD-160 for 0 to 200 bytes. Known vectors pass. Verified by running.
- **BIP39 seed derivation.** It matches the Trezor vector. Verified by running.
- **BIP32.** Vectors 1 and 2 match, including hardened and maximum indices. Two hundred child keys are always 32 bytes and consistent with their public keys. Verified by running.
- **ECDSA.**
  - RFC 6979 vectors with private key 1 match.
  - Forty random signatures are low-S and strict DER, and verify with an independent verifier that was itself cross-checked against Node's secp256k1.
  - Verified by running.
- **Addresses.** The known public key gives the correct hash160, mainnet version 0x1e with a "D" prefix, rejection across networks, and checksum rejection of a single-character change. Verified by running.
- **Sender gate.** Only the extension's own pages can call privileged methods. Content can call only the `DAPP_METHODS` allowlist. The origin comes from the browser-provided `sender`, not from the message. A connection approval cannot approve signing.
- **dApp approvals.** Every dApp sign or send needs the password. The network is re-checked at approval time.
- **CSP.** `script-src 'self'; object-src 'none'; base-uri 'self'`. There is no remote code and no `eval`.
- **XSS.** The approval UI escapes every interpolated value, and the origin uses `textContent`. History, contacts and the explorer link (a fixed prefix plus the txid) are built safely. The QR code is drawn on a canvas.
- **postMessage.** It uses a fixed `targetOrigin` and checks `event.source === window`. Request ids come from `crypto.randomUUID`.
- **Coin selection.** It uses BigInt satoshi arithmetic. Change goes only to an address the wallet owns. Dust is checked.
- **Vault.** PBKDF2 at 600k iterations, AES-GCM with a random IV and salt.
- **Remote checks.** `scripts/remote-check.sh` only runs CI steps.
