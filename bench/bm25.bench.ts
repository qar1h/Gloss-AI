// Synthetic BM25 benchmark. Run with `npm run bench` (its own vitest config, bench/vitest.config.ts,
// so `npm test` never picks it up). Plain performance.now() timing: vitest 5 no longer exports
// `bench`, and reaching for its internal tinybench would be an unapproved dependency.
//
// All text here is generated from a seeded random word list — never real chat content —
// so results are comparable run to run and nothing sensitive can end up in the repo.
// It measures the pure ranking code only; IndexedDB read time is NOT included.

import { expect, it } from 'vitest';
import { buildBm25Index, rankByBm25, scoreBm25, type Bm25TermCache } from '../src/rag/bm25';
import { reciprocalRankFusion } from '../src/rag/fusion';
import { tokenizeQuery } from '../src/rag/tokenize';
import type { Chunk } from '../src/rag/types';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ren', 'tu', 'sa', 'vel', 'dor', 'pin', 'qua', 'zel', 'bor', 'nu', 'ex', 'ta'];

function buildVocabulary(random: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const length = 2 + Math.floor(random() * 3);
    let word = '';
    for (let i = 0; i < length; i++) word += SYLLABLES[Math.floor(random() * SYLLABLES.length)];
    words.add(word);
  }
  return [...words];
}

function identifierFor(word: string, random: () => number): string {
  const other = word.slice(0, 2) + 'x';
  switch (Math.floor(random() * 3)) {
    case 0:
      return `${word}_${other}_get`;
    case 1:
      return `${word}${other[0]!.toUpperCase()}${other.slice(1)}Value`;
    default:
      return `${word}_${other}`.toUpperCase();
  }
}

export function makeConversation(chunkCount: number): { chunks: Chunk[]; characters: number } {
  const random = mulberry32(42);
  const vocabulary = buildVocabulary(random, 5000);
  const pick = () => vocabulary[Math.floor(vocabulary.length * random() ** 3)]!; // skewed towards common words

  const chunks: Chunk[] = [];
  let characters = 0;
  for (let i = 0; i < chunkCount; i++) {
    const isCode = random() < 0.1;
    const wordCount = 100 + Math.floor(random() * 80);
    const parts: string[] = [];
    for (let w = 0; w < wordCount; w++) {
      parts.push(isCode && random() < 0.3 ? identifierFor(pick(), random) : pick());
    }
    if (i % Math.max(1, Math.floor(chunkCount / 5)) === 0) parts.splice(10, 0, 'pool_pre_ping=True');
    const text = parts.join(isCode ? '\n' : ' ');
    characters += text.length;
    chunks.push({
      id: `bench:${i}:0`,
      conversationId: 'bench',
      messageId: String(i),
      role: i % 2 === 0 ? 'user' : 'assistant',
      chunkIndex: 0,
      order: i * 1000,
      text,
      textHash: String(i),
      wordCount,
      hasCode: isCode,
      createdAt: 0,
    });
  }
  return { chunks, characters };
}

function makeParagraphQuery(words: number): string {
  const random = mulberry32(7);
  const vocabulary = buildVocabulary(mulberry32(42), 5000);
  return Array.from({ length: words }, () => vocabulary[Math.floor(vocabulary.length * random() ** 3)]!).join(' ');
}

const THREE_WORDS = makeParagraphQuery(3);
const PARAGRAPH = makeParagraphQuery(200);

const WARMUP_RUNS = 3;
const TIMED_RUNS = 20;

interface Timing {
  name: string;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

function measure(name: string, run: () => unknown): Timing {
  for (let i = 0; i < WARMUP_RUNS; i++) run();
  const samples: number[] = [];
  for (let i = 0; i < TIMED_RUNS; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (fraction: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))]!;
  return {
    name,
    meanMs: samples.reduce((sum, x) => sum + x, 0) / samples.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: samples[samples.length - 1]!,
  };
}

function toMarkdown(timings: Timing[]): string {
  const rows = timings.map(
    (t) => `| ${t.name} | ${t.meanMs.toFixed(3)} | ${t.medianMs.toFixed(3)} | ${t.p95Ms.toFixed(3)} | ${t.maxMs.toFixed(3)} |`,
  );
  return ['| case | mean ms | median ms | p95 ms | max ms |', '|---|---:|---:|---:|---:|', ...rows].join('\n');
}

for (const size of [300, 3000]) {
  it(`${size} synthetic chunks`, () => {
    const { chunks, characters } = makeConversation(size);
    const index = buildBm25Index(chunks);
    const identifierTerms = tokenizeQuery('pool_pre_ping');
    const threeWordTerms = tokenizeQuery(THREE_WORDS);
    const paragraphTerms = tokenizeQuery(PARAGRAPH);
    const embeddingList = chunks.slice(0, 50).map((chunk, i) => ({ chunk, score: 1 - i / 100 }));
    const bm25List = chunks.slice(25, 75).map((chunk, i) => ({ chunk, score: 10 - i / 10 }));

    // Sanity: the planted identifier is actually found, so we're timing real work.
    expect(scoreBm25(index, identifierTerms, 50).length).toBeGreaterThan(0);

    // A cache warmed by one earlier search of this same chat: the steady state once the
    // extension has run on the page for a moment.
    const warmCache: Bm25TermCache = new Map();
    buildBm25Index(chunks, warmCache);
    let edits = 0;
    const withOneEditedChunk = () => {
      edits++;
      const edited = chunks.slice();
      edited[0] = { ...chunks[0]!, text: `${chunks[0]!.text} edit${edits}`, textHash: `edit-${edits}` };
      return edited;
    };

    const timings = [
      measure('build index (tokenise + term statistics)', () => buildBm25Index(chunks)),
      measure('score, 1 identifier query (prebuilt index)', () => scoreBm25(index, identifierTerms, 50)),
      measure('score, 3-word query (prebuilt index)', () => scoreBm25(index, threeWordTerms, 50)),
      measure('score, 200-word paragraph query (prebuilt index)', () => scoreBm25(index, paragraphTerms, 50)),
      measure('full search, 1 identifier query (build + score)', () => rankByBm25(chunks, 'pool_pre_ping', 50)),
      measure('full search, 200-word paragraph query (build + score)', () => rankByBm25(chunks, PARAGRAPH, 50)),
      measure('build index, warm cache (nothing changed)', () => buildBm25Index(chunks, warmCache)),
      measure('build index, warm cache, 1 chunk edited', () => buildBm25Index(withOneEditedChunk(), warmCache)),
      measure('full search, 1 identifier query, warm cache', () => rankByBm25(chunks, 'pool_pre_ping', 50, warmCache)),
      measure('full search, 200-word paragraph query, warm cache', () => rankByBm25(chunks, PARAGRAPH, 50, warmCache)),
      measure('fuse two 50-entry lists', () => reciprocalRankFusion(embeddingList, bm25List)),
    ];

    console.log(
      `\n### ${size} chunks (${characters.toLocaleString()} characters; query terms: identifier ${identifierTerms.length}, ` +
        `3-word ${threeWordTerms.length}, 200-word paragraph ${paragraphTerms.length}; ` +
        `${WARMUP_RUNS} warm-up + ${TIMED_RUNS} timed runs)\n\n${toMarkdown(timings)}\n`,
    );
  }, 300_000);
}
