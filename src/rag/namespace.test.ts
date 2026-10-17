import { describe, expect, it } from 'vitest';
import { namespacePrefix } from './namespace';

describe('namespacePrefix', () => {
  it('gives the part of a namespaced conversation id that is shared by every page load of the chat', () => {
    expect(namespacePrefix('abc-123~k9x2')).toBe('abc-123~');
    expect(namespacePrefix('6acf73f9-4a00-83e8-9c29-2b25edf40e55~lq1abc')).toBe('6acf73f9-4a00-83e8-9c29-2b25edf40e55~');
  });

  it('is null for a plain id (Claude: one persistent index per chat)', () => {
    expect(namespacePrefix('abc-123')).toBeNull();
    expect(namespacePrefix('')).toBeNull();
  });

  it('is null when there is nothing before the separator, so it can never match every chat', () => {
    expect(namespacePrefix('~k9x2')).toBeNull();
  });

  it('splits on the first separator only', () => {
    expect(namespacePrefix('a~b~c')).toBe('a~');
  });
});
