/**
 * What a site may ask the wallet to sign. Checked in the background, before
 * any approval window opens, so the window only ever shows what was checked.
 */
import type { NetworkType } from '../shared/constants';
import { isGameOrigin } from '../shared/origin';
import {
  GAME_CHAINS, looksLikeGameTx, parseGameTx, parseSessionText, summarizeGameTx,
  type GameTx, type GameTxSummary, type SessionGrant,
} from '../lib/game-tx';
import { Hash } from '../lib/hash';
import { bytesToHex } from '../lib/hex';

// The prefix of the error a site gets for a transaction offered as a message
export const USE_SIGN_GAME_TX = 'USE_SIGN_GAME_TX:';

// The longest message the wallet signs: anything longer is kept in the
// pending request and drawn in the approval window, and could freeze both
export const MAX_MESSAGE_BYTES = 8 * 1024;

/** A message to sign, from a site or the popup, must be text of a sane length */
export function checkMessageShape(message: unknown): asserts message is string {
  if (typeof message !== 'string') throw new Error('The message must be a string');
  if (!message) throw new Error('The message is empty');
  if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
    throw new Error('The message is too long (8 KB at most)');
  }
}

/**
 * Check a plain message a site asks to have signed. A Divi Games transaction
 * body is refused (it must go through signGameTx, which shows what it does),
 * and a game session grant is taken only from the Divi Games site.
 * Returns the session grant, if the message is one, for the approval window.
 */
export function checkMessageToSign(
  message: unknown,
  origin: string,
  network: NetworkType,
  dev?: boolean,
): { session?: SessionGrant } {
  checkMessageShape(message);
  if (looksLikeGameTx(message)) {
    throw new Error(`${USE_SIGN_GAME_TX} this is a Divi Games transaction; sign it with signGameTx`);
  }
  const session = parseSessionText(message);
  if (!session) return {};
  if (!isGameOrigin(origin, dev)) {
    throw new Error('Only the Divi Games site may ask for a game session');
  }
  if (GAME_CHAINS[session.chain] !== network) {
    throw new Error('This game session is for another network');
  }
  return { session };
}

/**
 * Check a Divi Games transaction a site asks to have signed: from the Divi
 * Games site, for a chain on the wallet's network, signed by one of the
 * account's addresses. Returns the parsed body and what the owner is shown.
 */
export function checkGameTx(
  body: unknown,
  origin: string,
  network: NetworkType,
  addresses: string[],
  dev?: boolean,
): { tx: GameTx; summary: GameTxSummary } {
  if (!isGameOrigin(origin, dev)) {
    throw new Error('Only the Divi Games site may ask to sign a game transaction');
  }
  const tx = parseGameTx(body);
  if (GAME_CHAINS[tx.chain] !== network) {
    throw new Error(`Switch the wallet to ${GAME_CHAINS[tx.chain]} to sign for ${tx.chain}`);
  }
  if (!addresses.includes(tx.from)) {
    throw new Error('The transaction is not from an address in this wallet');
  }
  return { tx, summary: summarizeGameTx(tx) };
}

/** The chain's transaction id: hex SHA-256 of the body's bytes */
export function gameTxid(body: string): string {
  return bytesToHex(Hash.sha256(new TextEncoder().encode(body)));
}
