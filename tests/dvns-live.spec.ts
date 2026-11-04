// Divi Name Service on the real testnet, through the dev build. Skipped
// unless DVNS_LIVE=<work dir> is set: it spends real testnet DIVI and needs
// the dev name service tunnelled to this machine:
//   ssh -N -L 8790:localhost:8790 hp3 &
//   IRONDIVI_DEV=1 IRONDIVI_DVNS_API=http://127.0.0.1:8790/api/v1 IRONDIVI_OUTDIR=dist/dvns node esbuild.config.js chrome
//   EXT_PATH=1 DVNS_LIVE=<dir> DVNS_LIVE_STEP=<step> npx playwright test tests/dvns-live.spec.ts
// (EXT_PATH skips the global build, which would not carry the API override)
// <dir> holds mnemonic.txt (a testnet-only phrase, never in git, never
// printed; its first address funded beforehand), the browser profile and
// state.json. A record or payment needs a block before the next step uses it,
// so each step is its own run, and the caller waits for the block between
// them:
//   setup     import the wallet, lift the per-send limits (a name costs 500)
//   register  register a new name in the popup's Names view
//   check     the name resolves to the wallet's address
//   send      send 1 DIVI to the name from the Send view; the tx pays the
//             resolved address
//   page      register a second name on the name service's own page, paid
//             through window.irondivi
import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Transaction } from '../src/lib/transaction';
import { Address } from '../src/lib/address';
import { resolveLaunch } from './browser';

const DIR = process.env.DVNS_LIVE || '';
const STEP = process.env.DVNS_LIVE_STEP || '';
const EXT = process.env.DVNS_EXT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/dvns/chrome');
const API = 'http://127.0.0.1:8790/api/v1';
const PAGE = 'http://127.0.0.1:8790/?network=testnet';
const RPC = 'https://services.divi.domains/api/testnet/rpc/';
const PASSWORD = 'DvnsLive-Password-1!';

test.skip(!DIR || !STEP, 'set DVNS_LIVE and DVNS_LIVE_STEP');
test.describe.configure({ retries: 0 });

type State = { address?: string; name?: string; pageName?: string; registerTxid?: string; sendTxid?: string; pageTxid?: string };
const stateFile = () => path.join(DIR, 'state.json');
const load = (): State => (fs.existsSync(stateFile()) ? JSON.parse(fs.readFileSync(stateFile(), 'utf8')) : {});
const save = (s: State) => fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));

function letters(n: number): string {
  return Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
}

async function launch(): Promise<{ context: BrowserContext; id: string; broadcasts: string[] }> {
  const context = await chromium.launchPersistentContext(path.join(DIR, 'profile'), {
    ...resolveLaunch(),
    headless: process.env.PW_HEADED !== '1',
    viewport: { width: 400, height: 600 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  // Every transaction the wallet broadcasts, as raw hex
  const broadcasts: string[] = [];
  context.on('request', req => {
    if (!req.url().startsWith(RPC) || req.method() !== 'POST') return;
    try {
      const body = req.postDataJSON();
      if (body?.method === 'sendrawtransaction') broadcasts.push(body.params[0]);
    } catch { /* not JSON */ }
  });
  return { context, id: sw.url().split('/')[2], broadcasts };
}

async function popup(context: BrowserContext, id: string): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  return p;
}

async function msg(p: Page, type: string, payload?: unknown): Promise<any> {
  return p.evaluate(([type, payload]) => chrome.runtime.sendMessage({ type, payload }), [type, payload] as const);
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
  return (await r.json()).result;
}

function payTo(address: string): string {
  return Address.outputScript(address, 'testnet');
}

const hex = (s: Uint8Array | string) => (typeof s === 'string' ? s : Buffer.from(s).toString('hex'));

/** The one broadcast this step made, decoded */
async function onlyBroadcast(broadcasts: string[]): Promise<Transaction> {
  await expect.poll(() => broadcasts.length, { timeout: 60000 }).toBe(1);
  return Transaction.fromHex(broadcasts[0]);
}

function opReturnText(tx: Transaction): string {
  const out = tx.outputs.find(o => hex(o.script).startsWith('6a'));
  if (!out) return '';
  const s = hex(out.script);
  const op = s.slice(2, 4);
  const start = op === '4c' ? 6 : op === '4d' ? 8 : 4;
  return Buffer.from(s.slice(start), 'hex').toString('utf8');
}

test('DVNS live', async () => {
  test.setTimeout(300000);
  const state = load();
  const { context, id, broadcasts } = await launch();
  try {
    if (STEP === 'setup') {
      const mnemonic = fs.readFileSync(path.join(DIR, 'mnemonic.txt'), 'utf8').trim();
      const p = await popup(context, id);
      if (!state.address) {
        await p.click('#onboard-import-btn');
        await p.fill('#import-name', 'DVNS live');
        await p.fill('#import-mnemonic', mnemonic);
        await p.fill('#import-password', PASSWORD);
        await p.click('#import-submit-btn');
      }
      await expect(p.locator('#balance-section')).toBeVisible({ timeout: 30000 });
      const accounts = await msg(p, 'GET_ACCOUNTS');
      const account = accounts.data.accounts.find((a: any) => a.id === accounts.data.currentAccountId);
      state.address = account.addresses[0].address;
      // A name costs 500 DIVI, more than the default 10 % of this balance
      const set = await msg(p, 'UPDATE_SETTINGS', {
        password: PASSWORD,
        transactionLimits: { maxAmountAbsolute: 0, maxAmountPercent: 0, dailyLimitAbsolute: 0, dailyLimitPercent: 0 },
      });
      expect(set.success, JSON.stringify(set)).toBe(true);
      const settings = await msg(p, 'GET_SETTINGS');
      expect(settings.data.settings.network).toBe('testnet');
      expect(settings.data.settings.transactionLimits.maxAmountPercent).toBe(0);
      save(state);
      console.log('wallet address', state.address);
      return;
    }

    const p = await popup(context, id);
    await expect(p.locator('#balance-section')).toBeVisible({ timeout: 30000 });

    if (STEP === 'register') {
      state.name = state.name || `lane${letters(6)}`;
      await p.click('#names-btn');
      await p.fill('#names-input', state.name);
      await p.click('#names-lookup-btn');
      await expect(p.locator('#names-result-status')).toHaveText('Available', { timeout: 20000 });
      await expect(p.locator('#names-result-fee')).toHaveText('500 DIVI');
      await expect(p.locator('#names-divi')).toHaveValue(state.address!);
      await p.click('#names-register-btn');
      await expect(p.locator('#view-send-confirm')).toBeVisible({ timeout: 20000 });
      await expect(p.locator('#confirm-purpose')).toContainText(`Register the name ${state.name}`);
      await expect(p.locator('#confirm-amount')).toContainText('500');
      console.log('confirm screen:', (await p.locator('#view-send-confirm').innerText()).replace(/\s+/g, ' '));
      await p.fill('#send-password', PASSWORD);
      const notified = p.waitForRequest(r => r.url() === `${API}/notify` && r.method() === 'POST', { timeout: 60000 });
      await p.click('#send-submit-btn');
      const tx = await onlyBroadcast(broadcasts);
      state.registerTxid = tx.txid();
      save(state);
      // Input 0 is the payer's coin, the fee goes to the registry, the
      // record is the memo, and the service was told
      const prev = await rpc('getrawtransaction', [tx.inputs[0].txid, 1]);
      expect(prev.vout[tx.inputs[0].vout].scriptPubKey.addresses).toEqual([state.address]);
      expect(tx.outputs.some(o => hex(o.script) === payTo('yKmDgfDZJmVTiPCkcWXfqGe1KAWL3bkXgx') && o.value === 500n * 100000000n)).toBe(true);
      const record = opReturnText(tx);
      expect(record.split('\n')).toEqual(expect.arrayContaining(['DVNS1', 'op=register', `name=${state.name}`, `divi=${state.address}`]));
      expect(JSON.parse((await notified).postData() || '{}').txid).toBe(state.registerTxid);
      console.log('registered', state.name, 'txid', state.registerTxid);
      return;
    }

    if (STEP === 'check') {
      const r = await fetch(`${API}/resolve/${state.name}?network=testnet`);
      const body = await r.json();
      expect(r.status, JSON.stringify(body)).toBe(200);
      expect(body.divi).toBe(state.address);
      expect(body.owner).toBe(state.address);
      // The popup sees it as this wallet's
      await p.click('#names-btn');
      await p.fill('#names-input', state.name!);
      await p.click('#names-lookup-btn');
      await expect(p.locator('#names-result-status')).toHaveText('Registered to this wallet', { timeout: 20000 });
      await expect(p.locator('#names-update-btn')).toBeVisible();
      console.log('resolve', state.name, '->', body.divi);
      return;
    }

    if (STEP === 'send') {
      // An unregistered name is refused, with nothing sent
      await p.click('#send-btn');
      await p.fill('#send-to', `nosuch${letters(8)}`);
      await p.fill('#send-amount', '1');
      await p.click('#send-confirm-btn');
      await expect(p.locator('#toast')).toContainText('is not registered', { timeout: 20000 });
      await expect(p.locator('#view-send-confirm')).toBeHidden();
      // The registered name: the confirm screen shows it and its address
      const resolved = await (await fetch(`${API}/resolve/${state.name}?network=testnet`)).json();
      await p.fill('#send-to', state.name!.toUpperCase());
      await p.click('#send-confirm-btn');
      await expect(p.locator('#view-send-confirm')).toBeVisible({ timeout: 20000 });
      await expect(p.locator('#confirm-name')).toHaveText(state.name!);
      expect((await p.locator('#confirm-to').innerText()).replace(/\s+/g, '')).toBe(resolved.divi);
      console.log('confirm screen:', (await p.locator('#view-send-confirm').innerText()).replace(/\s+/g, ' '));
      await p.fill('#send-password', PASSWORD);
      await p.click('#send-submit-btn');
      const tx = await onlyBroadcast(broadcasts);
      state.sendTxid = tx.txid();
      save(state);
      expect(tx.outputs.some(o => hex(o.script) === payTo(resolved.divi) && o.value === 100000000n)).toBe(true);
      console.log('sent 1 DIVI to', state.name, '=', resolved.divi, 'txid', state.sendTxid);
      return;
    }

    if (STEP === 'page') {
      state.pageName = state.pageName || `page${letters(6)}`;
      save(state);
      // A site connects only to an unlocked wallet
      const accounts = await msg(p, 'GET_ACCOUNTS');
      const auth = await msg(p, 'AUTHENTICATE', { accountId: accounts.data.currentAccountId, password: PASSWORD });
      expect(auth.success, JSON.stringify(auth)).toBe(true);
      // The dev build lets http://127.0.0.1 in; it still asks to connect
      const page = await context.newPage();
      await page.goto(PAGE);
      await page.waitForFunction(() => !!(window as any).irondivi, null, { timeout: 15000 });
      await page.fill('#q', state.pageName);
      await page.press('#q', 'Enter');
      await expect(page.locator('#pay-ext')).toBeVisible({ timeout: 20000 });
      const seen = new Set<Page>();
      const approval = async () => {
        for (const end = Date.now() + 60000; Date.now() < end; await new Promise(r => setTimeout(r, 250))) {
          const w = context.pages().find(x => !seen.has(x) && /approve=/.test(x.url()));
          if (w) { seen.add(w); await w.waitForLoadState('domcontentloaded'); return w; }
        }
        throw new Error('no approval window opened');
      };
      let win = approval();
      await page.click('#pay-ext');
      let w = await win;
      await expect(w.locator('#signing-type')).not.toHaveText('', { timeout: 15000 });
      // A site this wallet already let in skips straight to the send
      if ((await w.locator('#signing-type').textContent())?.trim() === 'Connect Site') {
        await w.click('#approve-request-btn');
      }
      // The send asks in a window of its own, or the same one once it moves on
      const sendWindow = async () => {
        for (const x of context.pages().filter(x => /approve=/.test(x.url()) && !x.isClosed())) {
          if ((await x.locator('#signing-type').textContent().catch(() => ''))?.trim() === 'Send Transaction') return x;
        }
        return null;
      };
      let found: Page | null = null;
      for (const end = Date.now() + 60000; !found && Date.now() < end; await new Promise(r => setTimeout(r, 250))) found = await sendWindow();
      if (!found) {
        const shown = await Promise.all(context.pages().filter(x => !x.isClosed()).map(async x => `${x.url()}: ${(await x.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)}`));
        throw new Error(`no send approval; page says: ${await page.locator('#reg-msg').innerText()}\n${shown.join('\n')}`);
      }
      w = found;
      const details = (await w.locator('#signing-details').innerText()).replace(/\s+/g, ' ');
      console.log('approval window:', details);
      expect(details).toContain('yKmDgfDZJmVTiPCkcWXfqGe1KAWL3bkXgx');
      expect(details).toContain(`name=${state.pageName}`);
      await w.fill('#signing-password', PASSWORD);
      const notified = page.waitForRequest(r => r.url().includes('/api/v1/notify') && r.method() === 'POST', { timeout: 60000 });
      await w.click('#approve-request-btn');
      const tx = await onlyBroadcast(broadcasts);
      state.pageTxid = tx.txid();
      save(state);
      expect(JSON.parse((await notified).postData() || '{}').txid).toBe(state.pageTxid);
      await expect(page.locator('#reg-msg')).toContainText('Sent', { timeout: 30000 });
      const prev = await rpc('getrawtransaction', [tx.inputs[0].txid, 1]);
      expect(prev.vout[tx.inputs[0].vout].scriptPubKey.addresses).toEqual([state.address]);
      expect(opReturnText(tx).split('\n')).toEqual(expect.arrayContaining(['DVNS1', 'op=register', `name=${state.pageName}`]));
      console.log('page registered', state.pageName, 'txid', state.pageTxid);
      return;
    }

    throw new Error(`unknown step ${STEP}`);
  } finally {
    await context.close();
  }
});
