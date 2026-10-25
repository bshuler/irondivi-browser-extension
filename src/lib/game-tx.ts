/**
 * Divi Games chain transactions. A game asks the wallet to sign the exact
 * JSON text of a transaction body; the chain checks a Divi signed-message
 * signature over those bytes. The wallet signs it only through signGameTx,
 * which shows the owner what the transaction does, never through
 * signMessage, which would show it as an opaque text.
 */
import type { NetworkType } from '../shared/constants';

// The Divi Games chains the wallet signs for, and the Divi network each
// one's addresses belong to
export const GAME_CHAINS: Record<string, NetworkType> = {
  'divi-games-testnet-1': 'testnet',
};

// Decimals of the chain's built-in tokens. Fixed here, never taken from the
// request: a site could otherwise make 1000 GOLD read as 10.
export const KNOWN_TOKENS: Record<string, number> = { GOLD: 2, TDIVI: 8 };

export const MAX_BODY_BYTES = 8 * 1024;
const MAX_MEMO_CHARS = 140;

export interface GameTx {
  v: 1;
  chain: string;
  from: string;
  nonce: number;
  // Module actions (game, market, bridge, ...) carry an object `op`, whose
  // `kind` names what it does
  action: { type: string; op?: Record<string, unknown>; [k: string]: unknown };
  memo?: string;
}

export interface GameTxRow { label: string; value: string }

export interface GameTxSummary {
  // A one-line title, such as "Transfer" or "Bridge withdraw"
  title: string;
  rows: GameTxRow[];
  // Whether the transaction moves value out of the signer
  movesFunds: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse a transaction body, refusing anything that is not exactly what the
 * games' txBody() makes. The body must read back to itself through
 * JSON.parse and JSON.stringify, so there are no duplicate keys, no
 * whitespace and no second meaning for another parser to find.
 */
export function parseGameTx(body: unknown): GameTx {
  if (typeof body !== 'string') throw new Error('The transaction must be a string');
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new Error('The transaction is too long');
  let tx: unknown;
  try {
    tx = JSON.parse(body);
  } catch {
    throw new Error('The transaction is not JSON');
  }
  if (!isObject(tx)) throw new Error('The transaction is not a JSON object');
  if (JSON.stringify(tx) !== body) throw new Error('The transaction is not in its canonical form');

  const keys = Object.keys(tx);
  const expected = 'memo' in tx
    ? ['v', 'chain', 'from', 'nonce', 'action', 'memo']
    : ['v', 'chain', 'from', 'nonce', 'action'];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error('The transaction has unexpected fields');
  }
  if (tx.v !== 1) throw new Error('Unsupported transaction version');
  if (typeof tx.chain !== 'string' || !(tx.chain in GAME_CHAINS)) throw new Error('Unknown Divi Games chain');
  if (typeof tx.from !== 'string' || !tx.from) throw new Error('The transaction has no signer');
  if (!Number.isSafeInteger(tx.nonce) || (tx.nonce as number) < 0) throw new Error('Bad transaction nonce');
  if (!isObject(tx.action) || typeof tx.action.type !== 'string' || !tx.action.type) {
    throw new Error('The transaction has no action type');
  }
  if ('op' in tx.action && !isObject(tx.action.op)) throw new Error('The action op must be an object');
  if ('memo' in tx) {
    if (typeof tx.memo !== 'string' || [...tx.memo].length > MAX_MEMO_CHARS) throw new Error('Bad memo');
  }
  return tx as unknown as GameTx;
}

/**
 * Whether a text, offered to signMessage, is a Divi Games transaction body.
 * Loose on purpose: anything shaped like one is refused there, canonical or
 * not, so a site cannot get a transaction signed as a plain message.
 */
export function looksLikeGameTx(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const v = JSON.parse(trimmed);
    return isObject(v) && 'action' in v && ('chain' in v || 'nonce' in v);
  } catch {
    // Not JSON a parser accepts; still refuse anything that names the fields
    return /"action"\s*:/.test(trimmed) && /"(chain|nonce)"\s*:/.test(trimmed);
  }
}

// The text the games' sessionText() makes
const SESSION_TEXT = /^Divi Games session: key (\S+) may play as this address on (\S+) until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/;

export interface SessionGrant { key: string; chain: string; until: string }

/** The grant a session text makes, or null if the text is not one */
export function parseSessionText(message: string): SessionGrant | null {
  // Any text that starts like one is held to the exact form
  if (!message.startsWith('Divi Games session:')) return null;
  const m = SESSION_TEXT.exec(message);
  if (!m) throw new Error('Malformed Divi Games session text');
  return { key: m[1], chain: m[2], until: m[3] };
}

/**
 * An amount of base units as the token's own unit, for a known token.
 * Other tokens are user-created; their decimals come from the chain, which
 * the wallet does not ask, so they are shown in base units.
 */
export function formatTokenAmount(amount: unknown, token: unknown): string {
  if (typeof amount !== 'string' || !/^\d{1,40}$/.test(amount)) throw new Error('Bad amount');
  const sym = typeof token === 'string' ? token : '';
  const decimals = KNOWN_TOKENS[sym];
  if (decimals === undefined) return `${BigInt(amount).toString()} base units of ${sym || '?'}`;
  const digits = BigInt(amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${frac ? `${whole}.${frac}` : whole} ${sym}`;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`The transaction has no ${what}`);
  return v;
}

/**
 * What the owner is shown for a transaction. Fields the wallet does not
 * understand are listed whole, so nothing in the action is hidden.
 */
export function summarizeGameTx(tx: GameTx): GameTxSummary {
  const a = tx.action;
  const op = a.op;
  const kind = typeof op?.kind === 'string' ? op.kind : '';
  const rows: GameTxRow[] = [];
  let title: string;
  const shown = new Set(['type']);
  const opShown = new Set<string>();

  if (a.type === 'transfer') {
    title = 'Transfer';
    rows.push({ label: 'To', value: str(a.to, 'recipient') });
    rows.push({ label: 'Amount', value: formatTokenAmount(a.amount, a.token) });
    shown.add('to').add('amount').add('token');
  } else if (a.type === 'bridge' && kind === 'withdraw') {
    title = 'Bridge withdraw to Divi';
    rows.push({ label: 'To Divi address', value: str(op!.divi_address, 'Divi address') });
    rows.push({ label: 'Amount', value: formatTokenAmount(op!.amount, 'TDIVI') });
    shown.add('op');
    opShown.add('kind').add('divi_address').add('amount');
  } else if (a.type === 'burn') {
    title = 'Burn';
    rows.push({ label: 'Amount', value: formatTokenAmount(a.amount, a.token) });
    shown.add('amount').add('token');
  } else if (a.type === 'session') {
    title = 'Start a game session';
    if (typeof a.owner === 'string') rows.push({ label: 'Plays as', value: a.owner });
    if (typeof a.until === 'number') {
      rows.push({ label: 'Until', value: new Date(a.until * 1000).toISOString() });
    }
    shown.add('owner').add('until');
  } else {
    title = kind ? `${a.type}: ${kind}` : a.type;
    if (typeof a.game === 'string') {
      title = kind ? `${a.game}: ${kind}` : `${a.game} move`;
      shown.add('game');
    }
    opShown.add('kind');
  }

  for (const [k, v] of Object.entries(a)) {
    if (shown.has(k)) continue;
    if (k === 'op' && op) {
      for (const [ok, ov] of Object.entries(op)) {
        if (opShown.has(ok)) continue;
        rows.push({ label: ok, value: typeof ov === 'string' ? ov : JSON.stringify(ov) });
      }
      continue;
    }
    rows.push({ label: k, value: typeof v === 'string' ? v : JSON.stringify(v) });
  }
  rows.push({ label: 'From', value: tx.from });
  rows.push({ label: 'Chain', value: tx.chain });
  rows.push({ label: 'Nonce', value: String(tx.nonce) });
  if (tx.memo) rows.push({ label: 'Memo', value: tx.memo });
  return { title, rows, movesFunds: movesFunds(a) };
}

// Actions that cannot move value out of the signer. Everything else, games
// and modules included (a market order or a game stake moves funds), is
// shown with the funds warning.
const NO_FUNDS = new Set(['faucet', 'session', 'session_end']);

function movesFunds(a: GameTx['action']): boolean {
  return !NO_FUNDS.has(a.type);
}
