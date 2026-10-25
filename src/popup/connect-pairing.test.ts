import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { pairingCodeFrom, pairingCodeFromPixels, pairingLines } from './connect-pairing';

// The pairing half of IronDivi Connect in the popup: the owner pastes a
// page's code or picks a screenshot of its QR code, and sees and ends pairings

const CODE = 'irondivi-connect:v1?t=0123456789abcdef0123456789abcdef&k=AbCdEf_-0123456789AbCdEf_-0123456789AbCdEf_&r=https%3A%2F%2Fdivi.cx%2Fconnect&o=https%3A%2F%2Fgames.divi.domains&n=testnet&e=1798761600';

// A QR code drawn the way a screenshot holds it: RGBA, dark on light, with a margin
function qrPixels(text: string, scale = 4, margin = 4) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const side = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

describe('Connect pairing: reading the code', () => {
  it('takes the code out of whatever was pasted around it', () => {
    expect(pairingCodeFrom(CODE)).toBe(CODE);
    expect(pairingCodeFrom(`  Pair with:\n${CODE}\n`)).toBe(CODE);
  });

  it('refuses text with no code in it', () => {
    expect(pairingCodeFrom('https://games.divi.domains')).toBeNull();
    expect(pairingCodeFrom('irondivi-connect:v2?t=1')).toBeNull();
    expect(pairingCodeFrom('')).toBeNull();
  });

  it('reads the code from a QR screenshot, dark on light or inverted', () => {
    const { data, width, height } = qrPixels(CODE);
    expect(pairingCodeFromPixels(data, width, height)).toBe(CODE);
    const inverted = data.map((v, i) => (i % 4 === 3 ? v : 255 - v));
    expect(pairingCodeFromPixels(inverted, width, height)).toBe(CODE);
  });

  it('a QR code that holds something else is not a pairing', () => {
    const { data, width, height } = qrPixels('https://example.com/');
    expect(pairingCodeFromPixels(data, width, height)).toBeNull();
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(pairingCodeFromPixels(blank, 64, 64)).toBeNull();
  });
});

describe('Connect pairing: the list', () => {
  const s = {
    topic: 't1', origin: 'https://games.divi.domains', name: 'Divi Games', relay: 'https://divi.cx/connect',
    relayHost: 'divi.cx', network: 'testnet', connected: true, account: null,
  };

  it('says the site is claimed and names the relay and network', () => {
    const { title, detail } = pairingLines(s);
    expect(title).toBe('“Divi Games” · https://games.divi.domains (claimed)');
    expect(detail).toMatch(/Testnet · relayed by divi\.cx · connected/);
    expect(pairingLines({ ...s, name: '', connected: false }).title).toBe('https://games.divi.domains (claimed)');
    expect(pairingLines({ ...s, connected: false }).detail).toMatch(/not connected yet$/);
  });

  it('a name with hidden characters shows them', () => {
    expect(pairingLines({ ...s, name: 'Divi‮Games' }).title).toContain('⟨U+202E⟩');
  });

  it('the settings view has the paste field, QR picker and list, and wires them', () => {
    const html = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
    for (const id of ['connect-uri-input', 'connect-pair-btn', 'connect-qr-input', 'connect-pairings-list']) {
      expect(html).toContain(`id="${id}"`);
    }
    const src = readFileSync(new URL('./connect-ui.ts', import.meta.url), 'utf8');
    expect(src).toContain('MAX_QR_FILE_BYTES');
    expect(src).toContain('MSG.CONNECT_PAIR');
    expect(src).toContain('MSG.CONNECT_SESSIONS');
    expect(src).toContain('MSG.CONNECT_END');
    // Page-chosen text goes in as text, never as markup
    expect(src).not.toContain('innerHTML');
    const settings = readFileSync(new URL('./settings-ui.ts', import.meta.url), 'utf8');
    expect(settings).toMatch(/loadPairings\(\)/);
    expect(settings).toMatch(/setupConnectUIHandlers\(\)/);
  });
});
