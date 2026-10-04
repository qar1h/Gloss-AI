# Highlight Explainer v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v4 — keyword search and fusion. Add a from-scratch BM25 ranking over a conversation's stored chunks, merge it with v3's embedding ranking using reciprocal rank fusion, and expose the three rankings side by side through a debug console command. No token budget, no change to prompt building, no change to the popup — v4 ends at the console, exactly like v3.

**Architecture:** Four new DOM-free, IndexedDB-free modules in `src/rag/` (`tokenize.ts`, `bm25.ts`, `fusion.ts`, `hybrid.ts`), each with real vitest tests, following the `search.ts` / `search.test.ts` pattern from v3: pure functions over already-fetched data, plus one thin async wrapper that reads IndexedDB. BM25 keeps **no persisted state** — term statistics are rebuilt in memory from the chunk list on every search, so they can never be stale. The only existing file touched is `indexer.ts`, which gets one additional debug helper, `window.__glossHybrid()`; `__glossSearch` is left exactly as it is.

**Tech Stack:** Same as v1–v3. **No new dependencies.** (`vitest` is already installed; the benchmark in Task 6 runs through `vitest bench`, which ships with it.)

**Spec:** `CLAUDE.md`, the "v4: Keyword search and fusion" section, plus the decisions agreed in the v4 planning conversation, recorded under "Decisions Locked In Beyond CLAUDE.md" below.

## Global Constraints

- Zero cost, personal use, API key handling, DOM-only reading, no real chat content in the repo: unchanged. BM25 persists nothing, so it adds no new place for chat text to leak. Debug output prints only 80-character previews, as v2/v3 already do.
- **No token budget, no change to prompt building** (`src/context/prompt.ts` untouched), **no change to the popup** (`src/content/ui/popup.ts` untouched). Retrieval is not wired into the explain flow.
- v1's Explain flow, v2's indexing and v3's embedding search must keep working exactly as they do now. In particular: **`store.ts`, `chunker.ts`, `search.ts`, `query.ts`, `embedder.ts` and the IndexedDB schema (`DB_VERSION` stays 2) are not modified.** `indexer.ts` gets additions only (an import and one new debug helper); `__glossSearch` / `dumpSearch` are untouched.
- BM25 is our own implementation (CLAUDE.md: "part of the learning and resume value") — no search library.
- RRF: `score = Σ 1 / (60 + rank)`, 1-based rank, constant 60 (CLAUDE.md, verbatim).
- Do not add an "earlier chunk is better" bonus or any other hand-tuned boost. Whether one helps is a v6 question.
- Testing: vitest for pure logic only. The `__glossHybrid` console command (selection, IndexedDB, offscreen embedder) is verified manually on live claude.ai, as `__glossSearch` was in v3.
- Commits are made when the user asks, not automatically.

## Decisions Locked In Beyond CLAUDE.md

1. **No persisted index; recompute per search.** Chunk text is already in IndexedDB. Tokenising ~3000 chunks is estimated at 100–300 ms (measured in Task 6), scoring is linear in `chunks × query terms`. A persisted index would need updating on every `replaceMessage`, delete and chunker-version bump — the bug class v3 kept hitting (orphaned embeddings, stale caches). If Task 6 shows tokenising dominates, the escape hatch is a `Map<textHash, termCounts>` cache inside `buildBm25Index`'s caller; the content hash is the key, so it needs no invalidation. Not built unless measured to be needed (> ~50 ms on the benchmark).
2. **Scoring:** standard BM25, `k1 = 1.2`, `b = 0.75`, constants exported from `bm25.ts`. IDF is the Lucene form `ln(1 + (N − n + 0.5) / (n + 0.5))` — never negative, unlike the textbook form, which matters in small chats where a term can appear in more than half of all chunks. Document length = number of tokens in the chunk (stopwords included, since documents are not stopword-filtered).
3. **Tokenisation:** lowercase; a "raw token" is a run of `[\p{L}\p{N}_]`. For each one, emit the **whole** lowercased token and its **parts** (split on `_`, then at lower→upper / digit→upper boundaries and at acronym boundaries like `HTTPServer`). The whole token is emitted only if it differs from its single part. Dots, hyphens, colons and all other punctuation are separators. Raw tokens longer than `MAX_TOKEN_LENGTH` (40) are dropped (hashes, base64, pasted keys). No stemming.
   - `pool_pre_ping` → `pool_pre_ping, pool, pre, ping`; `ERR_FAILED` → `err_failed, err, failed`; `getHTTPResponse` → `gethttpresponse, get, http, response`; `os.path.join` → `os, path, join`; `pre-ping` → `pre, ping`; `sha256`, `utf8` stay whole; `__init__` → `__init__, init`.
   - Known losses: `C++`/`C#` → `c`; `$ref`, `@Override`, `--no-cache` lose their symbols; formulas are not handled (v2 never saw one on claude.ai).
4. **Stopwords are removed from the query only.** Documents keep every token, so `not`, `in`, `is` stay findable in code, length normalisation uses real lengths, and IDF already gives common words almost no weight. A query that is nothing but stopwords/punctuation makes BM25 **abstain** (empty list); the embedding list then carries that search alone.
5. **The BM25 query is the highlighted text only** — not the embedding query (highlight + surrounding sentence), and not the typed question (inert in v3 and mostly noise for keyword matching). The embedding already carries the context signal; BM25 contributes the other one — the exact words selected. Known trade-off: a one-word highlight like "it" gives BM25 nothing. If v6 shows this hurts, adding the sentence for short highlights is a one-line change in `__glossHybrid`.
6. **BM25 lists only chunks with score > 0.** Otherwise the list would be thousands of arbitrary ties at zero.
7. **Fusion:** 1-based ranks, `RRF_K = 60`. Each input list is cut to its top `RRF_DEPTH` (default **50**, a named exported constant, also an optional parameter of `reciprocalRankFusion` / `hybridRank` and a third argument of `__glossHybrid`, so it can be changed for testing without a rebuild) before fusing. A chunk absent from a list (or outside its depth) simply gets no term from it.
   - **Which chat sizes the cap affects.** The embedding list contains every chunk that has an embedding, so it is `min(embedded chunks, depth)` long. The BM25 list contains only chunks that match a query term, so it is `min(matching chunks, depth)` long. Rough sizing: an assistant message is ~2–4 chunks, a user message ~1, so ~3–5 chunks per exchange; **50 chunks ≈ 10–17 exchanges** (estimate — `__glossDumpChunks` shows the real count). Below that, the cap does nothing.
   - **What "appears in only one list" means below the cap.** In a chat under `depth` chunks, every embedded chunk is in the embedding list, so a chunk can be "BM25 only" **only if it has no embedding** (not computed yet, or failed). In that regime hybrid is effectively *the embedding order plus a bonus for BM25 matches*: a chunk is "both" if it matched a query term and "emb only" if it didn't. That is correct RRF behaviour, not a bug, and it's what the user's real chats will mostly show. (v5's length switch skips retrieval for short chats anyway.) To see the one-list-only cases on a small chat, pass a small depth: `__glossHybrid(undefined, 5, 3)`.
   - The debug output prints, on every call, the list sizes and whether the cap bound, so this is visible rather than inferred.
8. **Tie-breaking, fully deterministic and independent of input order.** Within a list: score descending, then `Chunk.order` ascending (earlier chunk first), with distinct sequential ranks (no shared ranks). Between fused chunks: fused score descending, then `Chunk.order` ascending (see "Deviations" below: a best-rank step in between was dropped). `Chunk.id` is never used for ordering — it's a string, so `"conv:10:0"` sorts before `"conv:2:0"`, and IndexedDB hands chunks back in id order.
9. **The "own msg" column is kept** (user request). Chunks from the highlight's own message are flagged, not removed, so the self-match effect is visible before v5 decides anything. With a real selection, "own" = chunks whose `messageId` equals the selection's message (via `claudeAdapter.getMessageForNode`). With typed text (`__glossHybrid("text")`), "own" = the messages that contain that text.
10. **`__glossHybrid(text?, k?, depth?)`** is a new console command next to `__glossSearch`, which stays untouched. With no `text`, it uses the current page selection and the *real* surrounding paragraph (the v3 `dumpSearch` passes the highlight as its own paragraph, so its embedding query is slightly different from what a real Explain click would build). The embedding query text is `buildSearchQueryText(highlight, paragraph)`, unchanged from v3. If the embedder fails (model not loaded), the command warns and shows BM25 only — the same degradation a real search would have.
11. **Done-when, weakened as agreed:** for a highlight of an exact technical term, **the chunk where it is defined is in the top-k** — not necessarily rank 1. BM25 finds where a term is densest, not where it first appeared, and v4 deliberately adds no earlier-is-better bonus.

---

## File Structure

```
Gloss/
  package.json                          # + "bench" script only (no dependency change)
  docs/
    benchmarks/
      2026-10-04-bm25-3000-chunks.md    # NEW: numbers + machine, feeds v6
  bench/
    bm25.bench.ts                       # NEW: synthetic 3000-chunk benchmark (vitest bench; not part of `npm test`)
  src/
    rag/
      tokenize.ts                       # NEW: tokenize, tokenizeQuery, QUERY_STOPWORDS, MAX_TOKEN_LENGTH
      tokenize.test.ts                  # NEW
      bm25.ts                           # NEW: BM25_K1, BM25_B, buildBm25Index, scoreBm25, rankByBm25
      bm25.test.ts                      # NEW
      fusion.ts                         # NEW: RRF_K, RRF_DEPTH, reciprocalRankFusion
      fusion.test.ts                    # NEW
      hybrid.ts                         # NEW: hybridRank (pure), buildDebugRows (pure), hybridSearch (IndexedDB wrapper)
      hybrid.test.ts                    # NEW: incl. the done-when scenario
      indexer.ts                        # MODIFY (additions only): dumpHybrid + window.__glossHybrid
```

**Design note:** `tokenize.ts`, `bm25.ts`, `fusion.ts` and the pure half of `hybrid.ts` import only types and each other — no DOM, no IndexedDB, no `browser.*`. Only `hybridSearch` (reads `getAllChunks`/`getAllEmbeddings`) and `indexer.ts`'s `dumpHybrid` touch anything environmental, and both are exercised manually.

## Review Focus

Inputs and conditions the spec implies but doesn't spell out; each has a pinning test in the task that owns the code.

1. **A highlight that is all stopwords/punctuation** ("it is", "!!", a lone `_`) → BM25 abstains, hybrid degrades to embedding-only, nothing throws or divides by zero. (Task 2, Task 4)
2. **Chunks with no embedding yet (fresh chat, model download failed) or no query vector at all** → BM25 still ranks them; the hybrid never needs embeddings to return something. (Task 4)
3. **Empty conversation / zero chunks** → every function returns `[]` with no `NaN` (average length 0). (Task 2, Task 3, Task 4)
4. **A giant token in a chunk (pasted key, base64) or as the highlight** → ignored by the tokenizer, no slowdown, no match on a fragment of it. (Task 1)
5. **Tie storms** (many chunks with identical text/scores, e.g. a repeated boilerplate paragraph) → ordering is deterministic and independent of the order IndexedDB returned them in (string-sorted ids: `"10"` before `"2"`). (Task 2, Task 3)

---

## Task 1: Tokenizer

**Files:**
- Create: `src/rag/tokenize.ts`
- Test: `src/rag/tokenize.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_TOKEN_LENGTH = 40`
  - `export const QUERY_STOPWORDS: ReadonlySet<string>`
  - `export function tokenize(text: string): string[]` — document side: every emitted token, duplicates kept (callers count them), order preserved, no stopword removal.
  - `export function tokenizeQuery(text: string): string[]` — unique tokens of `tokenize(text)` in first-seen order, minus `QUERY_STOPWORDS`.

- [ ] **Step 1: Write the failing tests** (`tokenize.test.ts`), one `it` per row:

| Input | Expected `tokenize(input)` |
|---|---|
| `'pool_pre_ping'` | `['pool_pre_ping', 'pool', 'pre', 'ping']` |
| `'ERR_FAILED'` | `['err_failed', 'err', 'failed']` |
| `'getHTTPResponse'` | `['gethttpresponse', 'get', 'http', 'response']` |
| `'HTTPServer'` | `['httpserver', 'http', 'server']` |
| `'getUserById'` | `['getuserbyid', 'get', 'user', 'by', 'id']` |
| `'os.path.join'` | `['os', 'path', 'join']` |
| `'pre-ping the connection'` | `['pre', 'ping', 'the', 'connection']` |
| `'sha256 utf8'` | `['sha256', 'utf8']` |
| `'base64Encode'` | `['base64encode', 'base64', 'encode']` |
| `'__init__'` | `['__init__', 'init']` |
| `'hello'` | `['hello']` (whole token not duplicated) |
| `'Über_größe naïve'` | `['über_größe', 'über', 'größe', 'naïve']` (Unicode letters) |
| `''`, `'   '`, `'!!! ... ---'`, `'_'`, `'___'` | `[]` |
| `'x'.repeat(41)` and `'a'.repeat(40)` | `[]` and `['a'.repeat(40)]` (cap boundary) |
| `` 'key ' + 'A1b2'.repeat(12) + ' end' `` | `['key', 'end']` (giant blob dropped, neighbours kept) |

Plus:
  - `tokenize('go go go')` → `['go','go','go']` (duplicates kept).
  - `tokenizeQuery('the pool_pre_ping and the pool')` → `['pool_pre_ping', 'pool', 'pre', 'ping']` (unique, stopwords gone, first-seen order).
  - `tokenizeQuery('is_not_none')` → `['is_not_none', 'none']` (stopword *parts* removed, whole token kept).
  - `tokenizeQuery('it is')`, `tokenizeQuery('!!')`, `tokenizeQuery('')` → `[]` (Review Focus 1).
  - Symmetry: for `'connection_pool'`, every token of `tokenizeQuery(s)` appears in `tokenize(s)`.
  - `QUERY_STOPWORDS` contains `'the'`, `'is'`, `'not'` and does not contain `'pool'`, `'none'`, `'id'`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/rag/tokenize.test.ts`
Expected: FAIL — cannot resolve `./tokenize` / functions not defined.

- [ ] **Step 3: Write the minimal implementation**

```ts
// Pure text → tokens, shared by the BM25 index (documents) and the BM25 query. No DOM,
// no IndexedDB. See the v4 plan for the rules and why.

export const MAX_TOKEN_LENGTH = 40;

const RAW_TOKEN = /[\p{L}\p{N}_]+/gu;

export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

function splitParts(raw: string): string[] {
  return raw
    .split(/_+/u)
    .filter((segment) => segment.length > 0)
    .flatMap((segment) =>
      segment
        .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2') // getUser → get User, base64E → base64 E
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2') // HTTPServer → HTTP Server
        .split(' '),
    )
    .map((part) => part.toLowerCase());
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(RAW_TOKEN)) {
    const raw = match[0];
    if (raw.length > MAX_TOKEN_LENGTH) continue;
    const parts = splitParts(raw);
    if (parts.length === 0) continue; // only underscores
    const whole = raw.toLowerCase();
    if (parts.length > 1 || whole !== parts[0]) tokens.push(whole);
    tokens.push(...parts);
  }
  return tokens;
}

export function tokenizeQuery(text: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    if (!QUERY_STOPWORDS.has(token)) seen.add(token);
  }
  return [...seen];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/rag/tokenize.test.ts` — Expected: all PASS. If a camel-case row fails, fix the regexes, not the test.

---

## Task 2: BM25

**Files:**
- Create: `src/rag/bm25.ts`
- Test: `src/rag/bm25.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `tokenizeQuery` (Task 1); `Chunk` from `./types`.
- Produces:
  - `export const BM25_K1 = 1.2`, `export const BM25_B = 0.75`
  - `export interface Bm25Index { docs: Bm25Doc[]; documentFrequency: Map<string, number>; averageLength: number }` where `Bm25Doc = { chunk: Chunk; termCounts: Map<string, number>; length: number }`
  - `export function buildBm25Index(chunks: Chunk[]): Bm25Index`
  - `export interface Bm25Result { chunk: Chunk; score: number; matchedTerms: string[] }`
  - `export function scoreBm25(index: Bm25Index, queryTerms: string[], limit: number): Bm25Result[]` — score > 0 only; sorted score desc then `chunk.order` asc; at most `limit`; `matchedTerms` in query-term order.
  - `export function rankByBm25(chunks: Chunk[], queryText: string, limit: number): Bm25Result[]` — `scoreBm25(buildBm25Index(chunks), tokenizeQuery(queryText), limit)`.

  Build and score are separate on purpose: Task 6 times them separately, and a future `textHash` cache plugs into `buildBm25Index` without touching scoring.

- [ ] **Step 1: Write the failing tests.** A `makeChunk(id, text, order)` helper builds `Chunk`s (same shape as `search.test.ts`'s). Cases:
  - A chunk containing the rare query term outranks one containing only a common term (build 4 chunks; `'pool'` in 1, `'the'`-style filler in all).
  - IDF is never negative: a term present in every chunk still yields a score ≥ 0 and no `NaN`.
  - Length normalisation: two chunks with one occurrence of the term, one 5 words long and one 200 words long → the short one ranks first.
  - Term-frequency saturation: 10 occurrences scores more than 1, but less than 10× as much.
  - Chunks matching no query term are excluded (result length equals the number of matching chunks).
  - `limit` is respected.
  - Empty query, all-stopword query (`'it is'`), punctuation-only query, empty chunk list → `[]` (Review Focus 1, 3). `averageLength` of an empty index is 0 and `scoreBm25` does not divide by it.
  - Exact identifier beats partial: query `'pool_pre_ping'`; chunk A text `'engine = create_engine(url, pool_pre_ping=True)'`, chunk B text `'the connection pool is shared'` → A first, both returned, B's `matchedTerms` is `['pool']`.
  - Identifier finds prose: query `'pool_pre_ping'` also matches a chunk saying `'we pre-ping the connection'` (`matchedTerms` = `['pre', 'ping']`).
  - `matchedTerms` lists only query terms found in that chunk, in query-term order.
  - Ties (Review Focus 5): three chunks with identical text and `order` 30, 10, 20 passed in the order `[30, 10, 20]` → results come back `[10, 20, 30]`. Repeat with ids `'c:10:0'`, `'c:2:0'` and `order` 10000, 2000 → order 2000 first (proves ids aren't used).
  - A giant blob in a chunk doesn't match a query containing a prefix of it (Review Focus 4).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/rag/bm25.test.ts` — Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
import { tokenize, tokenizeQuery } from './tokenize';
import type { Chunk } from './types';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface Bm25Doc { chunk: Chunk; termCounts: Map<string, number>; length: number }
export interface Bm25Index { docs: Bm25Doc[]; documentFrequency: Map<string, number>; averageLength: number }
export interface Bm25Result { chunk: Chunk; score: number; matchedTerms: string[] }

export function buildBm25Index(chunks: Chunk[]): Bm25Index {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  const docs = chunks.map((chunk): Bm25Doc => {
    const tokens = tokenize(chunk.text);
    const termCounts = new Map<string, number>();
    for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    for (const term of termCounts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    totalLength += tokens.length;
    return { chunk, termCounts, length: tokens.length };
  });
  return { docs, documentFrequency, averageLength: docs.length === 0 ? 0 : totalLength / docs.length };
}

export function scoreBm25(index: Bm25Index, queryTerms: string[], limit: number): Bm25Result[] {
  const { docs, documentFrequency, averageLength } = index;
  if (docs.length === 0 || queryTerms.length === 0 || averageLength === 0) return [];

  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const n = documentFrequency.get(term) ?? 0;
    idf.set(term, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
  }

  const results: Bm25Result[] = [];
  for (const doc of docs) {
    let score = 0;
    const matchedTerms: string[] = [];
    const lengthNorm = 1 - BM25_B + BM25_B * (doc.length / averageLength);
    for (const term of queryTerms) {
      const tf = doc.termCounts.get(term);
      if (!tf) continue;
      matchedTerms.push(term);
      score += idf.get(term)! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm));
    }
    if (score > 0) results.push({ chunk: doc.chunk, score, matchedTerms });
  }

  // Chunk.order, never Chunk.id: ids are strings, so "…:10:0" sorts before "…:2:0".
  results.sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order);
  return results.slice(0, limit);
}

export function rankByBm25(chunks: Chunk[], queryText: string, limit: number): Bm25Result[] {
  return scoreBm25(buildBm25Index(chunks), tokenizeQuery(queryText), limit);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/rag/bm25.test.ts` — Expected: all PASS. (If the "10 occurrences < 10×" or length-norm test fails, the formula is wrong — don't loosen the test.)

---

## Task 3: Reciprocal rank fusion

**Files:**
- Create: `src/rag/fusion.ts`
- Test: `src/rag/fusion.test.ts`

**Interfaces:**
- Consumes: `Chunk`.
- Produces:
  - `export const RRF_K = 60`, `export const RRF_DEPTH = 50`
  - `export interface RankedItem { chunk: Chunk; score: number }` (structurally satisfied by v3's `ScoredChunk` and by `Bm25Result`)
  - `export interface FusedChunk { chunk: Chunk; score: number; embeddingRank: number | null; embeddingScore: number | null; bm25Rank: number | null; bm25Score: number | null }`
  - `export function reciprocalRankFusion(embeddingList: RankedItem[], bm25List: RankedItem[], depth = RRF_DEPTH): FusedChunk[]` — inputs must already be sorted best-first (rank = index + 1); each is cut to its first `depth` entries; returns **all** fused chunks, best first (callers slice to `k`); does not mutate its inputs.

- [ ] **Step 1: Write the failing tests.** Cases (use a `makeChunk(id, order)` helper and `item(chunk, score)`):
  - `RRF_K` is 60; a chunk at rank 1 in one list only has `score` exactly `1 / 61`.
  - A chunk at rank 2 in both lists has `score` `2 / 62`, and beats a chunk at rank 1 in a single list (`2/62 > 1/61`).
  - A chunk only in the BM25 list gets `embeddingRank: null` / `embeddingScore: null` and only the BM25 term; vice versa.
  - Ranks and original scores are carried through (`embeddingRank`, `embeddingScore`, `bm25Rank`, `bm25Score`).
  - Depth cap: with `depth = 2`, a chunk at embedding rank 3 is treated as absent from that list (null rank, no term); with the default depth and 60 items, rank 51 is dropped and rank 50 kept. `RRF_DEPTH` is exported and equals 50.
  - Tie 1 — equal fused scores: embedding-only rank 3 chunk with `order` 50 vs BM25-only rank 3 chunk with `order` 10 → the `order` 10 chunk comes first.
  - Tie 2 — equal scores, different best rank: a chunk at ranks (1, 5) vs one at (3, 3) — verify the scores are compared first; where scores are genuinely equal the lower best-rank wins (construct with `1/(60+a)+1/(60+b)` pairs that tie exactly, e.g. identical rank pairs mirrored across lists: (rank 2 emb, rank 4 bm25) vs (rank 4 emb, rank 2 bm25) → equal score and equal best rank → falls through to `order`).
  - Determinism: the same two lists fused after shuffling *which chunk objects are listed first in unrelated positions* is not applicable — instead assert fusing twice gives identical output, and that ids `'c:10:0'`/`'c:2:0'` with orders 10000/2000 in a tie come out order 2000 first.
  - Empty cases: `([], [])` → `[]`; `(emb, [])` returns the embedding order; `([], bm25)` returns the BM25 order (Review Focus 3).
  - Inputs not mutated (compare to a `structuredClone` of the input arrays' order/length after fusing).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/rag/fusion.test.ts` — Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation** (as built, the final sort is `score` desc then `chunk.order` asc only — see "Deviations")

```ts
import type { Chunk } from './types';

export const RRF_K = 60;
/** How many entries of each ranked list take part in fusion. Chats with fewer than this
 * many embedded chunks are unaffected: the cap only bites on longer chats. */
export const RRF_DEPTH = 50;

export interface RankedItem { chunk: Chunk; score: number }
export interface FusedChunk {
  chunk: Chunk;
  score: number;
  embeddingRank: number | null;
  embeddingScore: number | null;
  bm25Rank: number | null;
  bm25Score: number | null;
}

export function reciprocalRankFusion(
  embeddingList: RankedItem[],
  bm25List: RankedItem[],
  depth = RRF_DEPTH,
): FusedChunk[] {
  const byId = new Map<string, FusedChunk>();
  const entry = (chunk: Chunk): FusedChunk => {
    let existing = byId.get(chunk.id);
    if (!existing) {
      existing = { chunk, score: 0, embeddingRank: null, embeddingScore: null, bm25Rank: null, bm25Score: null };
      byId.set(chunk.id, existing);
    }
    return existing;
  };

  embeddingList.slice(0, depth).forEach((item, index) => {
    const fused = entry(item.chunk);
    fused.embeddingRank = index + 1;
    fused.embeddingScore = item.score;
    fused.score += 1 / (RRF_K + index + 1);
  });
  bm25List.slice(0, depth).forEach((item, index) => {
    const fused = entry(item.chunk);
    fused.bm25Rank = index + 1;
    fused.bm25Score = item.score;
    fused.score += 1 / (RRF_K + index + 1);
  });

  const bestRank = (f: FusedChunk) => Math.min(f.embeddingRank ?? Infinity, f.bm25Rank ?? Infinity);
  return [...byId.values()].sort(
    (a, b) => b.score - a.score || bestRank(a) - bestRank(b) || a.chunk.order - b.chunk.order,
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/rag/fusion.test.ts` — Expected: all PASS.

---

## Task 4: Hybrid ranking and debug rows (pure), plus the IndexedDB wrapper

**Files:**
- Create: `src/rag/hybrid.ts`
- Test: `src/rag/hybrid.test.ts`

**Interfaces:**
- Consumes: `rankChunks`, `ScoredChunk` (v3, `./search`); `rankByBm25`, `Bm25Result`, `tokenizeQuery`; `reciprocalRankFusion`, `FusedChunk`, `RRF_DEPTH`; `getAllChunks`, `getAllEmbeddings` (`./store`); `Chunk`, `EmbeddingRecord`.
- Produces:
  - `export interface HybridRanking { queryTerms: string[]; embeddingList: ScoredChunk[]; bm25List: Bm25Result[]; fused: FusedChunk[]; matchedTermsByChunkId: Map<string, string[]>; chunkCount: number; embeddedCount: number }`
  - `export function hybridRank(chunks: Chunk[], embeddings: EmbeddingRecord[], queryVector: number[] | null, bm25QueryText: string, depth?: number): HybridRanking` — `queryVector === null` → empty embedding list (BM25 only). Uses `rankChunks(chunks, embeddings, queryVector, depth)` and `rankByBm25(chunks, bm25QueryText, depth)`.
  - `export interface DebugRow { fusedRank: number; chunk: string; embedding: string; bm25: string; from: 'both' | 'emb only' | 'bm25 only'; ownMsg: 'yes' | ''; matched: string; preview: string }`
  - `export function buildDebugRows(ranking: HybridRanking, k: number, ownMessageIds: ReadonlySet<string>): DebugRow[]` — rows for the union of the top-`k` fused, top-`k` of the embedding list and top-`k` of the BM25 list, ordered by fused rank. Ranks come from the capped full lists (a row may show rank 17). `chunk` is `` `${messageId}:${chunkIndex}` ``; `embedding`/`bm25` are `"3 / 0.610"` / `"1 / 9.80"` or `"–"`; `preview` is the first 80 characters of the chunk text.
  - `export function describeLists(ranking: HybridRanking, depth: number): string` — one line: `chunks: N (E embedded) | lists: embedding X, bm25 Y | depth D — cap not binding` or `— cap binding on: embedding, bm25` (binding = that list's uncapped candidate count exceeds `depth`; computed by `hybridRank` storing `embeddingCandidates`/`bm25Candidates`, see below).
  - `export async function hybridSearch(conversationId: string, queryVector: number[] | null, bm25QueryText: string, depth?: number): Promise<HybridRanking>` — reads chunks + embeddings once, calls `hybridRank`. Exercised manually.

  To report whether the cap binds, `hybridRank` ranks each list with `Infinity`-like headroom: it asks `rankChunks`/`rankByBm25` for `depth + 1` entries, records `embeddingCandidates = list.length > depth`-style booleans as `capBinding: { embedding: boolean; bm25: boolean }` on `HybridRanking`, then passes the lists on (fusion itself cuts to `depth`). Add `capBinding` to the interface above.

- [ ] **Step 1: Write the failing tests.** Build a small hand-made conversation with hand-made 2-D vectors (as `search.test.ts` does). Cases:
  - **Done-when scenario:** 6 chunks; chunk `def` (message 2) is the only one saying `'pool_pre_ping=True makes SQLAlchemy test a connection before using it'`; the other chunks are about unrelated topics; the query vector is nearly orthogonal to `def`'s vector (embedding rank last), but `bm25QueryText = 'pool_pre_ping'`. Assert: `def` is **not** in the embedding top 2, **is** rank 1 in the BM25 list, and **is** in the top 3 of `fused` (top-k, not necessarily rank 1 — Decision 11).
  - Both lists agree → that chunk is first with `embeddingRank = bm25Rank = 1`.
  - `queryVector = null` → `embeddingList` empty, `fused` equals BM25 order, nothing throws (Review Focus 2).
  - Chunks with no embedding (or `status: 'failed'`) but a BM25 match → still in `fused` with `embeddingRank: null` and `from: 'bm25 only'` in the rows.
  - All-stopword highlight (`'it is'`) → `bm25List` empty, `fused` equals the embedding order (Review Focus 1).
  - Zero chunks → everything empty, `chunkCount` 0 (Review Focus 3).
  - `capBinding`: 5 chunks and `depth = 50` → both false; `depth = 3` on the same → embedding true (and bm25 true when ≥ 4 chunks match).
  - Small-chat regime (Decision 7): with every chunk embedded and `depth = 50`, **no** row has `from: 'bm25 only'`; chunks matching the query are `'both'`, the rest `'emb only'`.
  - `buildDebugRows`: includes a chunk that is only in the top-`k` of the BM25 list even if its fused rank is beyond `k`; rows are ordered by fused rank; `ownMsg` is `'yes'` exactly for chunks whose `messageId` is in `ownMessageIds`; `embedding`/`bm25` strings are `'–'` for absent; `preview` is truncated to 80 chars.
  - `describeLists`: contains `cap not binding` / `cap binding on: embedding` appropriately, and the chunk/embedded counts.
  - Determinism with shuffled input order: `hybridRank` given the same chunks in two different input orders (including ids that string-sort differently from `order`) returns identical `fused` id sequences.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/rag/hybrid.test.ts` — Expected: FAIL — module not found.

- [ ] **Step 3: Write the minimal implementation** (`hybrid.ts`) per the interfaces above. `hybridRank` body:

```ts
export function hybridRank(
  chunks: Chunk[],
  embeddings: EmbeddingRecord[],
  queryVector: number[] | null,
  bm25QueryText: string,
  depth = RRF_DEPTH,
): HybridRanking {
  const embeddingProbe = queryVector ? rankChunks(chunks, embeddings, queryVector, depth + 1) : [];
  const bm25Probe = rankByBm25(chunks, bm25QueryText, depth + 1);
  const embeddingList = embeddingProbe.slice(0, depth);
  const bm25List = bm25Probe.slice(0, depth);
  const fused = reciprocalRankFusion(embeddingList, bm25List, depth);
  // …build matchedTermsByChunkId from bm25List, queryTerms = tokenizeQuery(bm25QueryText),
  // capBinding = { embedding: embeddingProbe.length > depth, bm25: bm25Probe.length > depth },
  // chunkCount = chunks.length, embeddedCount = embeddings.filter((e) => e.status === 'done').length
}
```

  Note: `rankChunks` (v3) sorts by cosine only; ties between chunks with identical vectors fall back to input order. That is v3 behaviour and is left alone (Global Constraints); real ties are only duplicate-text chunks.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/rag/hybrid.test.ts` — Expected: all PASS.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm test` then `npm run compile` — Expected: all prior tests (chunker, query, search) still pass, new tests pass, `tsc` clean.

---

## Task 5: `window.__glossHybrid` debug command

**Files:**
- Modify: `src/rag/indexer.ts` (additions only: one import line, one `dumpHybrid` function placed after `dumpSearch`, one `window.__glossHybrid` assignment next to `__glossSearch`)

**Interfaces:**
- Consumes: `hybridSearch`, `buildDebugRows`, `describeLists` (Task 4); `RRF_DEPTH` (Task 3); existing `embedTexts`, `buildSearchQueryText`, `claudeAdapter`, `getSettings`, `getAllChunks`.
- Produces: `window.__glossHybrid(text?: string, k?: number, depth?: number): Promise<void>`.

No unit test: this function only wires the pure, tested pieces to the selection, IndexedDB and the offscreen embedder, exactly like `dumpSearch` in v3. Verified manually in Step 3.

- [ ] **Step 1: Implement `dumpHybrid`**

Behaviour:
1. Resolve highlight, paragraph and own-message ids:
   - `text` given → `highlight = text`, `paragraph = text`, `ownMessageIds` = `messageId` of every stored chunk whose text includes `text` (case-sensitive).
   - No `text` → read `window.getSelection()`. Empty/collapsed → `console.warn` "select some text in a message first (or pass text)" and return. Otherwise `highlight = selection.toString().trim()`, `paragraph = claudeAdapter.getParagraphAround(range)`, `ownMessageIds` = `{ message.id }` from `claudeAdapter.getMessageForNode(range.commonAncestorContainer)` (empty set if null).
2. `queryVector`: `embedTexts([buildSearchQueryText(highlight, paragraph)])`; on failure `console.warn` the message, "showing BM25 only", and use `null`.
3. `ranking = await hybridSearch(conversationId, queryVector, highlight, depth ?? RRF_DEPTH)` — the BM25 query is **the highlight only** (Decision 5).
4. Print: `console.log` the BM25 query terms (`ranking.queryTerms`, or "none — BM25 abstained") and `describeLists(...)`; then `console.table(buildDebugRows(ranking, k ?? settings.retrievalK, ownMessageIds))`.
5. Reuse the coverage line from `dumpSearch` (indexed N of ~M messages) — copy the few lines rather than refactoring `dumpSearch`, which stays untouched.

Register next to the others:

```ts
(window as unknown as { __glossHybrid?: (text?: string, k?: number, depth?: number) => Promise<void> }).__glossHybrid =
  async (text?: string, k?: number, depth?: number) => {
    const id = claudeAdapter.getConversationId();
    if (!id) return;
    await dumpHybrid(id, text, k, depth);
  };
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run compile` then `npm run build` — Expected: both clean; the existing `__glossSearch` / `dumpSearch` lines show no diff in `git diff` apart from the added code.

- [ ] **Step 3: Manual verification on live claude.ai** (the user runs this; see the hand-off for exact steps).

---

## Task 6: Benchmark and note (feeds v6)

**Files:**
- Create: `bench/bm25.bench.ts`
- Modify: `package.json` (add `"bench": "vitest bench --run"` to `scripts` — no dependency change)
- Create: `docs/benchmarks/2026-10-04-bm25-3000-chunks.md`

- [ ] **Step 1: Write the benchmark.** A seeded PRNG (fixed seed, so runs are comparable) generates a **synthetic** conversation — never real chat text — of N `Chunk`s: ~150-word chunks drawn from a Zipf-ish 5000-word vocabulary, ~10% "code" chunks containing `snake_case`, `camelCase` and `UPPER_CASE` identifiers, and a few planted occurrences of `pool_pre_ping`. Cases, each at **N = 300 and N = 3000**:
  - `buildBm25Index` (tokenise + term statistics) alone
  - `scoreBm25` over a prebuilt index with: a 1-identifier query (`pool_pre_ping`), a 3-word query, and a ~200-word paragraph query
  - the full `rankByBm25` (build + score), 1-identifier and 200-word queries
  - `reciprocalRankFusion` of two 50-entry lists (for completeness)

  The file also prints the total characters of text it generated, so the note can say how big "3000 chunks" was.

- [ ] **Step 2: Run it**

Run: `npm run bench` — record mean / p75 / max per case.

- [ ] **Step 3: Write the note** `docs/benchmarks/2026-10-04-bm25-3000-chunks.md`: date, machine (CPU `Intel Core i9-10885H @ 2.40GHz, 8 cores / 16 threads`, `31.7 GB RAM`, Windows 11 Pro, Node `v24.14.1`, vitest `5.0.0`), what the synthetic data is, the results table, how to re-run (`npm run bench`), and honest caveats: Node's V8 rather than Chrome's content script (same engine family, different JIT pressure from a busy page); synthetic text rather than real chats; wall-clock timings from a laptop; IndexedDB read time (`getAllChunks`, `getAllEmbeddings`) is **not** included and is the larger real-world cost. State the conclusion against Decision 1's threshold (> ~50 ms ⇒ add the `textHash` term-count cache) and **act on it** — if the 3000-chunk build step exceeds that, the cache becomes a follow-up task here before hand-off.

- [ ] **Step 4: Confirm `npm test` does not pick the benchmark up** (it is a `.bench.ts` file, outside vitest's default test glob).

---

## Self-Review

- **Spec coverage:** BM25 (Tasks 1–2), RRF with constant 60 and tie/one-list handling (Task 3), BM25 query decision (Decision 5, wired in Task 5), side-by-side debug output with the "own msg" column (Tasks 4–5), unit tests (Tasks 1–4), cost analysis (Task 6 + Decision 1), cap sizing and the `RRF_DEPTH` constant (Decision 7, Task 3), benchmark note in the repo (Task 6), weakened done-when (Decision 11, tested in Task 4).
- **Placeholder scan:** the `hybridRank` body in Task 4 is given as a skeleton with the lines to complete spelled out (matched-terms map, counts) — the implementer fills in those straightforward assignments; every signature is exact.
- **Type consistency:** `RankedItem` (Task 3) is satisfied structurally by `ScoredChunk` (v3) and `Bm25Result` (Task 2); `FusedChunk` fields are the ones `buildDebugRows` (Task 4) reads; `HybridRanking.capBinding` is defined in Task 4 and consumed by `describeLists` in the same task.
- **Not in scope:** wiring retrieval into the prompt, excluding the own message from retrieval, any score boost, stemming, a persisted index, new settings fields (`retrievalK` is reused as `k`).

---

## Deviations from this plan found while implementing

Recorded so the plan matches what was built. None changes a requirement; all were found by the tests or the benchmark.

1. **The best-rank tie-break in fusion was dropped.** The plan sorted fused ties by fused score, then best rank in either list, then `Chunk.order`. Two chunks only tie *exactly* in score when their rank pairs are mirror images (or both single-list rank n), and in every such case their best ranks are equal too, so the middle step could never decide anything. It was dead code, with no test constructible for it. Fusion sorts by score, then `Chunk.order`.
2. **`hybridRank` sorts chunks by `order` before ranking.** v3's `rankChunks` breaks exact cosine ties by *input order*, and IndexedDB returns chunks in string-id order (`"…:10:0"` before `"…:2:0"`). Left alone, three chunks with identical vectors fused into a different order depending on how they arrived, which broke the determinism promised in Decision 8. Sorting first fixes it without touching v3's `rankChunks`. Pinned by a test that shuffles input order. (Mutation-checked: removing the sort makes that test fail.)
3. **The tokenizer got a fast path, and the `textHash` term-count cache was built.** The benchmark (see `docs/benchmarks/2026-10-04-bm25-3000-chunks.md`) contradicted the plan's estimate: a cold 3000-chunk index build took ~580 ms, not 100–300 ms. Decision 1 said to add the cache if the build exceeded ~50 ms, so:
   - `tokenize()` skips the split machinery for tokens with no split point (580 → ~187 ms);
   - `buildBm25Index(chunks, cache?)` takes an optional `Bm25TermCache` (`Map<textHash, { termCounts, length }>`), pruned to the current chunk set on every build so it can't grow without bound or carry one chat into another; `rankByBm25` and `hybridRank` pass it through; `hybridSearch` owns one module-level, in-memory cache. Warm 3000-chunk search is ~32 ms (identifier) to ~49 ms (200-word paragraph).
   - Still no inverted index, and still nothing persisted.
4. **The benchmark does not use `vitest bench`.** vitest 5 no longer exports `bench`, and its internal tinybench dependency would be an unapproved import. `bench/bm25.bench.ts` is a plain `performance.now()` harness (3 warm-up + 20 timed runs) run by its own config (`bench/vitest.config.ts`) via `npm run bench`; `npm test` never picks it up. No dependency was added.
