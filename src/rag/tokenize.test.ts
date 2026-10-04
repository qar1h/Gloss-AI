import { describe, expect, it } from 'vitest';
import { MAX_TOKEN_LENGTH, QUERY_STOPWORDS, tokenize, tokenizeQuery } from './tokenize';

describe('tokenize', () => {
  it('keeps a snake_case identifier whole and also emits its parts', () => {
    expect(tokenize('pool_pre_ping')).toEqual(['pool_pre_ping', 'pool', 'pre', 'ping']);
  });

  it('handles an UPPER_CASE identifier', () => {
    expect(tokenize('ERR_FAILED')).toEqual(['err_failed', 'err', 'failed']);
  });

  it('splits camelCase with an acronym in the middle', () => {
    expect(tokenize('getHTTPResponse')).toEqual(['gethttpresponse', 'get', 'http', 'response']);
  });

  it('splits an acronym at the start of a PascalCase name', () => {
    expect(tokenize('HTTPServer')).toEqual(['httpserver', 'http', 'server']);
  });

  it('splits a plain camelCase name', () => {
    expect(tokenize('getUserById')).toEqual(['getuserbyid', 'get', 'user', 'by', 'id']);
  });

  it('treats dots as separators', () => {
    expect(tokenize('os.path.join')).toEqual(['os', 'path', 'join']);
  });

  it('treats hyphens as separators', () => {
    expect(tokenize('pre-ping the connection')).toEqual(['pre', 'ping', 'the', 'connection']);
  });

  it('does not split between letters and digits', () => {
    expect(tokenize('sha256 utf8')).toEqual(['sha256', 'utf8']);
  });

  it('splits at a digit-to-uppercase boundary', () => {
    expect(tokenize('base64Encode')).toEqual(['base64encode', 'base64', 'encode']);
  });

  it('keeps dunder names whole and also emits the bare word', () => {
    expect(tokenize('__init__')).toEqual(['__init__', 'init']);
  });

  it('does not duplicate a plain word', () => {
    expect(tokenize('hello')).toEqual(['hello']);
  });

  it('handles non-English letters', () => {
    expect(tokenize('Über_größe naïve')).toEqual(['über_größe', 'über', 'größe', 'naïve']);
  });

  it('returns nothing for empty, whitespace, punctuation-only or underscore-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!! ... ---')).toEqual([]);
    expect(tokenize('_')).toEqual([]);
    expect(tokenize('___')).toEqual([]);
  });

  it('drops a token one character over the length cap, keeps one exactly at it', () => {
    expect(tokenize('x'.repeat(MAX_TOKEN_LENGTH + 1))).toEqual([]);
    expect(tokenize('a'.repeat(MAX_TOKEN_LENGTH))).toEqual(['a'.repeat(MAX_TOKEN_LENGTH)]);
  });

  it('drops a giant blob (a pasted key or hash) but keeps its neighbours', () => {
    expect(tokenize('key ' + 'A1b2'.repeat(12) + ' end')).toEqual(['key', 'end']);
  });

  it('lowercases a capitalised or all-caps word without splitting it', () => {
    expect(tokenize('The')).toEqual(['the']);
    expect(tokenize('ABC')).toEqual(['abc']);
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('splits only at real case boundaries', () => {
    expect(tokenize('iPhone')).toEqual(['iphone', 'i', 'phone']);
    expect(tokenize('Hello_World')).toEqual(['hello_world', 'hello', 'world']);
    expect(tokenize('x2Y')).toEqual(['x2y', 'x2', 'y']);
    expect(tokenize('ABc')).toEqual(['abc', 'a', 'bc']);
  });

  it('keeps duplicates, because callers count them', () => {
    expect(tokenize('go go go')).toEqual(['go', 'go', 'go']);
  });
});

describe('tokenizeQuery', () => {
  it('returns unique tokens in first-seen order, without stopwords', () => {
    expect(tokenizeQuery('the pool_pre_ping and the pool')).toEqual(['pool_pre_ping', 'pool', 'pre', 'ping']);
  });

  it('drops stopword parts of an identifier but keeps the whole token', () => {
    expect(tokenizeQuery('is_not_none')).toEqual(['is_not_none', 'none']);
  });

  it('returns nothing for an all-stopword or punctuation-only query', () => {
    expect(tokenizeQuery('it is')).toEqual([]);
    expect(tokenizeQuery('!!')).toEqual([]);
    expect(tokenizeQuery('')).toEqual([]);
  });

  it('produces tokens the document side also produces for the same text', () => {
    const text = 'connection_pool';
    const documentTokens = new Set(tokenize(text));
    for (const token of tokenizeQuery(text)) expect(documentTokens.has(token)).toBe(true);
  });
});

describe('QUERY_STOPWORDS', () => {
  it('contains function words', () => {
    for (const word of ['the', 'is', 'not']) expect(QUERY_STOPWORDS.has(word)).toBe(true);
  });

  it('does not contain content words', () => {
    for (const word of ['pool', 'none', 'id']) expect(QUERY_STOPWORDS.has(word)).toBe(false);
  });
});
