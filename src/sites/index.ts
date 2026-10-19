// Picks the SiteAdapter for the page we are on. Everything outside src/sites/ goes through
// this, so adding a site means adding an adapter and one line in registry.ts.

import { chatgptAdapter } from './chatgpt';
import { claudeAdapter } from './claude';
import { siteForHostname } from './registry';
import type { SiteAdapter } from './types';

/** The adapter for the current page, or null on a site we don't support. */
export function getAdapter(): SiteAdapter | null {
  const site = siteForHostname(location.hostname);
  if (site === 'claude') return claudeAdapter;
  if (site === 'chatgpt') return chatgptAdapter;
  return null;
}

/** For code that only runs after the content script has decided the site is supported. */
export function requireAdapter(): SiteAdapter {
  const adapter = getAdapter();
  if (!adapter) throw new Error(`no site adapter for ${location.hostname}`);
  return adapter;
}
