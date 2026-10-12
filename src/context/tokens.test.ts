import { describe, expect, it } from 'vitest';
import { estimateTokens, trimMiddle, TRIM_MARKER, windowAround } from './tokens';

describe('estimateTokens', () => {
  it('is 0 for empty text', () => expect(estimateTokens('')).toBe(0));
  it('is chars / 4 rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('counts characters, so it undercounts non-Latin text (known, accepted)', () => {
    expect(estimateTokens('日本語のテキスト')).toBe(2);
  });
});

describe('trimMiddle', () => {
  const long = 'a'.repeat(1000) + 'MIDDLE' + 'z'.repeat(1000);

  it('leaves text that fits alone', () => {
    expect(trimMiddle('hello', 100)).toEqual({ text: 'hello', trimmed: false });
  });

  it('keeps the head and the tail, drops the middle, and marks the cut', () => {
    const result = trimMiddle(long, 100);
    expect(result.trimmed).toBe(true);
    expect(result.text.startsWith('aaaa')).toBe(true);
    expect(result.text.endsWith('zzzz')).toBe(true);
    expect(result.text).toContain(TRIM_MARKER);
    expect(result.text).not.toContain('MIDDLE');
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(100);
  });
});

describe('windowAround', () => {
  const text = 'x'.repeat(3000) + ' TARGET PARAGRAPH ' + 'y'.repeat(3000);

  it('leaves text that fits alone', () => {
    expect(windowAround('short', 'short', 100)).toEqual({ text: 'short', trimmed: false });
  });

  it('centres on the anchor and marks both cut ends', () => {
    const result = windowAround(text, 'TARGET PARAGRAPH', 200);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain('TARGET PARAGRAPH');
    expect(result.text.startsWith(TRIM_MARKER)).toBe(true);
    expect(result.text.endsWith(TRIM_MARKER)).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(200);
  });

  it('has no leading marker when the anchor is at the very start', () => {
    const result = windowAround('TARGET ' + 'y'.repeat(5000), 'TARGET', 200);
    expect(result.text.startsWith('TARGET')).toBe(true);
    expect(result.text.endsWith(TRIM_MARKER)).toBe(true);
  });

  it('falls back to head + tail trimming when the anchor is not in the text', () => {
    const result = windowAround('a'.repeat(1000) + 'z'.repeat(1000), 'not there', 100);
    expect(result.trimmed).toBe(true);
    expect(result.text.startsWith('aaa')).toBe(true);
    expect(result.text.endsWith('zzz')).toBe(true);
  });
});
