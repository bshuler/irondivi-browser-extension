# Contributing to IronDivi

Bug reports and pull requests are welcome. Run `npm test` (`npx vitest run`)
and `npx tsc --noEmit -p .` before you open a pull request; CI runs both.

## Adding a site to the default list

A site on the default list ([`site-access/default-sites.json`](site-access/default-sites.json))
can use the wallet without asking first: its pages can ask to connect, sign
and pay, each with its own approval window. Every other site must ask the user
with `irondivi.requestAccess()` (see the README, "dApp connections"), which
works for any site and needs nothing from us. Ask to be on the default list only
if you run a site for Divi users that should not have to ask.

To ask, open a pull request with the **Add a site** template:

```
https://github.com/bshuler/irondivi-browser-extension/compare/main...YOUR-BRANCH?template=add-site.md
```

The pull request adds one line to `site-access/default-sites.json` and fills in
the template:

1. **The exact origin**: `https://` plus the host name, lowercase, no path, no
   trailing slash, no wildcard. Each subdomain is its own entry.
2. **Proof that you control it**, naming the pull request's number, either
   - `https://<your-site>/.well-known/irondivi.txt` containing
     `irondivi-default-list: PR #<number>`, or
   - a DNS TXT record on the host with the same text.
   Leave it in place until the pull request is merged.
3. **How to reach you**: a name and an address that answers.
4. **What the site does with the wallet**: which calls it makes and why.

### Review criteria

A maintainer merges the pull request only if all of these hold:

- the proof is in place and names this pull request;
- the origin is exact `https`, already serves the site, and is not on the
  denylist;
- the site has a clear purpose for Divi users, and what it does with the wallet
  matches what the pull request says;
- the site does not ask for blind signatures: payments go through
  `sendTransaction`, and text to sign is readable;
- nothing on the site impersonates IronDivi, Divi or another project;
- the site has a working contact.

A site can be taken off the list, or put on the denylist, if it stops meeting
these criteria. The test `src/shared/site-lists.test.ts` checks the lists'
format (https only, lowercase, no wildcards, no duplicates, no site on both).

## Reporting a harmful site

Open an issue with the **Report a site** template. A site on the denylist
([`site-access/blocked-sites.json`](site-access/blocked-sites.json)) is refused
every call and can never open a window, whatever the default list or the user
says. A user can also block any site themselves in **Settings → Site Access**.

## Security problems in the wallet itself

Do not open a public issue for a vulnerability in the extension. Write to the
maintainer through GitHub's private vulnerability reporting for this
repository.
