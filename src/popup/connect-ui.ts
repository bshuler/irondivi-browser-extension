/**
 * IronDivi Connect pairing (settings): the owner pastes a page's pairing
 * code or picks a screenshot of its QR code, and sees and ends the pairings.
 * The site in a code is what the page claims; the list says so. The parsing
 * and wording are in connect-pairing.ts.
 */

import { sendMessage } from './message-api';
import { showToast } from './ui-state';
import { showConfirmModal } from './modals';
import { visibleText } from './visible-text';
import { MSG } from '../shared/constants';
import { MAX_QR_FILE_BYTES, MAX_QR_SIDE, pairingCodeFrom, pairingCodeFromPixels, pairingLines, type RelaySessionInfo } from './connect-pairing';

async function pixelsOf(file: File): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_QR_SIDE / Math.max(bitmap.width, bitmap.height));
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

async function pair(code: string): Promise<void> {
  const input = document.getElementById('connect-uri-input') as HTMLTextAreaElement | null;
  try {
    const s = await sendMessage<RelaySessionInfo>(MSG.CONNECT_PAIR, { uri: code });
    if (input) input.value = '';
    showToast(`Paired with ${visibleText(s.origin).text} (claimed). Approve its connect request when it comes.`, 'success');
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'Pairing failed', 'error');
  }
  await loadPairings();
}

export async function loadPairings(): Promise<void> {
  const list = document.getElementById('connect-pairings-list');
  if (!list) return;
  let sessions: RelaySessionInfo[] = [];
  try {
    sessions = (await sendMessage<RelaySessionInfo[]>(MSG.CONNECT_SESSIONS)) ?? [];
  } catch {
    sessions = [];
  }
  list.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state connect-empty';
    empty.textContent = 'No pairings';
    list.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const { title, detail } = pairingLines(s);
    const item = document.createElement('div');
    item.className = 'connected-site-item connect-pairing-item';
    const text = document.createElement('div');
    text.className = 'connect-pairing-text';
    const t = document.createElement('div');
    t.className = 'connected-site-origin';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'setting-hint';
    d.textContent = detail;
    text.append(t, d);
    const end = document.createElement('button');
    end.className = 'disconnect-btn';
    end.textContent = 'End';
    end.addEventListener('click', () => endPairing(s));
    item.append(text, end);
    list.appendChild(item);
  }
}

async function endPairing(s: RelaySessionInfo): Promise<void> {
  const ok = await showConfirmModal('End pairing', `End the pairing with ${visibleText(s.origin).text}? The page must show a new code to pair again.`, 'End');
  if (!ok) return;
  try {
    await sendMessage(MSG.CONNECT_END, { topic: s.topic });
    showToast('Pairing ended', 'success');
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'Failed to end the pairing', 'error');
  }
  await loadPairings();
}

export function setupConnectUIHandlers(): void {
  document.getElementById('connect-pair-btn')?.addEventListener('click', () => {
    const input = document.getElementById('connect-uri-input') as HTMLTextAreaElement | null;
    const code = pairingCodeFrom(input?.value ?? '');
    if (!code) {
      showToast('That is not an IronDivi Connect code (it starts with irondivi-connect:v1?)', 'error');
      return;
    }
    void pair(code);
  });

  const file = document.getElementById('connect-qr-input') as HTMLInputElement | null;
  file?.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    if (picked.size > MAX_QR_FILE_BYTES) {
      showToast('That picture is too large; crop it to the QR code', 'error');
      return;
    }
    let code: string | null = null;
    try {
      const { data, width, height } = await pixelsOf(picked);
      code = pairingCodeFromPixels(data, width, height);
    } catch {
      showToast('The picture could not be read', 'error');
      return;
    }
    if (!code) {
      showToast('No IronDivi Connect QR code found in that picture', 'error');
      return;
    }
    await pair(code);
  });
}
