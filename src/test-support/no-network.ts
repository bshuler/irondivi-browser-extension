// No unit test reaches a real server. The default server tries IronDivi's public Electrum first, so
// without this every RPC-path test would open a socket to electrum.irondivi.com; here that fails at
// once and the background falls back to the (mocked) RPC proxy. A test that wants Electrum sets
// chain.webSocket to its own class.
globalThis.WebSocket = class {
  constructor() {
    throw new Error('no network in unit tests');
  }
} as unknown as typeof WebSocket;
