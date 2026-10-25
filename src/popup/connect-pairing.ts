/**
 * IronDivi Connect pairing: reading a pairing code from pasted text or a QR
 * screenshot's pixels, and what the pairing list shows. Kept apart from the
 * popup wiring (connect-ui.ts) so it runs without a browser.
 */

import jsQR from 'jsqr';
import { visibleText } from './visible-text';
import { NETWORKS } from '../shared/constants';

export interface RelaySessionInfo {
  topic: string; origin: string; name: string; relay: string; relayHost: string;
  network: string; connected: boolean; account: string | null;
}

const CODE = /irondivi-connect:v1\?\S+/;
// A screenshot bigger than this is not a QR code someone copied
export const MAX_QR_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_QR_SIDE = 2000;

/** The pairing code in what the owner pasted, or null when there is none */
export function pairingCodeFrom(text: string): string | null {
  const m = CODE.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/** The pairing code in a picture's pixels, or null when it holds none */
export function pairingCodeFromPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  const qr = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return qr ? pairingCodeFrom(qr.data) : null;
}

/** What the list shows for one pairing; every part the page chose is made visible */
export function pairingLines(s: RelaySessionInfo): { title: string; detail: string } {
  const name = visibleText(s.name).text.trim();
  const site = visibleText(s.origin).text;
  const network = NETWORKS[s.network as keyof typeof NETWORKS]?.name ?? s.network;
  return {
    title: name ? `“${name}” · ${site} (claimed)` : `${site} (claimed)`,
    detail: `${network} · relayed by ${visibleText(s.relayHost).text} · ${s.connected ? 'connected' : 'not connected yet'}`,
  };
}
