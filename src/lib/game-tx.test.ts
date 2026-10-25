import { describe, expect, it } from 'vitest';
import { formatTokenAmount, looksLikeGameTx, parseGameTx, parseSessionText, summarizeGameTx } from './game-tx';
import { checkGameTx, checkMessageToSign, gameTxid, USE_SIGN_GAME_TX } from '../background/sign-policy';

// EXT-4: Divi Games transactions are signed as transactions, shown for what
// they do, and only for the Divi Games site

const FROM = 'yFromAddressxxxxxxxxxxxxxxxxxxxxxx';
const GAMES = 'https://games.divi.domains';

// What the games' txBody() makes
function body(action: Record<string, unknown>, memo?: string, chain = 'divi-games-testnet-1'): string {
  return JSON.stringify({ v: 1, chain, from: FROM, nonce: 7, action, ...(memo === undefined ? {} : { memo }) });
}

const transfer = { type: 'transfer', to: 'yRecipient', token: 'GOLD', amount: '123456' };
const withdraw = { type: 'bridge', op: { kind: 'withdraw', amount: '150000000', divi_address: 'yDiviOut' } };

describe('parseGameTx', () => {
  it('accepts what txBody makes, for every action shape the chain has', () => {
    for (const a of [transfer, withdraw,
      { type: 'faucet', token: 'GOLD' },
      { type: 'game', game: 'ttt', op: { move: 4 } },
      { type: 'market', op: { kind: 'place' } },
      { type: 'session', owner: FROM, until: 1800000000, sig: 'c2ln' },
    ]) {
      expect(parseGameTx(body(a)).action).toEqual(a);
    }
    expect(parseGameTx(body(transfer, 'hi')).memo).toBe('hi');
  });

  it('refuses anything that is not exactly the canonical body', () => {
    const good = body(transfer);
    const bad = [
      good.replace('{"v":1', '{ "v":1'),                                   // whitespace
      good.replace('"v":1,', '"v":1,"v":1,'),                              // duplicate key
      JSON.stringify({ chain: 'divi-games-testnet-1', v: 1, from: FROM, nonce: 7, action: transfer }), // order
      JSON.stringify({ v: 1, chain: 'divi-games-testnet-1', from: FROM, nonce: 7, action: transfer, x: 1 }),
      body(transfer).replace('"v":1', '"v":2'),
      body(transfer, undefined, 'divi-games-mainnet-9'),
      body(transfer, 'x'.repeat(141)),
      body({ type: 'market', op: 'place' }),                               // op must be an object
      body({ type: '' }),
      good.replace('"nonce":7', '"nonce":-1'),
      good.replace('"nonce":7', '"nonce":1.5'),
      body({ type: 'x', pad: 'a'.repeat(9000) }),
      '[1]', 'not json', 42,
    ];
    for (const b of bad) expect(() => parseGameTx(b), String(b).slice(0, 80)).toThrow();
  });
});

describe('summarizeGameTx', () => {
  const rows = (s: ReturnType<typeof summarizeGameTx>) => Object.fromEntries(s.rows.map(r => [r.label, r.value]));

  it('shows a transfer as recipient and amount, with the token\'s own decimals', () => {
    const s = summarizeGameTx(parseGameTx(body(transfer, 'gg')));
    expect(s.title).toBe('Transfer');
    expect(s.movesFunds).toBe(true);
    expect(rows(s)).toMatchObject({ To: 'yRecipient', Amount: '1234.56 GOLD', From: FROM, Nonce: '7', Memo: 'gg' });
  });

  it('shows a bridge withdraw as a Divi address and a tDIVI amount', () => {
    const s = summarizeGameTx(parseGameTx(body(withdraw)));
    expect(s.title).toBe('Bridge withdraw to Divi');
    expect(s.movesFunds).toBe(true);
    expect(rows(s)).toMatchObject({ 'To Divi address': 'yDiviOut', Amount: '1.5 TDIVI' });
  });

  it('shows the fields of an action it does not know, and warns of funds', () => {
    const s = summarizeGameTx(parseGameTx(body({ type: 'market', op: { kind: 'place', price: '5', qty: 2 } })));
    expect(s.title).toBe('market: place');
    expect(s.movesFunds).toBe(true);
    expect(rows(s)).toMatchObject({ price: '5', qty: '2' });
    const g = summarizeGameTx(parseGameTx(body({ type: 'game', game: 'ttt', op: { move: 4 } })));
    expect(g.title).toBe('ttt move');
    expect(rows(g)).toMatchObject({ move: '4' });
  });

  it('a faucet claim moves no funds', () => {
    expect(summarizeGameTx(parseGameTx(body({ type: 'faucet', token: 'GOLD' }))).movesFunds).toBe(false);
  });

  it('decimals come from the wallet, never the request', () => {
    expect(formatTokenAmount('100000', 'GOLD')).toBe('1000 GOLD');
    expect(formatTokenAmount('5', 'GEMS')).toBe('5 base units of GEMS');
    expect(() => formatTokenAmount('1.5', 'GOLD')).toThrow();
    expect(() => formatTokenAmount(15, 'GOLD')).toThrow();
  });
});

describe('signMessage refuses a transaction body', () => {
  it('refuses canonical and non-canonical bodies alike', () => {
    for (const m of [body(withdraw), ` ${body(transfer)} `, '{"action":{"type":"transfer"},"nonce":1', '{"chain":"x","action":{}}']) {
      expect(() => checkMessageToSign(m, GAMES, 'testnet'), m).toThrow(USE_SIGN_GAME_TX);
    }
  });

  it('plain text still signs', () => {
    expect(checkMessageToSign('Log in to Divi Games: nonce 123', 'https://example.org', 'testnet')).toEqual({});
    expect(() => checkMessageToSign(5, GAMES, 'testnet')).toThrow();
  });

  const session = 'Divi Games session: key yKey123 may play as this address on divi-games-testnet-1 until 2026-11-01T00:00:00Z';

  it('a session grant is read for the approval window, from the games site only', () => {
    expect(checkMessageToSign(session, GAMES, 'testnet')).toEqual({
      session: { key: 'yKey123', chain: 'divi-games-testnet-1', until: '2026-11-01T00:00:00Z' },
    });
    expect(() => checkMessageToSign(session, 'https://evil.example', 'testnet')).toThrow(/Divi Games site/);
    expect(() => checkMessageToSign(session, GAMES, 'mainnet')).toThrow(/another network/);
    expect(() => checkMessageToSign(`${session}\nand more`, GAMES, 'testnet')).toThrow(/Malformed/);
    expect(parseSessionText('hello')).toBeNull();
  });
});

describe('checkGameTx', () => {
  it('takes a transaction only from the games site, on its network, from the wallet', () => {
    const b = body(transfer);
    expect(checkGameTx(b, GAMES, 'testnet', [FROM]).summary.title).toBe('Transfer');
    expect(() => checkGameTx(b, 'https://games.divi.domains.evil.example', 'testnet', [FROM])).toThrow(/Divi Games site/);
    expect(() => checkGameTx(b, 'http://games.divi.domains', 'testnet', [FROM])).toThrow(/Divi Games site/);
    expect(() => checkGameTx(b, 'http://localhost:8080', 'testnet', [FROM], false)).toThrow(/Divi Games site/);
    expect(checkGameTx(b, 'http://localhost:8080', 'testnet', [FROM], true).tx.from).toBe(FROM);
    expect(() => checkGameTx(b, GAMES, 'mainnet', [FROM])).toThrow(/Switch the wallet to testnet/);
    expect(() => checkGameTx(b, GAMES, 'testnet', ['ySomeoneElse'])).toThrow(/not from an address/);
  });

  it('the txid is the hex SHA-256 of the body, as the chain computes it', () => {
    expect(gameTxid('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('looksLikeGameTx', () => {
  it('leaves ordinary JSON alone', () => {
    expect(looksLikeGameTx('{"login":"nonce 5"}')).toBe(false);
    expect(looksLikeGameTx('plain')).toBe(false);
  });
});
