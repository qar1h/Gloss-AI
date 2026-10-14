// Which chat site a hostname belongs to. Pure (no DOM), so it is unit-tested; src/sites/index.ts
// turns the answer into an adapter.

export type SiteId = 'claude' | 'chatgpt';

const HOSTS = new Map<string, SiteId>([
  ['claude.ai', 'claude'],
  ['chatgpt.com', 'chatgpt'],
]);

/** Exact match only: a look-alike host must never select an adapter. */
export function siteForHostname(hostname: string): SiteId | null {
  return HOSTS.get(hostname) ?? null;
}
