import { describe, expect, it } from 'vitest';
import { buildEmbedInputForChunk, buildSearchQueryText, extractSurroundingSentence } from './query';

describe('extractSurroundingSentence', () => {
  it('returns just the sentence containing the highlight, not the whole paragraph', () => {
    const paragraph = 'First sentence here. The highlighted part is in this one. Third sentence follows.';
    const result = extractSurroundingSentence(paragraph, 'highlighted part');
    expect(result).toBe('The highlighted part is in this one.');
    expect(result).not.toContain('First sentence');
    expect(result).not.toContain('Third sentence');
  });

  it('falls back to the whole paragraph if the highlight is not found in it', () => {
    const paragraph = 'Some paragraph text.';
    expect(extractSurroundingSentence(paragraph, 'not present anywhere')).toBe(paragraph);
  });
});

describe('buildSearchQueryText', () => {
  it('combines the highlight and its sentence, without the typed question (v3 has no such input)', () => {
    const paragraph = 'Intro sentence. The important bit explained here. Outro sentence.';
    const query = buildSearchQueryText('important bit', paragraph);
    expect(query).toContain('important bit');
    expect(query).toContain('The important bit explained here.');
    expect(query.split('\n')).toHaveLength(2);
  });

  it('appends a typed question when one is passed', () => {
    const query = buildSearchQueryText('foo', 'foo bar.', 'What does this mean?');
    expect(query).toContain('What does this mean?');
  });

  it('does not duplicate the highlight when it equals its own sentence', () => {
    const query = buildSearchQueryText('Just one sentence.', 'Just one sentence.');
    expect(query.split('\n')).toHaveLength(1);
  });
});

describe('buildEmbedInputForChunk', () => {
  it('returns the chunk text unchanged once it is long enough on its own', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(buildEmbedInputForChunk(longText, 'previous chunk text here', 'next chunk text here')).toBe(longText);
  });

  it('adds neighbor context for a tiny chunk, keeping the chunk itself intact', () => {
    const tiny = 'psql -h host -U user';
    const previous = 'Connect to the production database using this command:';
    const result = buildEmbedInputForChunk(tiny, previous, null);
    expect(result).toContain(tiny);
    expect(result).toContain('production database');
  });

  it('handles a tiny chunk with no neighbors at all', () => {
    const tiny = 'ls -la';
    expect(buildEmbedInputForChunk(tiny, null, null)).toBe(tiny);
  });
});
