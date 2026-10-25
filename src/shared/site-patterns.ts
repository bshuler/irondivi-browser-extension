// The browser match patterns for the wallet's allowed-site patterns, used to
// register its scripts and to ask the browser for access to a site.

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/**
 * The match patterns that cover a list of site patterns. Ports are dropped
 * (a match pattern cannot name one), *. and **. both become *., and local
 * hosts are served over http (the only http origins a dApp may have).
 */
export function patternsFor(allowedSites: string[]): string[] {
  const out = new Set<string>();
  for (const raw of allowedSites) {
    if (typeof raw !== 'string') continue;
    let host = raw.trim().toLowerCase().replace(/:(\d+|\*)$/, '');
    host = host.replace(/^\*\*\./, '*.');
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) continue;
    out.add(LOCAL_HOSTS.includes(host) ? `http://${host}/*` : `https://${host}/*`);
  }
  return [...out];
}
