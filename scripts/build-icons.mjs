#!/usr/bin/env node
// Rasterise the toolbar and store icons (assets/icons/icon-*.png) from the wallet mark.
//
//   node scripts/build-icons.mjs [--preview DIR]
//
// The wallet mark (assets/icons/wallet-mark.svg, copied from site/assets/brand/) has a
// see-through fill made for the dark web wallet. A toolbar can be light, so the icon
// bakes that fill onto the site's background colour and thickens the rim at small sizes.
// The PNGs are derived; regenerate them whenever the mark changes.

import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = { 16: 7, 32: 5.5, 48: 4, 128: 2.5 }; // px -> rim width in the 100-unit viewBox

// #6366f1 at 30% and 10% over the site's --bg-deep #0f0f1a, as the mark looks on the web wallet.
const iconSvg = (rim) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="f" x1="50" y1="5" x2="50" y2="95" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#28295a"/><stop offset="1" stop-color="#17182f"/></linearGradient></defs>
  <path d="M50 5 L90 20 L90 45 C90 70 70 90 50 95 C30 90 10 70 10 45 L10 20 Z" fill="url(#f)" stroke="#6366f1" stroke-width="${rim}" stroke-linejoin="round" transform="translate(50 50) scale(${(90 - rim) / 90}) translate(-50 -50)"/>
  <path d="M50 25 L65 50 L50 75 L35 50 Z" fill="#6366f1" fill-opacity="0.9"/>
  <path d="M50 25 L57 45 L50 50 L43 45 Z" fill="#ffffff" fill-opacity="0.3"/>
  <path d="M48.2 40.8 H51.8 V58 H48.2 Z" fill="#ffffff"/>
</svg>`;

const args = process.argv.slice(2);
const previewDir = args.includes('--preview') ? path.resolve(args[args.indexOf('--preview') + 1]) : null;

// CHROMIUM_PATH: use an already-installed Chromium instead of the pinned download.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
const shoot = async (html, w, h, transparent) => {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;${transparent ? 'background:transparent' : ''}}</style>${html}`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
};
const uri = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');

const out = {};
for (const [size, rim] of Object.entries(SIZES)) {
  out[size] = await shoot(`<img src="${uri(iconSvg(rim))}" width="${size}" height="${size}" style="display:block">`, +size, +size, true);
  await writeFile(path.join(root, 'assets/icons', `icon-${size}.png`), out[size]);
}
if (previewDir) {
  // Each size at 1x and magnified, on a light and a dark toolbar.
  await mkdir(previewDir, { recursive: true });
  const cell = (bg) => Object.entries(out).map(([s, b]) => {
    const src = 'data:image/png;base64,' + b.toString('base64');
    return `<div style="background:${bg};padding:12px;display:flex;gap:12px;align-items:center">
      <img src="${src}"><img src="${src}" style="width:128px;height:128px;image-rendering:pixelated"></div>`;
  }).join('');
  await writeFile(path.join(previewDir, 'icons-preview.png'),
    await shoot(`<div style="display:grid;grid-template-columns:1fr 1fr"><div>${cell('#f1f3f4')}</div><div>${cell('#202124')}</div></div>`, 440, 640, false));
}
await browser.close();
