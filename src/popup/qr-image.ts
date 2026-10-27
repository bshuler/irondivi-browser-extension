/**
 * Reading QR codes from pictures in the popup: a picked file (a screenshot,
 * or on iOS a photo the camera just took) or a capture of the visible tab.
 * Shared by IronDivi Connect pairing and Send's "Scan QR".
 */

import jsQR from 'jsqr';
import { browserAPI } from '../shared/browser-polyfill';
import { MAX_QR_FILE_BYTES, MAX_QR_SIDE } from './connect-pairing';

// A tab capture is decoded at its own size first, so a small QR code on a
// large (Retina) screen keeps enough pixels per module; this caps the work
export const MAX_CAPTURE_SIDE = 4096;

export interface Pixels { data: Uint8ClampedArray; width: number; height: number }

/** The picture's pixels, scaled down so neither side exceeds maxSide */
export async function pixelsOf(source: ImageBitmapSource, maxSide = MAX_QR_SIDE): Promise<Pixels> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('The picture could not be read');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } finally {
    bitmap.close();
  }
}

/** The text of the QR code in the pixels, or null when there is none */
export function qrTextFromPixels({ data, width, height }: Pixels): string | null {
  return jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/** The text of the QR code in a picked picture; throws a user-facing error */
export async function qrTextFromFile(file: File): Promise<string | null> {
  if (file.size > MAX_QR_FILE_BYTES) throw new Error('That picture is too large; crop it to the QR code');
  let pixels: Pixels;
  try {
    pixels = await pixelsOf(file);
  } catch {
    throw new Error('The picture could not be read');
  }
  return qrTextFromPixels(pixels);
}

/** True where the browser can capture the visible tab (not iOS Safari) */
export function canCaptureTab(): boolean {
  return typeof browserAPI?.tabs?.captureVisibleTab === 'function';
}

function captureVisibleTab(): Promise<string> {
  return new Promise((resolve, reject) => {
    browserAPI.tabs.captureVisibleTab({ format: 'png' }, (dataUrl: string | undefined) => {
      const error = browserAPI.runtime?.lastError;
      if (error || !dataUrl) reject(new Error(error?.message || 'The tab could not be captured'));
      else resolve(dataUrl);
    });
  });
}

/**
 * The text of a QR code anywhere in the visible tab, or null. The whole
 * capture is decoded, uncropped: first at full size, then scaled down,
 * which helps with a very large code.
 */
export async function qrTextFromVisibleTab(): Promise<string | null> {
  let dataUrl: string;
  try {
    dataUrl = await captureVisibleTab();
  } catch {
    throw new Error('This tab cannot be captured (browser pages and the store cannot be). Try "Pick a picture".');
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const full = await pixelsOf(img, MAX_CAPTURE_SIDE);
  const text = qrTextFromPixels(full);
  if (text !== null) return text;
  if (Math.max(full.width, full.height) <= 1000) return null;
  return qrTextFromPixels(await pixelsOf(img, 1000));
}
