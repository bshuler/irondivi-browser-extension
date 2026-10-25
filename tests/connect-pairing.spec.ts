import { test, expect } from './fixtures';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';

// IronDivi Connect pairing in the real popup: a pasted code and a QR
// screenshot are read, a code for the other network is refused, the pairing
// is listed as claimed and polls the relay, and End removes it. The relay is
// a local stand-in that answers every poll with no messages.

const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function code(relay: string, network: string) {
  const e = Math.floor(Date.now() / 1000) + 600;
  return `irondivi-connect:v1?k=${b64u(randomBytes(32))}&r=${encodeURIComponent(relay)}`
    + `&o=${encodeURIComponent('https://games.divi.domains')}&n=${network}&e=${e}`;
}

test('pair by code and by QR screenshot, list the pairing, end it', async ({ extensionPage: page }) => {
  const polls: string[] = [];
  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (req.method === 'GET') polls.push(req.url ?? '');
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'GET' ? { messages: [] } : { id: 1 }));
    }, 200);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // The BIP39 test vector: a public phrase, not anyone's wallet
    await page.click('#onboard-import-btn');
    await page.fill('#import-name', 'Connect E2E');
    await page.fill('#import-mnemonic', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    await page.fill('#import-password', 'ImportPassword123!');
    await page.click('#import-submit-btn');
    await expect(page.locator('#balance-section')).toBeVisible({ timeout: 15000 });

    await page.click('#settings-btn');
    await expect(page.locator('#connect-pairings-list')).toContainText('No pairings');

    // Not a code
    await page.fill('#connect-uri-input', 'https://games.divi.domains');
    await page.click('#connect-pair-btn');
    await expect(page.locator('#toast')).toContainText('not an IronDivi Connect code');

    // A QR screenshot of a code for the other network
    const network = await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.network ?? 'testnet');
    const other = network === 'testnet' ? 'mainnet' : 'testnet';
    const png = await QRCode.toBuffer(code(relay, other), { errorCorrectionLevel: 'M', margin: 4, scale: 6 });
    await page.setInputFiles('#connect-qr-input', { name: 'qr.png', mimeType: 'image/png', buffer: png });
    await expect(page.locator('#toast')).toContainText(`This code is for ${other}`);
    await expect(page.locator('#connect-pairings-list')).toContainText('No pairings');

    // A QR screenshot that is not a pairing
    const other2 = await QRCode.toBuffer('https://example.com/', { margin: 4, scale: 6 });
    await page.setInputFiles('#connect-qr-input', { name: 'qr2.png', mimeType: 'image/png', buffer: other2 });
    await expect(page.locator('#toast')).toContainText('No IronDivi Connect QR code');

    // A pasted code with text around it pairs, and is listed as claimed
    await page.fill('#connect-uri-input', `Pair with: ${code(relay, network)}\n`);
    await page.click('#connect-pair-btn');
    await expect(page.locator('#toast')).toContainText('Paired with https://games.divi.domains (claimed)');
    await expect(page.locator('#connect-uri-input')).toHaveValue('');
    const item = page.locator('#connect-pairings-list .connect-pairing-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('https://games.divi.domains (claimed)');
    await expect(item).toContainText(`relayed by 127.0.0.1:`);
    await expect(item).toContainText('not connected yet');
    await expect.poll(() => polls.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(polls[0]).toMatch(/^\/v1\/topics\/[A-Za-z0-9_-]+\/messages\?dir=d&after=0&wait=\d+$/);

    // The same pairing by QR screenshot works too
    const png2 = await QRCode.toBuffer(code(relay, network), { margin: 4, scale: 6 });
    await page.setInputFiles('#connect-qr-input', { name: 'qr3.png', mimeType: 'image/png', buffer: png2 });
    await expect(item).toHaveCount(2);

    // End both
    for (let left = 1; left >= 0; left--) {
      await item.first().locator('button', { hasText: 'End' }).click();
      await expect(page.locator('#confirm-modal-ok')).toHaveText('End');
      await page.click('#confirm-modal-ok');
      await expect(item).toHaveCount(left);
    }
    await expect(page.locator('#connect-pairings-list')).toContainText('No pairings');
  } finally {
    server.close();
  }
});
