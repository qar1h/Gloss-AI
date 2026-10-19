import { describe, expect, it } from 'vitest';
import { namespacePrefix, prefixRangeEnd } from './namespace';

const DEL = String.fromCharCode(0x7f); // the character right after '~' (0x7e)

describe('prefixRangeEnd', () => {
  const inRange = (key: string, prefix: string) => key >= prefix && key < prefixRangeEnd(prefix);

  it('bounds exactly the keys that start with the prefix', () => {
    const prefix = 'chat1~';
    expect(inRange('chat1~', prefix)).toBe(true);
    expect(inRange('chat1~a1b2', prefix)).toBe(true);
    expect(inRange('chat1~zzzz~tail', prefix)).toBe(true);
    expect(inRange('chat1', prefix)).toBe(false);
    expect(inRange('chat2~a1b2', prefix)).toBe(false);
    expect(inRange('chat1}x', prefix)).toBe(false); // sorts just below the prefix
    expect(inRange(`chat1${DEL}x`, prefix)).toBe(false); // sorts just above it
  });

  it('never contains a character Chrome refuses to load in a script (a noncharacter or a lone surrogate)', () => {
    // The first version used the escape for U+FFFF as the upper bound; the bundler wrote it out as
    // that raw character and Chrome rejected the whole content script as "not UTF-8".
    for (const prefix of ['a~', 'chat1~', '6acf73f9-4a00-83e8-9c29-2b25edf40e55~']) {
      for (const ch of prefixRangeEnd(prefix)) {
        const cp = ch.codePointAt(0)!;
        expect((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe).toBe(false);
        expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
      }
    }
  });

  it('is the prefix with its last character incremented', () => {
    expect(prefixRangeEnd('abc~')).toBe(`abc${DEL}`);
  });
});

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
