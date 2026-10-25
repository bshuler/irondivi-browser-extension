// What a site is told when a request fails: the IronDivi Connect error codes
// (irondivi-connect SPEC.md), shared by the background and the in-page provider

export const ERR = {
  REJECTED: 4001,         // the owner said no
  NOT_CONNECTED: 4100,    // connect first
  UNSUPPORTED: 4200,      // a method or option this wallet does not do
  ACCESS_REQUIRED: 4300,  // the site is not allowed: ask with requestAccess first
  BLOCKED: 4301,          // the site is blocked; it cannot ask
  LOCKED: 4900,           // the wallet is locked
  NETWORK_MISMATCH: 4901, // the wallet is on the other network
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

// What a site may ask for beyond the base API (window.irondivi.capabilities):
// "memo" = sendTransaction attaches memo, unchanged, in one OP_RETURN output
export const CAPABILITIES: readonly string[] = Object.freeze(['memo']);

// The code for a failure the background did not give one
export function errorCode(message: string | undefined): number {
  const m = message ?? '';
  if (/^ACCESS_REQUIRED/.test(m)) return ERR.ACCESS_REQUIRED;
  if (/^BLOCKED/.test(m)) return ERR.BLOCKED;
  if (/rejected|denied/i.test(m)) return ERR.REJECTED;
  if (/not[ _]connected|no longer connected/i.test(m)) return ERR.NOT_CONNECTED;
  if (/^unsupported/i.test(m)) return ERR.UNSUPPORTED;
  if (/locked|not authenticated/i.test(m)) return ERR.LOCKED;
  if (/network/i.test(m)) return ERR.NETWORK_MISMATCH;
  if (/invalid|required|must be|too long|empty|below the dust/i.test(m)) return ERR.INVALID_PARAMS;
  return ERR.INTERNAL;
}
