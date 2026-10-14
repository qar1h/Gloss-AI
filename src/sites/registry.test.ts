import { describe, expect, it } from 'vitest';
import { siteForHostname } from './registry';

describe('siteForHostname', () => {
  it('maps the supported chat sites', () => {
    expect(siteForHostname('claude.ai')).toBe('claude');
    expect(siteForHostname('chatgpt.com')).toBe('chatgpt');
  });

  it('is null for anything else, including look-alikes', () => {
    expect(siteForHostname('example.com')).toBeNull();
    expect(siteForHostname('claude.ai.evil.com')).toBeNull();
    expect(siteForHostname('notchatgpt.com')).toBeNull();
    expect(siteForHostname('www.chatgpt.com')).toBeNull();
    expect(siteForHostname('')).toBeNull();
  });

  it('does not pick up Object.prototype keys', () => {
    expect(siteForHostname('constructor')).toBeNull();
    expect(siteForHostname('__proto__')).toBeNull();
  });
});
