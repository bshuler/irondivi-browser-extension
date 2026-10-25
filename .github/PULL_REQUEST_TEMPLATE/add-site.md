## Add a site to the IronDivi default list

See CONTRIBUTING.md, "Adding a site to the default list", for the review criteria.

**Origin** (exactly as added to `site-access/default-sites.json`):
`https://`

**Proof of control** (pick one and leave it in place until this is merged):
- [ ] `https://<origin>/.well-known/irondivi.txt` contains `irondivi-default-list: PR #<this PR's number>`
- [ ] A DNS TXT record on the host contains `irondivi-default-list: PR #<this PR's number>`

**Contact** (a name, and an email address or other channel that answers):

**What the site is, and what it does with the wallet** (which calls it makes, and why):

- [ ] The site does not ask users to sign text they cannot read, and pays through `sendTransaction`.
- [ ] The pull request changes only `site-access/default-sites.json`.
