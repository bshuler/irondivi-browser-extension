/**
 * Player Certificates UI (divi-nft-chain docs/LICENCE-SERVICE.md §12.1, §12.5, §15 #16):
 * Authorise a media player (such as VLC Hypercaption) to unlock licensed tracks
 * held by an address in this wallet without ever sharing the wallet key.
 */

import QRCode from 'qrcode';
import { state } from './state';
import { ensureNetworkAddresses } from './account-ui';
import { chunkAddress } from './recipient-check';
import { sendMessage } from './message-api';
import { showPasswordModal } from './modals';
import { canCaptureTab, qrTextFromFile, qrTextFromVisibleTab } from './qr-image';
import { showLoading, hideLoading, showToast, showView, hideView } from './ui-state';
import { MSG, NETWORKS, type NetworkType } from '../shared/constants';
import {
  DEFAULT_LICENCE_DOMAIN,
  PLAYER_CERT_TITLE,
  buildPlayerCertMessage,
  exportPlayerCertificate,
  extractPlayerKey,
  formatCertIsoTime,
  formatSignedPlayerCertificate,
  generatePlayerCertSerial,
  verifyPlayerCertificate,
  type PlayerCertExportFormat,
  type PlayerCertFields,
  type SignedPlayerCertificate,
} from '../lib/player-cert';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;
const must = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let currentSerial = '';
let lastSignedCert: SignedPlayerCertificate | null = null;

function activeNetwork(): NetworkType {
  return (state.currentAccount?.network as NetworkType | undefined) ?? state.settings.network;
}

function accountAddresses(): string[] {
  return state.currentAccount?.addresses.map(a => a.address) ?? [];
}

function renderChunkedSpans(target: HTMLElement, value: string, chunkLen = 4): void {
  const chunks = chunkLen === 4 ? chunkAddress(value) : (value.match(new RegExp(`.{1,${chunkLen}}`, 'g')) ?? [value]);
  target.replaceChildren(
    ...chunks.map(chunk => {
      const span = document.createElement('span');
      span.className = 'address-chunk';
      span.textContent = chunk;
      return span;
    }),
  );
}

function resolveExpiryIso(now: Date): { expires?: string; error?: string } {
  const preset = ($<HTMLSelectElement>('player-cert-expires-preset')?.value) ?? 'none';
  if (preset === 'none') return {};
  if (preset === '24h') {
    return { expires: formatCertIsoTime(new Date(now.getTime() + 24 * 60 * 60 * 1000)) };
  }
  if (preset === '7d') {
    return { expires: formatCertIsoTime(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)) };
  }
  if (preset === '30d') {
    return { expires: formatCertIsoTime(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)) };
  }
  if (preset === 'custom') {
    const raw = ($<HTMLInputElement>('player-cert-expires-custom')?.value ?? '').trim();
    if (!raw) {
      return { error: 'Pick a UTC expiry date and time, or choose "Until licence ends".' };
    }
    const parsed = new Date(raw.endsWith('Z') ? raw : `${raw}:00Z`.replace(/:00:00Z$/, ':00Z'));
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'Custom expiry time is invalid.' };
    }
    if (parsed.getTime() <= now.getTime()) {
      return { error: 'Expiry time must be in the future.' };
    }
    return { expires: formatCertIsoTime(parsed) };
  }
  return {};
}

function clearSignedResult(): void {
  lastSignedCert = null;
  $('player-cert-result')?.classList.add('hidden');
  const out = $<HTMLTextAreaElement>('player-cert-output');
  if (out) out.value = '';
  $('player-cert-qr')?.replaceChildren();
}

function currentDraft(now: Date = new Date()): { fields: PlayerCertFields; message: string } | { error: string } {
  const address = $<HTMLSelectElement>('player-cert-address')?.value ?? '';
  if (!address) {
    return { error: 'No wallet address is available on this network.' };
  }
  const keyInput = $<HTMLTextAreaElement>('player-cert-key-input')?.value ?? '';
  const extracted = extractPlayerKey(keyInput);
  if ('error' in extracted) {
    return extracted;
  }
  const expiry = resolveExpiryIso(now);
  if (expiry.error) {
    return { error: expiry.error };
  }
  if (!currentSerial) {
    currentSerial = generatePlayerCertSerial();
  }
  const fields: PlayerCertFields = {
    domain: DEFAULT_LICENCE_DOMAIN,
    network: activeNetwork(),
    address,
    player: extracted.player,
    serial: currentSerial,
    issued: formatCertIsoTime(now),
    ...(expiry.expires ? { expires: expiry.expires } : {}),
  };
  try {
    const message = buildPlayerCertMessage(fields);
    return { fields, message };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : 'Invalid player certificate fields' };
  }
}

export function refreshPlayerCertPreview(): void {
  const preview = $<HTMLElement>('player-cert-preview');
  const statusEl = $<HTMLElement>('player-cert-key-status');
  const signBtn = $<HTMLButtonElement>('player-cert-sign-btn');
  const customGroup = $<HTMLElement>('player-cert-custom-group');
  const preset = $<HTMLSelectElement>('player-cert-expires-preset')?.value ?? 'none';

  if (customGroup) {
    customGroup.classList.toggle('hidden', preset !== 'custom');
  }

  const rawInput = ($<HTMLTextAreaElement>('player-cert-key-input')?.value ?? '').trim();
  if (!rawInput) {
    preview?.classList.add('hidden');
    if (statusEl) {
      statusEl.textContent = '';
      delete statusEl.dataset.ok;
    }
    if (signBtn) signBtn.disabled = true;
    return;
  }

  const draft = currentDraft();
  if ('error' in draft) {
    preview?.classList.add('hidden');
    if (statusEl) {
      statusEl.textContent = draft.error;
      statusEl.dataset.ok = 'false';
    }
    if (signBtn) signBtn.disabled = true;
    return;
  }

  const { fields } = draft;
  if (statusEl) {
    statusEl.textContent = 'Valid 33-byte secp256k1 player key';
    statusEl.dataset.ok = 'true';
  }
  if (preview) {
    must('player-cert-preview-doc').textContent = PLAYER_CERT_TITLE;
    must('player-cert-preview-domain').textContent = fields.domain ?? DEFAULT_LICENCE_DOMAIN;
    must('player-cert-preview-network').textContent = NETWORKS[fields.network].name;
    must('player-cert-preview-scope').textContent = 'All licences held by this address (no coin spend)';
    renderChunkedSpans(must('player-cert-preview-holder'), fields.address, 4);
    renderChunkedSpans(must('player-cert-preview-player'), fields.player, 8);
    must('player-cert-preview-serial').textContent = fields.serial;
    must('player-cert-preview-expires').textContent = fields.expires ?? 'Until licence ends (no fixed expiry)';
    preview.classList.remove('hidden');
  }
  if (signBtn) signBtn.disabled = false;
}

function renderSignedResult(): void {
  if (!lastSignedCert) return;
  const format = ($<HTMLSelectElement>('player-cert-format')?.value as PlayerCertExportFormat | undefined) ?? 'text';
  const out = $<HTMLTextAreaElement>('player-cert-output');
  if (out) {
    out.value = exportPlayerCertificate(lastSignedCert, format);
  }
  const qrBox = $<HTMLElement>('player-cert-qr');
  if (qrBox) {
    qrBox.replaceChildren();
    const canvas = document.createElement('canvas');
    void QRCode.toCanvas(
      canvas,
      lastSignedCert.certificateText,
      { width: 220, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } },
      err => {
        if (!err) qrBox.replaceChildren(canvas);
      },
    );
  }
  $('player-cert-result')?.classList.remove('hidden');
}

function populateHolderSelect(): void {
  const select = $<HTMLSelectElement>('player-cert-address');
  if (!select) return;
  const addresses = accountAddresses();
  select.replaceChildren(
    ...addresses.map((address, i) => {
      const opt = document.createElement('option');
      opt.value = address;
      opt.textContent = `Address ${i + 1}: ${address.slice(0, 8)}...${address.slice(-6)}`;
      return opt;
    }),
  );
  if (addresses.length > 0) {
    select.value = addresses[0];
  }
}

export async function showPlayerCertView(): Promise<void> {
  await ensureNetworkAddresses();
  if (!state.currentAccount || accountAddresses().length === 0) {
    showToast('Create or unlock a wallet first', 'error');
    return;
  }
  currentSerial = generatePlayerCertSerial();
  clearSignedResult();
  populateHolderSelect();
  const scanTabBtn = $<HTMLButtonElement>('player-cert-scan-tab-btn');
  if (scanTabBtn) {
    scanTabBtn.classList.toggle('hidden', !canCaptureTab());
  }
  refreshPlayerCertPreview();
  showView(must('view-player-cert'));
}

async function applyDecodedQrText(decoded: string | null, emptyMsg: string): Promise<void> {
  if (!decoded) {
    showToast(emptyMsg, 'error');
    return;
  }
  const res = extractPlayerKey(decoded);
  if ('error' in res) {
    showToast(res.error, 'error');
    return;
  }
  const input = $<HTMLTextAreaElement>('player-cert-key-input');
  if (input) input.value = res.player;
  currentSerial = generatePlayerCertSerial();
  clearSignedResult();
  refreshPlayerCertPreview();
  showToast('Player public key scanned — check the details below before signing', 'success');
}

async function handleSignPlayerCert(): Promise<void> {
  const account = state.currentAccount;
  if (!account) {
    showToast('No wallet selected', 'error');
    return;
  }
  // Build fresh timestamp at signing time while preserving the reviewed serial & fields
  const draft = currentDraft(new Date());
  if ('error' in draft) {
    showToast(draft.error, 'error');
    return;
  }

  const password = await showPasswordModal('Enter password to sign player certificate');
  if (!password) return;

  try {
    showLoading('Signing player certificate...');
    const reply = await sendMessage<{ signature: string; address: string }>(MSG.SIGN_MESSAGE, {
      accountId: account.id,
      password,
      message: draft.message,
      address: draft.fields.address,
    });
    const fullText = formatSignedPlayerCertificate(draft.message, reply.signature);
    lastSignedCert = verifyPlayerCertificate(fullText, { expectedNetwork: draft.fields.network });
    renderSignedResult();
    showToast('Player certificate signed', 'success');
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : 'Could not sign player certificate', 'error');
  } finally {
    hideLoading();
  }
}

async function handleCopyPlayerCert(): Promise<void> {
  if (!lastSignedCert) return;
  const format = ($<HTMLSelectElement>('player-cert-format')?.value as PlayerCertExportFormat | undefined) ?? 'text';
  const signedCertificateOut = exportPlayerCertificate(lastSignedCert, format);
  try {
    await navigator.clipboard.writeText(signedCertificateOut);
    showToast('Player certificate copied to clipboard', 'success');
  } catch {
    showToast('Failed to copy certificate', 'error');
  }
}

function handleDownloadPlayerCert(): void {
  if (!lastSignedCert) return;
  const format = ($<HTMLSelectElement>('player-cert-format')?.value as PlayerCertExportFormat | undefined) ?? 'text';
  const body = exportPlayerCertificate(lastSignedCert, format);
  const ext = format === 'json' ? 'json' : format === 'base64' ? 'b64.txt' : 'txt';
  const mime = format === 'json' ? 'application/json' : 'text/plain;charset=utf-8';
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `divi-player-cert-${lastSignedCert.serial.slice(0, 8)}.${ext}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function setupPlayerCertUIHandlers(): void {
  $('player-cert-btn')?.addEventListener('click', () => void showPlayerCertView());
  $('settings-player-cert-btn')?.addEventListener('click', () => void showPlayerCertView());
  $('player-cert-back-btn')?.addEventListener('click', () => hideView());

  $('player-cert-address')?.addEventListener('change', () => {
    clearSignedResult();
    refreshPlayerCertPreview();
  });

  const keyInput = $<HTMLTextAreaElement>('player-cert-key-input');
  keyInput?.addEventListener('input', () => {
    currentSerial = generatePlayerCertSerial();
    clearSignedResult();
    refreshPlayerCertPreview();
  });

  // Allow pasting a screenshot image of the player's QR code directly without closing the popup
  keyInput?.addEventListener('paste', (e: ClipboardEvent) => {
    const file = e.clipboardData?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    e.preventDefault();
    void (async () => {
      try {
        const text = await qrTextFromFile(file);
        await applyDecodedQrText(text, 'No QR code found in pasted image');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'The pasted image could not be read', 'error');
      }
    })();
  });

  $('player-cert-scan-tab-btn')?.addEventListener('click', () => {
    void (async () => {
      try {
        const text = await qrTextFromVisibleTab();
        await applyDecodedQrText(text, 'No QR code found on this tab');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'Could not scan this tab', 'error');
      }
    })();
  });

  const qrFileInput = $<HTMLInputElement>('player-cert-qr-input');
  qrFileInput?.addEventListener('change', () => {
    const file = qrFileInput.files?.[0];
    qrFileInput.value = '';
    if (!file) return;
    void (async () => {
      try {
        const text = await qrTextFromFile(file);
        await applyDecodedQrText(text, 'No QR code found in that picture');
      } catch (err: unknown) {
        showToast(err instanceof Error ? err.message : 'The picture could not be read', 'error');
      }
    })();
  });

  $('player-cert-expires-preset')?.addEventListener('change', () => {
    clearSignedResult();
    refreshPlayerCertPreview();
  });
  $('player-cert-expires-custom')?.addEventListener('input', () => {
    clearSignedResult();
    refreshPlayerCertPreview();
  });

  $('player-cert-new-serial-btn')?.addEventListener('click', () => {
    currentSerial = generatePlayerCertSerial();
    clearSignedResult();
    refreshPlayerCertPreview();
  });

  $('player-cert-sign-btn')?.addEventListener('click', () => void handleSignPlayerCert());
  $('player-cert-format')?.addEventListener('change', () => renderSignedResult());
  $('player-cert-copy-btn')?.addEventListener('click', () => void handleCopyPlayerCert());
  $('player-cert-download-btn')?.addEventListener('click', handleDownloadPlayerCert);
}
