/**
 * Settings -> Server (design §6): three choices per network, Test, Save only
 * after a passing Test, a label on the home screen when the server is not the
 * default, and a banner when the chosen server cannot be reached.
 */
import { MSG, NETWORKS } from '../shared/constants';
import { PUBLIC_ELECTRUM, serverLabel, type ServerChoice, type ServerMode } from '../shared/server-config';
import { sendMessage } from './message-api';
import { state } from './state';
import { showToast } from './ui-state';

interface Status {
  config: Record<string, ServerChoice>;
  sessionDefault: boolean;
  problem: string | null;
}
interface Check { ok: boolean; message: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
let passedKey: string | null = null;

function selectedMode(): ServerMode {
  const picked = document.querySelector<HTMLInputElement>('input[name="server-mode"]:checked');
  return (picked?.value as ServerMode) ?? 'default';
}

function candidate(): string {
  return `${state.settings.network} ${selectedMode()} ${selectedMode() === 'own' ? $<HTMLInputElement>('server-url')?.value.trim() : ''}`;
}

function syncButtons(): void {
  const mode = selectedMode();
  const url = $<HTMLInputElement>('server-url');
  if (url) url.disabled = mode !== 'own';
  const test = $<HTMLButtonElement>('server-test-btn');
  if (test) test.disabled = mode === 'default';
  const save = $<HTMLButtonElement>('server-save-btn');
  if (save) save.disabled = mode !== 'default' && passedKey !== candidate();
}

function say(text: string, ok: boolean | null): void {
  const out = $('server-result');
  if (!out) return;
  out.textContent = text;
  if (ok === null) out.removeAttribute('data-ok'); else out.dataset.ok = String(ok);
}

/** Draw the Server screen, the home label and the banner from the background's answer */
export async function refreshServerUI(): Promise<void> {
  let status: Status;
  try {
    status = await sendMessage<Status>(MSG.GET_SERVER);
  } catch {
    return;
  }
  const network = state.settings.network;
  const choice = status.config[network] ?? { mode: 'default' as ServerMode };
  const using: ServerChoice = status.sessionDefault ? { mode: 'default' } : choice;

  const heading = $('server-heading');
  if (heading) heading.textContent = `Server for ${NETWORKS[network].name}`;
  const radio = document.querySelector<HTMLInputElement>(`input[name="server-mode"][value="${choice.mode}"]`);
  if (radio && !document.getElementById('server-section')?.contains(document.activeElement)) radio.checked = true;
  const url = $<HTMLInputElement>('server-url');
  if (url && choice.mode === 'own' && document.activeElement !== url) url.value = choice.url ?? '';
  const usingText = $('server-using');
  if (usingText) {
    usingText.textContent = `Using: ${serverLabel(using)}` +
      (status.sessionDefault ? ' (until you close the wallet)' : '');
  }

  const label = $('server-label');
  if (label) {
    // Shown while the setting is not the default, even when IronDivi stands in for the session
    label.textContent = status.sessionDefault ? 'IronDivi (standard) until you close the wallet' : serverLabel(choice);
    label.classList.toggle('hidden', choice.mode === 'default');
  }

  const banner = $('server-banner');
  const bannerText = $('server-banner-text');
  if (banner && bannerText) {
    const down = !!status.problem && !status.sessionDefault && choice.mode !== 'default';
    banner.classList.toggle('hidden', !down);
    if (down) {
      bannerText.textContent = choice.mode === 'own'
        ? `${status.problem}. Turn on Tailscale, or use IronDivi until you close the wallet.`
        : `${status.problem}. Use IronDivi until you close the wallet.`;
    }
  }
  syncButtons();
}

async function test(): Promise<void> {
  const mode = selectedMode();
  const typed = $<HTMLInputElement>('server-url')?.value.trim() ?? '';
  const url = mode === 'public' ? PUBLIC_ELECTRUM[state.settings.network] : typed;
  say('Testing…', null);
  try {
    const check = await sendMessage<Check>(MSG.TEST_SERVER, { url });
    say(check.message, check.ok);
    passedKey = check.ok ? candidate() : null;
  } catch (e) {
    say(e instanceof Error ? e.message : 'The test failed', false);
    passedKey = null;
  }
  syncButtons();
}

async function save(): Promise<void> {
  const mode = selectedMode();
  const payload = { network: state.settings.network, mode, url: $<HTMLInputElement>('server-url')?.value.trim() };
  try {
    await sendMessage(MSG.SET_SERVER, payload);
    showToast('Server saved', 'success');
    say('', null);
    passedKey = null;
    await refreshServerUI();
  } catch (e) {
    say(e instanceof Error ? e.message : 'Could not save', false);
  }
}

export function setupServerUIHandlers(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="server-mode"]').forEach(r =>
    r.addEventListener('change', () => { passedKey = null; say('', null); syncButtons(); }));
  $('server-url')?.addEventListener('input', () => { passedKey = null; say('', null); syncButtons(); });
  $('server-test-btn')?.addEventListener('click', () => void test());
  $('server-save-btn')?.addEventListener('click', () => void save());
  $('server-banner-default')?.addEventListener('click', async () => {
    try {
      await sendMessage(MSG.USE_DEFAULT_SERVER_SESSION);
      await refreshServerUI();
    } catch { /* the banner stays */ }
  });
}
