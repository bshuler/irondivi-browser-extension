import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

// QR ask and QR pay in the real popup: Receive draws a divi: payment request
// from the amount, label and memo; Send reads one from a picked picture and
// fills the form, which the owner still confirms. Nothing is sent.

async function receiveQrText(page: Page): Promise<string | null> {
  const px = await page.evaluate(() => {
    const c = document.querySelector('#qr-code canvas') as HTMLCanvasElement | null;
    if (!c) return null;
    // A white quiet zone around the code, as a screen has
    const pad = 20;
    const out = document.createElement('canvas');
    out.width = c.width + 2 * pad;
    out.height = c.height + 2 * pad;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, pad, pad);
    return { w: out.width, h: out.height, d: Array.from(ctx.getImageData(0, 0, out.width, out.height).data) };
  });
  if (!px) return null;
  return jsQR(Uint8ClampedArray.from(px.d), px.w, px.h)?.data ?? null;
}

test('QR ask on Receive and QR pay on Send', async ({ extensionPage: page }) => {
  // The BIP39 test vector: a public phrase, not anyone's wallet
  await page.click('#onboard-import-btn');
  await page.fill('#import-name', 'QR E2E');
  await page.fill('#import-mnemonic', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  await page.fill('#import-password', 'ImportPassword123!');
  await page.click('#import-submit-btn');
  await expect(page.locator('#balance-section')).toBeVisible({ timeout: 15000 });

  // Receive: the bare address until a field is filled
  await page.click('#receive-btn');
  const address = (await page.locator('#receive-address').textContent())!.trim();
  expect(address.length).toBeGreaterThan(25);
  await expect.poll(() => receiveQrText(page)).toBe(address);
  await expect(page.locator('#copy-request-btn')).toBeDisabled();

  await page.click('#receive-request summary');
  await page.fill('#receive-amount', '12.5');
  await page.fill('#receive-label', 'Bob & Co');
  await page.fill('#receive-memo', 'invoice 42');
  const uri = `divi:${address}?amount=12.5&label=Bob%20%26%20Co&memo=invoice%2042`;
  await expect.poll(() => receiveQrText(page)).toBe(uri);
  await expect(page.locator('#receive-request-status')).toHaveText(uri);
  await expect(page.locator('#copy-request-btn')).toBeEnabled();

  // An amount no wallet could pay draws no QR
  await page.fill('#receive-amount', '1.123456789');
  await expect(page.locator('#receive-request-status')).toContainText('8 decimal places');
  await expect(page.locator('#qr-code canvas')).toHaveCount(0);
  await expect(page.locator('#copy-request-btn')).toBeDisabled();
  await page.click('#receive-back-btn');

  // Send: pick a picture of a payment request
  await page.click('#send-btn');
  await expect(page.locator('#send-scan-tab-btn')).toBeVisible();
  const request = `divi:${address}?amount=0.25&label=Coffee%20shop&message=Latte&memo=table%207`;
  const png = await QRCode.toBuffer(request, { errorCorrectionLevel: 'M', margin: 4, scale: 6 });
  await page.setInputFiles('#send-qr-input', { name: 'pay.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#send-to')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.25');
  await expect(page.locator('#send-memo')).toHaveValue('table 7');
  await expect(page.locator('#send-request-label')).toHaveText('Coffee shop');
  await expect(page.locator('#send-request-message')).toHaveText('Latte');
  // Filled in, never sent: the form is still open
  await expect(page.locator('#view-send')).toBeVisible();

  // A request for the other network is refused and changes nothing
  const network = await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.network ?? 'testnet');
  const otherNet = network === 'testnet' ? 'Mainnet' : 'Testnet';
  const foreign = network === 'testnet' ? 'DPhJsztbZafDc1YeyrRqSjmKjkmLJpQpUn' : 'y4T3sVfEpXtdE2tbLzYYwJEnLLUzPKCyFm';
  const bad = await QRCode.toBuffer(`divi:${foreign}?amount=1`, { margin: 4, scale: 6 });
  await page.setInputFiles('#send-qr-input', { name: 'bad.png', mimeType: 'image/png', buffer: bad });
  await expect(page.locator('#toast')).toContainText(new RegExp(`${otherNet} address|not a valid`));
  await expect(page.locator('#send-to')).toHaveValue(address);

  // A picture with no QR code
  const blank = await QRCode.toBuffer('x', { margin: 4, scale: 6 });
  await page.setInputFiles('#send-qr-input', { name: 'x.png', mimeType: 'image/png', buffer: blank });
  await expect(page.locator('#toast')).toContainText(/not a valid|No QR code/);

  // A pasted divi: link in the address field fills the form too
  await page.fill('#send-to', `divi:${address}?amount=0.5&memo=pasted`);
  await page.click('#send-confirm-btn');
  await expect(page.locator('#send-to')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.5');
  await expect(page.locator('#send-memo')).toHaveValue('pasted');
  await expect(page.locator('#view-send')).toBeVisible();
});
