# Highlight Explainer v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v3 — embedding search. Embed every stored chunk locally (transformers.js, in a `chrome.offscreen` document, no network calls), rank chunks by cosine similarity against a highlight-derived query, and expose the results through a debug console command. No BM25, no fusion, no token budget, and no wiring into the actual explain prompt yet — v3 ends at the console.

**Architecture:** All new pure logic (query text construction, cosine similarity, ranking) lives in `src/rag/` as DOM-free functions with real vitest tests, matching the `chunker.ts`/`chunker.test.ts` precedent from v2. The actual model only runs inside a new `chrome.offscreen` document (`src/entrypoints/offscreen/`), because it needs WASM; the content script can't reach it directly, so a small relay lives in `src/background/handleEmbed.ts`. Embedding itself is driven from `src/rag/indexer.ts`'s existing incremental pass — after v2's chunking step, a new step embeds whatever chunks are new, changed, or previously failed, and writes vectors into a new `embeddings` IndexedDB store next to v2's `messages`/`chunks` stores.

**Tech Stack:** Same as v1/v2 (WXT/TS/Manifest V3), plus two new dependencies: `@huggingface/transformers` (already named in CLAUDE.md's tech stack for exactly this version — not a fresh ask) and `@types/chrome` (a types-only devDependency, needed because `chrome.offscreen` and `chrome.runtime.getContexts` are Chrome-only APIs that WXT's cross-browser `browser.*` typings don't cover — also implied by CLAUDE.md already naming `chrome.offscreen` directly in its architecture section).

**Spec:** `CLAUDE.md` (this repo's root), the "v3: Embedding search" section, plus the eleven decisions the user and I locked in during v3 brainstorming (see "Decisions Locked In Beyond CLAUDE.md" below) — including two real v2 bugs found and fixed as part of this plan, and one gap in CLAUDE.md's own v3 wording (the "typed question" term) that this plan documents rather than silently building around.

## Global Constraints

- Zero cost, personal use, API key handling, DOM-only reading: unchanged from v1/v2.
- No BM25, no reciprocal rank fusion, no token budget, no change to how the v1 prompt is built (`src/context/prompt.ts` stays untouched) or to the popup (`src/content/ui/popup.ts` stays untouched). Retrieval results are not wired into the explain flow — v3 ends at the console.
- v1's Explain flow and v2's indexing must keep working exactly as they do now. Every existing file this plan touches gets **additions**, plus the two specific bug fixes named in decisions 4 and 10 below — never unrelated rewrites.
- `@huggingface/transformers` is pre-approved by CLAUDE.md's tech stack section (named for "from v3"). `@types/chrome` is a types-only addition with zero runtime/bundle impact, needed for the Chrome-only APIs CLAUDE.md's own architecture section already names (`chrome.offscreen`). Both are called out by name here rather than added silently.
- Testing: vitest only for pure, DOM-free logic (matches `chunker.test.ts`). Everything DOM/browser/extension-API dependent (the offscreen document, the IndexedDB migration, real model download/inference, the `__glossSearch` console output) is verified manually on live claude.ai — no headless test harness for `chrome.offscreen` or IndexedDB is being built.
- CLAUDE.md now has a hard constraint (added this session): chunk dumps and IndexedDB exports contain real chat content, possibly secrets, and must never be committed. None of this plan's manual-test steps write real console output into a file that gets committed.
- Each task below is ordered so it typechecks and (where it has tests) passes entirely on its own — no task depends on a later task's code to compile. Where a task's *runtime* behavior only becomes fully exercisable once a later task exists (e.g. the indexer's embedding step needs the offscreen relay from an earlier task, which this plan already orders correctly), that is a manual-test note, never a compile-time gap.

## Decisions Locked In Beyond CLAUDE.md

These were resolved during v3 brainstorming, with reasoning, so later readers don't have to re-derive them:

1. **Model: `all-MiniLM-L6-v2`, not `bge-small-en-v1.5`.** MiniLM has roughly half the transformer layers, so it's meaningfully faster on CPU-in-a-browser (no GPU), and its quantized download is smaller (roughly 20-25MB vs. bge-small's roughly 35-45MB — exact numbers drift, verify against the actual Hugging Face repo in Task 4). bge-small edges out MiniLM by a few points on retrieval benchmarks, but that's optimizing a metric this project doesn't measure until v6, at the cost of a slower, heavier model for a tool meant to feel instant. Both output 384-dimension vectors, so storage/math is identical either way. The 180-word chunk ceiling from v2 is unchanged — it was already sized to be safe under either model.
2. **Runs inside a `chrome.offscreen` document, relayed through the background worker — never talked to directly by the content script.** `chrome.offscreen` requires the `"offscreen"` manifest permission and a CSP with `'wasm-unsafe-eval'` in `script-src`. transformers.js caches its own downloaded model files via the browser's Cache Storage API, scoped to the extension's own origin — that happens automatically and survives the offscreen document being closed and recreated, so "downloads once" needs no custom code. **Important architectural detail:** `store.ts`'s IndexedDB lives in the *content script's page origin* (claude.ai), not the extension's origin — the offscreen document is a separate origin (`chrome-extension://<id>`) and cannot see that database at all. So the orchestration loop (deciding what needs embedding, reading/writing the `embeddings` store) stays content-script-side, in `indexer.ts`; only a plain `texts: string[] -> vectors: number[][]` call is relayed out to the offscreen document and back.
3. **Incremental embedding piggybacks on `indexer.ts`'s existing pass.** After a message's chunks are written (`replaceMessage`), a new step embeds any chunk with no embedding record, a stale `chunkTextHash`, a stale `embeddingVersion`, or a `'failed'` status — batched, not one chunk per round trip. A failed batch writes `status: 'failed'` with no vector, so it's retried next pass; never marked `'done'` unless a real vector came back. No exponential backoff — that's for Gemini's HTTP 429s specifically, not free local compute.
4. **New `embeddings` IndexedDB store, `embeddingVersion` like `chunkerVersion`.** Bumping `store.ts`'s `DB_VERSION` from 1 to 2 surfaced a real gap: the existing `onupgradeneeded` unconditionally creates `messages`+`chunks` with no `oldVersion` branching, because it only ever ran once, from version 0. Left as-is, bumping the version again would either skip creating `embeddings` or attempt to recreate stores that already exist. **This is fixed as part of this plan** — `onupgradeneeded` now branches on `event.oldVersion`. Two more related fixes: `deleteMessage` (v2's stale-tail cleanup) never deleted a message's embedding rows, and neither did `replaceMessage`'s cleanup of a shrunk message's *removed* chunk ids — both now also delete the corresponding `embeddings` rows, or vectors for chunks that no longer exist would silently accumulate forever.
   - **Refinement since the design chat:** `EmbeddingRecord.status` is `'done' | 'failed'` only, not a three-state `'pending'|'done'|'failed'`. A `'pending'` value was never going to be written anywhere — the absence of a record already means "needs embedding," so persisting an explicit pending row would be a write with no purpose. This still satisfies the original requirement (a failed embed is never mistaken for a done one) with one less state to keep consistent.
5. **Search query = highlight + the sentence around it**, via a new pure string helper (not adapter code — it's plain sentence splitting over text the adapter already returns). **A real gap in CLAUDE.md's own wording, documented rather than papered over:** the spec also says "plus the user's typed question if there is one," but no such input exists anywhere in the current popup or content script — `content/index.ts`'s existing `userQuestion` field is the *original chat message* that produced the answer, not a new per-highlight question, and v3 is not touching the popup. The query builder takes an optional `typedQuestion` parameter that every v3 caller passes as empty, so a future popup input plugs in later without touching search code again — but it is inert in v3, and this plan says so plainly instead of pretending the feature exists.
6. **Cosine similarity, configurable `k` (default 5).** `k` is a new field on the existing `Settings`/options page (`src/options/storage.ts`) — not new UI surface, just a new field where API key/model id/debug toggle already live.
7. **Inspection via a `__glossSearch(text)` console command**, gated by the existing debug toggle, matching `__glossDumpChunks` exactly — a `console.table` of the top-k chunks with their score. No popup or other UI changes.
8. **Virtualization coverage gap: accepted, not auto-scrolled.** Auto-scrolling the real claude.ai page to force more of the chat to mount was considered and rejected — it would move the user's actual reading position and risks fighting the site's own lazy-loading in ways that could interact badly with the debounced `MutationObserver`. Instead, `__glossSearch`'s output includes a coverage line ("indexed N of ~M messages — scroll through more of it to include it in search"), computed from `getLastMessagePosition()` vs. the number of distinct indexed positions, so the limitation is visible rather than silent.
9. **Tiny chunks are embedded with neighbor context, never excluded, and never mutated in storage.** A chunk under ~12 words (a bare code line, a short fragment) would otherwise produce a vector with almost no semantic content — excluding it instead would make the exact thing someone highlights unsearchable. So the text sent to the embedder (never the stored `Chunk.text`) is that chunk's own text plus trimmed text from its same-message neighbors (by `chunkIndex`), capped at 180 words total, with the chunk's own words never trimmed. Known edge case, accepted: if only a neighbor changes (not the chunk itself), the merged embedding won't auto-refresh — in practice this rarely bites, because editing a message re-chunks and re-hashes the whole message at once, so neighboring chunk ids usually change too.
10. **The position-256 gap gets two debug logs and a real bug fix, not a guess.** The user's longest chat indexed 27 messages across two islands (243-255,257 and 391-403 of ~403), with position 256 specifically missing despite 255 and 257 on either side of it being indexed — which rules out a plain "wasn't mounted" explanation for that one row, since its immediate neighbors prove that DOM region *was* mounted. Two things can cause this, and this plan can't tell which without live data, so it instruments both: (a) `getAllMessages()` silently drops any row with an unrecognized role or missing id before the indexing loop ever sees it — not a bug, just an adapter gap, now logged; (b) the existing `if (claudeAdapter.isStreaming(...)) continue;` line skips a row forever if its `data-perf-row-streaming` flag gets stuck at `"true"` (e.g. an errored generation) — genuinely a v2 bug, since real streaming finishes in seconds. **Fixed as part of this plan:** a message that's still reporting "streaming" after 60 seconds of wall-clock time is indexed anyway instead of skipped forever.
11. **`chrome.*` vs `browser.*` split.** `chrome.offscreen.createDocument` and `chrome.runtime.getContexts` (used to check whether the offscreen document already exists) are Chrome-only, non-standardized APIs — WXT's cross-browser `browser.*` object doesn't wrap them. This plan calls them via the raw global `chrome.*` (typed by the new `@types/chrome` devDependency), while the actual message-passing between content script, background, and the offscreen document keeps using `browser.runtime.sendMessage`/`onMessage`, matching the standard messaging style already used elsewhere in this codebase (e.g. `handleExplain.ts`).

---

## File Structure

```
Gloss/
  package.json                          # + @huggingface/transformers, + @types/chrome
  wxt.config.ts                         # + "offscreen" permission, + CSP for wasm-unsafe-eval
  src/
    rag/
      types.ts                          # + EmbeddingRecord
      embedder.ts                       # NEW: EMBEDDING_MODEL_ID, EMBEDDING_VERSION, embedTexts()
      query.ts                          # NEW: extractSurroundingSentence, buildSearchQueryText, buildEmbedInputForChunk
      query.test.ts                     # NEW: vitest unit tests
      search.ts                         # NEW: cosineSimilarity, rankChunks, searchChunks
      search.test.ts                    # NEW: vitest unit tests
      store.ts                          # MODIFY: DB_VERSION 1->2 with oldVersion branching, embeddings store + CRUD, replaceMessage/deleteMessage also clean up embeddings
      indexer.ts                        # MODIFY: embedPendingChunks step, streaming-stuck timeout valve, unrecognized-row debug log, __glossSearch console command + coverage line
    sites/
      types.ts                          # + getUnrecognizedRowIds() on SiteAdapter
      claude.ts                         # + implementation of getUnrecognizedRowIds()
    messaging/
      types.ts                          # + EmbedRequest, EmbedResult, OffscreenEmbedRequest
    background/
      handleEmbed.ts                    # NEW: ensureOffscreenDocument, relay to/from the offscreen document
    entrypoints/
      background.ts                     # + registerEmbedListener()
      offscreen/
        index.html                      # NEW: unlisted extension page, builds to /offscreen.html
        main.ts                         # NEW: loads the transformers.js pipeline once, answers embed requests
      options/
        index.html                      # + retrieval-k number field
        main.ts                         # + read/write retrievalK
    options/
      storage.ts                        # + retrievalK setting (default 5)
```

**Design note:** `query.ts` and the pure half of `search.ts` (`cosineSimilarity`, `rankChunks`) never touch the DOM, IndexedDB, or `browser.*` — they're plain functions over arrays and strings, so they get real vitest tests, same boundary discipline as `chunker.ts`. `embedder.ts`'s `embedTexts` and `search.ts`'s `searchChunks` do touch `browser.*`/IndexedDB and are exercised manually. `offscreen/main.ts` is the only file that imports `@huggingface/transformers` — it never touches IndexedDB, since it can't see the content script's origin at all.

**Task ordering note:** tasks are ordered bottom-up by real dependency (types → messaging contract → embedder config+settings, then storage, then pure logic, then the offscreen relay, then wiring it all into the indexer, then the options UI + end-to-end check) specifically so each task's own typecheck (and tests, where present) pass standalone — no task asks you to write code that references something a later task hasn't created yet.

---

## Task 1: Types, messaging contract, and embedding/retrieval config

**Files:**
- Modify: `src/rag/types.ts`
- Modify: `src/messaging/types.ts`
- Create: `src/rag/embedder.ts`
- Modify: `src/options/storage.ts`

**Interfaces:**
- Produces: `EmbeddingRecord`, `EmbedRequest`, `EmbedResult`, `OffscreenEmbedRequest`, `EMBEDDING_MODEL_ID: string`, `EMBEDDING_VERSION: number`, `embedTexts(texts: string[]): Promise<number[][]>`, `Settings.retrievalK: number` — consumed by every later task in this plan.

- [ ] **Step 1: Add `EmbeddingRecord` to `src/rag/types.ts`**

Add at the end of the file:

```ts
export interface EmbeddingRecord {
  chunkId: string; // matches Chunk.id
  conversationId: string;
  vector: number[];
  embeddingVersion: number;
  chunkTextHash: string; // the chunk's own textHash at the time this vector was computed
  status: 'done' | 'failed';
  embeddedAt: number;
}
```

- [ ] **Step 2: Add the embed messaging contract to `src/messaging/types.ts`**

Add at the end of the file:

```ts
// The relay contract for local embedding: content script -> background (ensures the
// offscreen document exists, relays) -> offscreen document (runs the model) -> back.
// `OffscreenEmbedRequest` carries a `target` field so the offscreen document's listener
// can tell its own relayed requests apart from the content-script-facing EmbedRequest
// the background worker listens for.

export interface EmbedRequest {
  type: 'gloss-embed-request';
  texts: string[];
}

export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; error: string };

export interface OffscreenEmbedRequest {
  target: 'gloss-offscreen';
  type: 'gloss-embed-request';
  texts: string[];
}
```

- [ ] **Step 3: Write `src/rag/embedder.ts`**

```ts
// Local embedding pipeline config. One constant for the model id, exactly so swapping
// models later (or a Hugging Face repo move) is a one-line change — same pattern as
// DEFAULT_MODEL_ID in src/llm/gemini.ts.
//
// Verified against the installed @huggingface/transformers@4.2.0's own type
// definitions and JSDoc examples (types/pipelines/feature-extraction.d.ts) before this
// plan was executed: that version's own official feature-extraction example uses
// `onnx-community/all-MiniLM-L6-v2-ONNX`, not the `Xenova/` namespace this plan
// originally guessed. `Xenova/all-MiniLM-L6-v2` still exists on the Hugging Face Hub and
// isn't deprecated, but `onnx-community/...` is what the currently-installed library's
// own docs demonstrate, so that's what's used here.
export const EMBEDDING_MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';

// Bump this whenever the model or how it's called changes, so the indexer force-re-embeds
// every chunk even when its content hasn't changed — same pattern as CHUNKER_VERSION.
export const EMBEDDING_VERSION = 1;

import type { EmbedRequest, EmbedResult } from '@/messaging/types';

/** Runs in the content script: asks the background worker (which relays to the offscreen
 * document, wired up in Task 4) to embed a batch of texts. Never called with an empty array. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const request: EmbedRequest = { type: 'gloss-embed-request', texts };
  const result = (await browser.runtime.sendMessage(request)) as EmbedResult;
  if (!result.ok) throw new Error(result.error);
  return result.vectors;
}
```

- [ ] **Step 4: Add `retrievalK` to `src/options/storage.ts`**

Replace the whole file:

```ts
// Typed get/set for the API key, model id, debug toggle, and retrieval k in
// chrome.storage.local (via WXT's storage helper, which is auto-imported project-wide).

import { DEFAULT_MODEL_ID } from '@/llm/gemini';

export interface Settings {
  apiKey: string;
  modelId: string;
  debugEnabled: boolean;
  retrievalK: number;
}

const apiKeyItem = storage.defineItem<string>('local:apiKey', { fallback: '' });
const modelIdItem = storage.defineItem<string>('local:modelId', { fallback: DEFAULT_MODEL_ID });
const debugEnabledItem = storage.defineItem<boolean>('local:debugEnabled', { fallback: false });
const retrievalKItem = storage.defineItem<number>('local:retrievalK', { fallback: 5 });

export async function getSettings(): Promise<Settings> {
  const [apiKey, modelId, debugEnabled, retrievalK] = await Promise.all([
    apiKeyItem.getValue(),
    modelIdItem.getValue(),
    debugEnabledItem.getValue(),
    retrievalKItem.getValue(),
  ]);
  return { apiKey, modelId, debugEnabled, retrievalK };
}

export async function setSettings(settings: Settings): Promise<void> {
  await Promise.all([
    apiKeyItem.setValue(settings.apiKey),
    modelIdItem.setValue(settings.modelId),
    debugEnabledItem.setValue(settings.debugEnabled),
    retrievalKItem.setValue(settings.retrievalK),
  ]);
}
```

This doesn't add the options-page UI field yet (that's Task 6, alongside end-to-end verification) — `getSettings()` already falls back to `5` for anyone who hasn't set it, so nothing here depends on the UI existing.

- [ ] **Step 5: Typecheck**

Run: `npm run compile`
Expected: no errors. (The existing options page in `src/entrypoints/options/main.ts` doesn't read or write `retrievalK` yet, which is fine — it only reads/writes the three fields it already knows about, and `setSettings` still requires all four fields on any *new* call site, but this file makes no new call to `setSettings`.)

- [ ] **Step 6: Commit**

```bash
git add src/rag/types.ts src/messaging/types.ts src/rag/embedder.ts src/options/storage.ts
git commit -m "feat(rag): add embedding types, the embed messaging contract, and a configurable retrieval k"
```

---

## Task 2: Extend the IndexedDB store with an `embeddings` object store

**Files:**
- Modify: `src/rag/store.ts`

**Interfaces:**
- Consumes: `EmbeddingRecord` from `src/rag/types.ts` (Task 1).
- Produces: `getEmbeddingRecord(chunkId): Promise<EmbeddingRecord | undefined>`, `getAllEmbeddings(conversationId): Promise<EmbeddingRecord[]>`, `putEmbedding(record): Promise<void>` — consumed by `search.ts` (Task 3) and `indexer.ts` (Task 5).

- [ ] **Step 1: Bump `DB_VERSION` and fix `onupgradeneeded` to branch on `oldVersion`**

Replace the top of `src/rag/store.ts` (through the end of `openDb`):

```ts
import type { Chunk, EmbeddingRecord, MessageRecord } from './types';

const DB_NAME = 'highlight-explainer';
const DB_VERSION = 2;
const MESSAGES_STORE = 'messages';
const CHUNKS_STORE = 'chunks';
const EMBEDDINGS_STORE = 'embeddings';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion;

        if (oldVersion < 1) {
          db.createObjectStore(MESSAGES_STORE, { keyPath: 'key' }).createIndex(
            'by_conversation',
            'conversationId',
          );
          db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' }).createIndex(
            'by_conversation',
            'conversationId',
          );
        }

        if (oldVersion < 2) {
          db.createObjectStore(EMBEDDINGS_STORE, { keyPath: 'chunkId' }).createIndex(
            'by_conversation',
            'conversationId',
          );
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}
```

This is the fix for decision 4: without the `oldVersion` branching, a second version bump on top of the original unconditional `onupgradeneeded` would either skip creating `embeddings` for new installs or attempt to recreate the already-existing `messages`/`chunks` stores for upgrades — this way, a fresh install (`oldVersion` 0) creates all three stores in one pass, and an existing v2 install (`oldVersion` 1) only creates the new one.

- [ ] **Step 2: Add embedding read/write functions**

Add after `getAllChunks` (leave `promisifyRequest`/`promisifyTx` where they are):

```ts
export async function getEmbeddingRecord(chunkId: string): Promise<EmbeddingRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readonly');
  return promisifyRequest(tx.objectStore(EMBEDDINGS_STORE).get(chunkId));
}

export async function getAllEmbeddings(conversationId: string): Promise<EmbeddingRecord[]> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readonly');
  return promisifyRequest(
    tx.objectStore(EMBEDDINGS_STORE).index('by_conversation').getAll(conversationId),
  );
}

export async function putEmbedding(record: EmbeddingRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readwrite');
  tx.objectStore(EMBEDDINGS_STORE).put(record);
  await promisifyTx(tx);
}
```

- [ ] **Step 3: Clean up embeddings in `replaceMessage` and `deleteMessage`**

Replace both functions:

```ts
/**
 * Replace everything derived from one message: delete its previous chunks (if any),
 * write the new ones, and write its bookkeeping row — all in one readwrite transaction
 * spanning all three stores, so a mid-write failure can't leave chunks, embeddings, and
 * bookkeeping out of sync. Any previous chunk id that isn't in the new chunk set (the
 * message got shorter, or its blocks were regrouped differently) also has its embedding
 * row deleted, so vectors for chunks that no longer exist don't silently pile up.
 */
export async function replaceMessage(
  record: MessageRecord,
  chunks: Chunk[],
  previousChunkIds: string[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE, EMBEDDINGS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  const embeddingStore = tx.objectStore(EMBEDDINGS_STORE);
  const newChunkIds = new Set(chunks.map((c) => c.id));

  for (const id of previousChunkIds) {
    chunkStore.delete(id);
    if (!newChunkIds.has(id)) embeddingStore.delete(id);
  }
  for (const chunk of chunks) chunkStore.put(chunk);
  tx.objectStore(MESSAGES_STORE).put(record);
  await promisifyTx(tx);
}

/** Delete a message's bookkeeping row and all of its chunks and their embeddings (used for stale-tail cleanup). */
export async function deleteMessage(record: MessageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE, EMBEDDINGS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  const embeddingStore = tx.objectStore(EMBEDDINGS_STORE);
  for (const id of record.chunkIds) {
    chunkStore.delete(id);
    embeddingStore.delete(id);
  }
  tx.objectStore(MESSAGES_STORE).delete(record.key);
  await promisifyTx(tx);
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 5: Manual smoke check**

Same reasoning as v2's store.ts task: this file needs a real IndexedDB, which vitest's default environment doesn't provide, and adding `fake-indexeddb` wasn't asked for. Smoke-tested manually once Task 5 wires it in (Task 6's end-to-end verification).

- [ ] **Step 6: Commit**

```bash
git add src/rag/store.ts
git commit -m "fix(rag): branch IndexedDB upgrades on oldVersion, add an embeddings store, and clean up orphaned embeddings on message replace/delete"
```

---

## Task 3: Pure query and ranking logic, with tests

**Files:**
- Create: `src/rag/query.ts`
- Create: `src/rag/query.test.ts`
- Create: `src/rag/search.ts`
- Create: `src/rag/search.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `EmbeddingRecord` from `src/rag/types.ts` (Task 1); `getAllChunks`, `getAllEmbeddings` from `src/rag/store.ts` (Task 2).
- Produces: `extractSurroundingSentence(paragraph, highlight): string`, `buildSearchQueryText(highlight, paragraph, typedQuestion?): string`, `buildEmbedInputForChunk(chunkText, previousChunkText, nextChunkText): string`, `cosineSimilarity(a, b): number`, `ScoredChunk { chunk: Chunk; score: number }`, `rankChunks(chunks, embeddings, queryVector, k): ScoredChunk[]`, `searchChunks(conversationId, queryVector, k): Promise<ScoredChunk[]>` — consumed by `indexer.ts` (Task 5).

- [ ] **Step 1: Write the failing tests — `src/rag/query.test.ts`**

```ts
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run query.test.ts`
Expected: FAIL — `./query` does not exist yet.

- [ ] **Step 3: Write `src/rag/query.ts`**

```ts
// Pure string logic for search-query construction and small-chunk embedding input. No
// DOM access — callers already have the paragraph/highlight text from the site adapter.

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
const MIN_EMBED_WORDS = 12;
const MAX_EMBED_WORDS = 180; // matches the chunker's own ceiling (src/rag/chunker.ts)

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter((w) => w.length > 0);
}

/** The sentence(s) in `paragraph` that overlap `highlight`, or the whole paragraph if none match. */
export function extractSurroundingSentence(paragraph: string, highlight: string): string {
  const trimmedHighlight = highlight.trim();
  if (!trimmedHighlight || !paragraph.includes(trimmedHighlight)) return paragraph;

  const sentences = paragraph.split(SENTENCE_SPLIT).filter((s) => s.trim().length > 0);
  const matching = sentences.filter((s) => s.includes(trimmedHighlight) || trimmedHighlight.includes(s));
  return matching.length > 0 ? matching.join(' ') : paragraph;
}

/**
 * The text embedded at search time. `typedQuestion` is a plug-in point for a future
 * per-highlight question input in the popup — v3 has no such input, so every v3 caller
 * passes it as empty and this term is inert today.
 */
export function buildSearchQueryText(highlight: string, paragraph: string, typedQuestion = ''): string {
  const sentence = extractSurroundingSentence(paragraph, highlight);
  const parts = [highlight];
  if (sentence && sentence.trim() !== highlight.trim()) parts.push(sentence);
  if (typedQuestion.trim()) parts.push(typedQuestion.trim());
  return parts.join('\n');
}

/**
 * The text actually sent to the embedder for one chunk. Chunks at or above
 * MIN_EMBED_WORDS embed as themselves. Smaller chunks (a bare code line, a short
 * fragment) embed as themselves plus trimmed neighbor text, so the vector isn't built
 * from a string with no semantic content on its own. The stored Chunk.text is never
 * touched by this — it only affects what gets embedded.
 */
export function buildEmbedInputForChunk(
  chunkText: string,
  previousChunkText: string | null,
  nextChunkText: string | null,
): string {
  if (wordCount(chunkText) >= MIN_EMBED_WORDS) return chunkText;

  let budget = MAX_EMBED_WORDS - wordCount(chunkText);
  const parts: string[] = [];

  if (previousChunkText && budget > 0) {
    const previousWords = words(previousChunkText);
    const take = Math.min(Math.ceil(budget / 2), previousWords.length);
    parts.push(previousWords.slice(previousWords.length - take).join(' '));
    budget -= take;
  }

  parts.push(chunkText);

  if (nextChunkText && budget > 0) {
    const nextWords = words(nextChunkText);
    const take = Math.min(budget, nextWords.length);
    parts.push(nextWords.slice(0, take).join(' '));
  }

  return parts.join('\n');
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run query.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Write the failing tests — `src/rag/search.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankChunks } from './search';
import type { Chunk, EmbeddingRecord } from './types';

function makeChunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    conversationId: 'conv-1',
    messageId: '0',
    role: 'assistant',
    chunkIndex: 0,
    order: 0,
    text: 'chunk text',
    textHash: 'hash-a',
    wordCount: 2,
    hasCode: false,
    createdAt: 0,
    ...overrides,
  };
}

function makeEmbedding(chunkId: string, vector: number[], overrides: Partial<EmbeddingRecord> = {}): EmbeddingRecord {
  return {
    chunkId,
    conversationId: 'conv-1',
    vector,
    embeddingVersion: 1,
    chunkTextHash: 'hash-a',
    status: 'done',
    embeddedAt: 0,
    ...overrides,
  };
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 instead of NaN for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('rankChunks', () => {
  it('ranks chunks by similarity to the query vector, highest first', () => {
    const chunks = [makeChunk('a'), makeChunk('b'), makeChunk('c')];
    const embeddings = [
      makeEmbedding('a', [1, 0]),
      makeEmbedding('b', [0, 1]),
      makeEmbedding('c', [0.9, 0.1]),
    ];
    const results = rankChunks(chunks, embeddings, [1, 0], 2);
    expect(results.map((r) => r.chunk.id)).toEqual(['a', 'c']);
  });

  it('skips chunks with a failed or missing embedding', () => {
    const chunks = [makeChunk('a'), makeChunk('b')];
    const embeddings = [makeEmbedding('a', [1, 0], { status: 'failed' })];
    const results = rankChunks(chunks, embeddings, [1, 0], 5);
    expect(results).toHaveLength(0);
  });

  it('respects k', () => {
    const chunks = [makeChunk('a'), makeChunk('b'), makeChunk('c')];
    const embeddings = [makeEmbedding('a', [1, 0]), makeEmbedding('b', [1, 0]), makeEmbedding('c', [1, 0])];
    expect(rankChunks(chunks, embeddings, [1, 0], 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run the tests to confirm they fail**

Run: `npx vitest run search.test.ts`
Expected: FAIL — `./search` does not exist yet.

- [ ] **Step 7: Write `src/rag/search.ts`**

```ts
import { getAllChunks, getAllEmbeddings } from './store';
import type { Chunk, EmbeddingRecord } from './types';

/** Both vectors are assumed to be the same length (they always come from the same
 * embedding model). Indexing with `!` is safe here because the loop never exceeds a.length. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/** Pure ranking over already-fetched data — no IndexedDB here, so this is unit-testable. */
export function rankChunks(
  chunks: Chunk[],
  embeddings: EmbeddingRecord[],
  queryVector: number[],
  k: number,
): ScoredChunk[] {
  const vectorByChunkId = new Map(
    embeddings.filter((e) => e.status === 'done').map((e) => [e.chunkId, e.vector] as const),
  );

  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const vector = vectorByChunkId.get(chunk.id);
    if (!vector) continue;
    scored.push({ chunk, score: cosineSimilarity(queryVector, vector) });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Reads a conversation's chunks + embeddings from IndexedDB and ranks them. */
export async function searchChunks(conversationId: string, queryVector: number[], k: number): Promise<ScoredChunk[]> {
  const [chunks, embeddings] = await Promise.all([getAllChunks(conversationId), getAllEmbeddings(conversationId)]);
  return rankChunks(chunks, embeddings, queryVector, k);
}
```

- [ ] **Step 8: Run the tests to confirm they pass**

Run: `npx vitest run query.test.ts search.test.ts`
Expected: PASS, all 14 tests (7 from `query.test.ts`, 7 from `search.test.ts`).

- [ ] **Step 9: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/rag/query.ts src/rag/query.test.ts src/rag/search.ts src/rag/search.test.ts
git commit -m "feat(rag): add pure query-construction and cosine-ranking logic, with unit tests"
```

---

## Task 4: Messaging relay and the offscreen document

**Files:**
- Create: `src/background/handleEmbed.ts`
- Modify: `src/entrypoints/background.ts`
- Create: `src/entrypoints/offscreen/index.html`
- Create: `src/entrypoints/offscreen/main.ts`
- Modify: `wxt.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `EmbedRequest`, `EmbedResult`, `OffscreenEmbedRequest` from `src/messaging/types.ts` (Task 1); `EMBEDDING_MODEL_ID` from `src/rag/embedder.ts` (Task 1).
- Produces: `registerEmbedListener(): void` — consumed by `entrypoints/background.ts` (this task, wired immediately).

- [ ] **Step 1: Install the two new dependencies**

```bash
npm install @huggingface/transformers
npm install -D @types/chrome
```

`@huggingface/transformers` is pre-approved by CLAUDE.md's tech stack (named for v3). `@types/chrome` adds no runtime code — it's typings only, needed because `chrome.offscreen.createDocument` and `chrome.runtime.getContexts` (both used below) are Chrome-only APIs that WXT's cross-browser `browser.*` typings don't cover.

- [ ] **Step 2: Add manifest permission and CSP in `wxt.config.ts`**

```ts
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Highlight Explainer',
    description:
      'Highlight text in an AI chat answer and get a streamed plain-language explanation, right on the page.',
    permissions: ['storage', 'offscreen'],
    host_permissions: ['https://claude.ai/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
```

- [ ] **Step 3: Write `src/background/handleEmbed.ts`**

```ts
// Relays embed requests from the content script to the offscreen document, creating that
// document lazily on first use and leaving it open afterward (reloading the model on every
// batch would be far slower than just keeping the document alive).

import type { EmbedRequest, EmbedResult, OffscreenEmbedRequest } from '@/messaging/types';

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';

let creatingOffscreenDocument: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS], // verify against current Chrome docs — see note below
      justification: 'Runs a local ONNX embedding model (transformers.js) to compute chunk vectors.',
    });
  }
  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

function isContentEmbedRequest(message: unknown): message is EmbedRequest {
  const m = message as Partial<EmbedRequest> & { target?: unknown };
  return m.type === 'gloss-embed-request' && Array.isArray(m.texts) && m.target === undefined;
}

export async function handleEmbedRequest(texts: string[]): Promise<EmbedResult> {
  try {
    await ensureOffscreenDocument();
    const request: OffscreenEmbedRequest = { target: 'gloss-offscreen', type: 'gloss-embed-request', texts };
    return (await browser.runtime.sendMessage(request)) as EmbedResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error creating the offscreen embedding document.';
    return { ok: false, error: message };
  }
}

export function registerEmbedListener(): void {
  browser.runtime.onMessage.addListener((raw: unknown) => {
    if (!isContentEmbedRequest(raw)) return undefined;
    return handleEmbedRequest(raw.texts);
  });
}
```

**Verified before this plan was executed (both were originally flagged as unconfirmed guesses):**
1. `chrome.offscreen.Reason.WORKERS` — confirmed a real, valid enum member in `@types/chrome` (`chrome.offscreen.Reason`). There's no dedicated "WASM/ML compute" reason in the enum; `WORKERS` is the closest semantic fit and Chrome does not reject a syntactically valid reason for not matching your actual workload (that's an advisory/review-time concern, moot here since this extension is never published — see CLAUDE.md's hard constraints). No change needed.
2. `chrome.runtime.getContexts`'s shape — confirmed correct as written. `@types/chrome`'s `ContextFilter.contextTypes` is typed `` `${ContextType}`[] ``, and `chrome.runtime.ContextType.OFFSCREEN_DOCUMENT` is a real enum member that assigns cleanly to it; `documentUrls?: string[]` also matches. No change needed.

- [ ] **Step 4: Wire the listener into the background entrypoint**

Modify `src/entrypoints/background.ts`:

```ts
import { registerExplainPortListener } from '@/background/handleExplain';
import { registerEmbedListener } from '@/background/handleEmbed';

export default defineBackground(() => {
  registerExplainPortListener();
  registerEmbedListener();
});
```

- [ ] **Step 5: Write the offscreen document's HTML shell**

Create `src/entrypoints/offscreen/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Highlight Explainer — embedding worker</title>
  </head>
  <body>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

WXT treats this as an "unlisted" extension page (no special manifest wiring needed beyond the permission/CSP already added) — it builds to `/offscreen.html`, which is the path `handleEmbed.ts` above already references.

- [ ] **Step 6: Write `src/entrypoints/offscreen/main.ts`**

```ts
// Runs inside the chrome.offscreen document — the only place transformers.js runs. This
// page has its own extension-origin storage, separate from the content script's
// page-origin IndexedDB, so it never touches storage directly: text in, vectors out.

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL_ID } from '@/rag/embedder';
import type { EmbedResult, OffscreenEmbedRequest } from '@/messaging/types';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    console.log('[highlight-explainer] downloading embedding model (first run)…');
    extractorPromise = pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

function isOffscreenEmbedRequest(message: unknown): message is OffscreenEmbedRequest {
  const m = message as Partial<OffscreenEmbedRequest>;
  return m.target === 'gloss-offscreen' && m.type === 'gloss-embed-request' && Array.isArray(m.texts);
}

browser.runtime.onMessage.addListener((raw: unknown) => {
  if (!isOffscreenEmbedRequest(raw)) return undefined;

  return (async (): Promise<EmbedResult> => {
    try {
      const extractor = await getExtractor();
      const output = await extractor(raw.texts, { pooling: 'mean', normalize: true });
      return { ok: true, vectors: output.tolist() as number[][] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding error.';
      return { ok: false, error: message };
    }
  })();
});
```

**Verified before this plan was executed:** `pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' })` and `output.tolist()` were checked directly against the installed `@huggingface/transformers@4.2.0`'s own type definitions and JSDoc examples (`types/pipelines/feature-extraction.d.ts`, `types/utils/tensor.d.ts`) — both match exactly as written. `EMBEDDING_MODEL_ID` itself was corrected (see Task 1's `embedder.ts` above) from a guessed `Xenova/...` repo to the `onnx-community/...-ONNX` repo that this library version's own docs actually demonstrate.

- [ ] **Step 7: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 8: Manual test — the offscreen document actually loads and answers a request**

1. Run `npm run build`, then load the unpacked extension (`.output/chrome-mv3`) in Chrome dev mode.
2. Open the background service worker's DevTools (`chrome://extensions` → Highlight Explainer → "service worker" link).
3. In that console, run: `chrome.runtime.sendMessage({ type: 'gloss-embed-request', texts: ['hello world'] })` and confirm it resolves to `{ ok: true, vectors: [[...]] }` with a 384-number array (this exercises the exact same relay path `embedder.ts` uses, without needing a live claude.ai tab).
4. Confirm `chrome://extensions` → Highlight Explainer → "Inspect views" now lists `offscreen.html`, and its console shows the "downloading embedding model (first run)…" log on the first call only.
5. Run the same `sendMessage` call again — confirm it resolves quickly this time (cached, no re-download log).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json wxt.config.ts src/background/handleEmbed.ts src/entrypoints/background.ts src/entrypoints/offscreen
git commit -m "feat: run transformers.js in a chrome.offscreen document, relayed from the background worker"
```

---

## Task 5: Wire embedding into the incremental indexer, plus the position-256 diagnostics

**Files:**
- Modify: `src/sites/types.ts`
- Modify: `src/sites/claude.ts`
- Modify: `src/rag/indexer.ts`

**Interfaces:**
- Consumes: `embedTexts`, `EMBEDDING_VERSION` from `src/rag/embedder.ts` (Task 1); `Settings` from `src/options/storage.ts` (Task 1); `buildEmbedInputForChunk`, `buildSearchQueryText` from `src/rag/query.ts` (Task 3); `searchChunks` from `src/rag/search.ts` (Task 3); `getAllEmbeddings`, `putEmbedding` from `src/rag/store.ts` (Task 2).
- Produces: `getUnrecognizedRowIds()` on `SiteAdapter` — used only by `indexer.ts`.

- [ ] **Step 1: Add `getUnrecognizedRowIds` to the adapter contract**

In `src/sites/types.ts`, add to the `SiteAdapter` interface:

```ts
  /** Debug only: ids (or a placeholder) of DOM rows getAllMessages() couldn't recognize
   * (missing role or id) — lets the indexer log what it's silently not indexing. */
  getUnrecognizedRowIds(): string[];
```

- [ ] **Step 2: Implement it in `src/sites/claude.ts`**

Add to the `claudeAdapter` object, near `getAllMessages`:

```ts
  getUnrecognizedRowIds(): string[] {
    return allRows()
      .filter((row) => roleFromRow(row) === null || row.dataset.index === undefined)
      .map((row) => row.dataset.index ?? '(no data-index)');
  },
```

- [ ] **Step 3: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 4: Commit the adapter addition**

```bash
git add src/sites/types.ts src/sites/claude.ts
git commit -m "feat(sites): expose unrecognized-row ids from the claude.ai adapter for indexer diagnostics"
```

- [ ] **Step 5: Add the embedding step, the streaming-stuck valve, and the unrecognized-row log to `indexer.ts`**

Replace the whole file:

```ts
import { claudeAdapter, getTranscriptFeed } from '@/sites/claude';
import { getSettings, type Settings } from '@/options/storage';
import { chunkMessage, CHUNKER_VERSION } from './chunker';
import { hashText } from './hash';
import { embedTexts, EMBEDDING_VERSION } from './embedder';
import { buildEmbedInputForChunk, buildSearchQueryText } from './query';
import { searchChunks } from './search';
import {
  deleteMessage,
  getAllChunks,
  getAllEmbeddings,
  getAllMessageRecords,
  getMessageRecord,
  putEmbedding as putEmbeddingRecord,
  replaceMessage,
} from './store';
import type { Chunk, EmbeddingRecord, MessageRecord } from './types';

const DEBOUNCE_MS = 800;
const NAVIGATION_POLL_MS = 1000;
const STREAMING_STUCK_TIMEOUT_MS = 60_000;
const EMBED_BATCH_SIZE = 8;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// message key -> when it was first observed mid-stream. A real stream finishes in
// seconds; if a row is still reporting "streaming" after STREAMING_STUCK_TIMEOUT_MS, its
// data-perf-row-streaming flag is almost certainly stuck (e.g. an errored generation),
// and it's indexed anyway rather than skipped forever.
const streamingSince = new Map<string, number>();

function scheduleIndexPass(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runIndexPass(), DEBOUNCE_MS);
}

async function runIndexPass(): Promise<void> {
  const conversationId = claudeAdapter.getConversationId();
  if (!conversationId) return;

  const settings = await getSettings();

  if (settings.debugEnabled) {
    const unrecognized = claudeAdapter.getUnrecognizedRowIds();
    if (unrecognized.length > 0) {
      console.log('[highlight-explainer] rows with no recognized role/id (never indexed):', unrecognized);
    }
  }

  for (const message of claudeAdapter.getAllMessages()) {
    const key = `${conversationId}:${message.id}`;

    if (claudeAdapter.isStreaming(message.element)) {
      const firstSeen = streamingSince.get(key);
      if (firstSeen === undefined) {
        streamingSince.set(key, Date.now());
        if (settings.debugEnabled) console.log(`[highlight-explainer] skipping message ${message.id} — still streaming`);
        continue;
      }
      if (Date.now() - firstSeen < STREAMING_STUCK_TIMEOUT_MS) continue;
      if (settings.debugEnabled) {
        console.warn(
          `[highlight-explainer] message ${message.id} has looked like it's streaming for over ${STREAMING_STUCK_TIMEOUT_MS / 1000}s — indexing it anyway`,
        );
      }
    } else {
      streamingSince.delete(key);
    }

    const flatText = claudeAdapter.getMessageText(message.element);
    const textHash = await hashText(flatText);
    const existing = await getMessageRecord(key);

    const unchanged =
      existing !== undefined &&
      existing.textHash === textHash &&
      existing.chunkerVersion === CHUNKER_VERSION;
    if (unchanged) continue;

    const blocks = claudeAdapter.getMessageBlocks(message.element);
    const chunks = await chunkMessage(conversationId, message.id, message.role, blocks);
    const record: MessageRecord = {
      key,
      conversationId,
      messageId: message.id,
      position: Number(message.id),
      role: message.role,
      textHash,
      chunkerVersion: CHUNKER_VERSION,
      chunkIds: chunks.map((c) => c.id),
      lastIndexedAt: Date.now(),
    };
    await replaceMessage(record, chunks, existing?.chunkIds ?? []);

    // Yield back to the browser between messages so a big first-time backlog
    // (opening a long chat for the first time) doesn't block the page for long.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await cleanupStaleTail(conversationId);
  await embedPendingChunks(conversationId);
  if (settings.debugEnabled) await dumpChunks(conversationId);
}

/**
 * If the conversation's true last message is currently rendered, delete any
 * indexed message (and its chunks) at a position beyond it — this is what
 * catches a branch shortened by editing an earlier message and regenerating.
 * If the last-message row isn't rendered right now (e.g. scrolled up in a long,
 * virtualized chat), we don't know the true length, so we skip rather than risk
 * deleting real history that just isn't mounted at the moment.
 */
async function cleanupStaleTail(conversationId: string): Promise<void> {
  const lastPosition = claudeAdapter.getLastMessagePosition();
  if (lastPosition === null) return;

  const records = await getAllMessageRecords(conversationId);
  const stale = records.filter((r) => r.position > lastPosition);
  for (const record of stale) await deleteMessage(record);
}

function needsEmbedding(chunk: Chunk, existing: EmbeddingRecord | undefined): boolean {
  if (!existing) return true;
  if (existing.status === 'failed') return true;
  if (existing.embeddingVersion !== EMBEDDING_VERSION) return true;
  if (existing.chunkTextHash !== chunk.textHash) return true;
  return false;
}

/**
 * Embeds every chunk in the conversation that's new, changed, on a stale model version,
 * or previously failed. Batches multiple chunks per round trip to the offscreen document
 * (one round trip per chunk would be far slower), and yields between batches for the same
 * reason the per-message chunking loop above does.
 */
async function embedPendingChunks(conversationId: string): Promise<void> {
  const chunks = await getAllChunks(conversationId);
  const existingEmbeddings = await getAllEmbeddings(conversationId);
  const existingByChunkId = new Map(existingEmbeddings.map((e) => [e.chunkId, e]));

  const chunksByMessage = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const list = chunksByMessage.get(chunk.messageId) ?? [];
    list.push(chunk);
    chunksByMessage.set(chunk.messageId, list);
  }
  for (const list of chunksByMessage.values()) list.sort((a, b) => a.chunkIndex - b.chunkIndex);

  const pending = chunks.filter((c) => needsEmbedding(c, existingByChunkId.get(c.id)));

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const inputs = batch.map((chunk) => {
      const siblings = chunksByMessage.get(chunk.messageId) ?? [];
      const index = siblings.findIndex((c) => c.id === chunk.id);
      const previous = index > 0 ? siblings[index - 1]!.text : null;
      const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1]!.text : null;
      return buildEmbedInputForChunk(chunk.text, previous, next);
    });

    try {
      const vectors = await embedTexts(inputs);
      await Promise.all(
        batch.map((chunk, idx) =>
          putEmbeddingRecord({
            chunkId: chunk.id,
            conversationId,
            vector: vectors[idx]!,
            embeddingVersion: EMBEDDING_VERSION,
            chunkTextHash: chunk.textHash,
            status: 'done',
            embeddedAt: Date.now(),
          }),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding error.';
      console.warn('[highlight-explainer] failed to embed a batch of chunks, will retry next pass:', message);
      await Promise.all(
        batch.map((chunk) =>
          putEmbeddingRecord({
            chunkId: chunk.id,
            conversationId,
            vector: [],
            embeddingVersion: EMBEDDING_VERSION,
            chunkTextHash: chunk.textHash,
            status: 'failed',
            embeddedAt: Date.now(),
          }),
        ),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function dumpChunks(conversationId: string): Promise<void> {
  const chunks = await getAllChunks(conversationId);
  console.table(
    chunks.map((c) => ({
      messageId: c.messageId,
      chunkIndex: c.chunkIndex,
      role: c.role,
      wordCount: c.wordCount,
      hasCode: c.hasCode,
      preview: c.text.slice(0, 80),
    })),
  );
}

async function dumpSearch(conversationId: string, text: string, k: number): Promise<void> {
  const queryText = buildSearchQueryText(text, text);
  const [queryVector] = await embedTexts([queryText]);
  const results = await searchChunks(conversationId, queryVector!, k);

  console.table(
    results.map(({ chunk, score }) => ({
      score: score.toFixed(4),
      role: chunk.role,
      messageId: chunk.messageId,
      chunkIndex: chunk.chunkIndex,
      wordCount: chunk.wordCount,
      hasCode: chunk.hasCode,
      preview: chunk.text.slice(0, 80),
    })),
  );

  const lastPosition = claudeAdapter.getLastMessagePosition();
  const indexedCount = new Set((await getAllMessageRecords(conversationId)).map((r) => r.position)).size;
  if (lastPosition !== null) {
    console.log(
      `[highlight-explainer] indexed ${indexedCount} of ~${lastPosition + 1} messages in this chat — scroll through more of it to include it in search.`,
    );
  } else {
    console.log(
      `[highlight-explainer] indexed ${indexedCount} messages in this chat (true chat length unknown — the last message isn't currently rendered).`,
    );
  }
}

export function initIndexer(): () => void {
  let observedFeed: HTMLElement | null = null;
  const feedObserver = new MutationObserver(() => scheduleIndexPass());

  const attachToFeed = () => {
    const feed = getTranscriptFeed();
    if (feed && feed !== observedFeed) {
      feedObserver.disconnect();
      feedObserver.observe(feed, {
        attributes: true,
        attributeFilter: ['data-perf-row-streaming', 'data-last-message'],
        childList: true,
        subtree: true,
        characterData: true,
      });
      observedFeed = feed;
      scheduleIndexPass();
    }
  };

  let lastConversationId = claudeAdapter.getConversationId();
  attachToFeed();
  scheduleIndexPass();

  // claude.ai is a single-page app: the URL (and the feed element) can change
  // without a full page reload, and there's no reliable DOM event for that, so
  // a cheap poll is the pragmatic choice here over hooking history/pushState.
  const navigationPoll = setInterval(() => {
    const id = claudeAdapter.getConversationId();
    if (id !== lastConversationId) {
      lastConversationId = id;
      scheduleIndexPass();
    }
    attachToFeed(); // also covers the feed element itself being remounted
  }, NAVIGATION_POLL_MS);

  (window as unknown as { __glossDumpChunks?: () => Promise<void> }).__glossDumpChunks = async () => {
    const id = claudeAdapter.getConversationId();
    if (id) await dumpChunks(id);
  };

  (window as unknown as { __glossSearch?: (text: string, k?: number) => Promise<void> }).__glossSearch = async (
    text: string,
    k?: number,
  ) => {
    const id = claudeAdapter.getConversationId();
    if (!id) return;
    const settings: Settings = await getSettings();
    await dumpSearch(id, text, k ?? settings.retrievalK);
  };

  return () => {
    feedObserver.disconnect();
    clearInterval(navigationPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run compile`
Expected: no errors — `Settings.retrievalK` already exists from Task 1, `embedTexts`/`EMBEDDING_VERSION` from Task 1, `buildEmbedInputForChunk`/`buildSearchQueryText` and `searchChunks` from Task 3, `getAllEmbeddings`/`putEmbedding` from Task 2 are all already in place by this point in the plan.

- [ ] **Step 7: Commit**

```bash
git add src/rag/indexer.ts
git commit -m "feat(rag): embed new/changed chunks during indexing, add a streaming-stuck safety valve, and log unrecognized rows"
```

---

## Task 6: Options page `k` field and full manual verification

**Files:**
- Modify: `src/entrypoints/options/index.html`
- Modify: `src/entrypoints/options/main.ts`

**Interfaces:**
- Consumes: `Settings.retrievalK` from `src/options/storage.ts` (Task 1).

- [ ] **Step 1: Add the field to the options page HTML**

In `src/entrypoints/options/index.html`, add before the `<button type="submit">`:

```html
      <label for="retrieval-k">Search results to retrieve (k)</label>
      <input type="number" id="retrieval-k" min="1" max="20" step="1" />
      <p class="hint">
        How many matching chunks <code>__glossSearch</code> shows by default in the
        console. Retrieval isn't used in the explain answer yet.
      </p>
```

- [ ] **Step 2: Wire it up in `src/entrypoints/options/main.ts`**

```ts
// Options form: API key, model id, debug toggle, retrieval k. Reads/writes chrome.storage.local
// directly through src/options/storage.ts — no messaging involved.

import { getSettings, setSettings } from '@/options/storage';
import { DEFAULT_MODEL_ID } from '@/llm/gemini';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const apiKeyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const modelIdInput = document.querySelector<HTMLInputElement>('#model-id')!;
const debugEnabledInput = document.querySelector<HTMLInputElement>('#debug-enabled')!;
const retrievalKInput = document.querySelector<HTMLInputElement>('#retrieval-k')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  modelIdInput.value = settings.modelId || DEFAULT_MODEL_ID;
  debugEnabledInput.checked = settings.debugEnabled;
  retrievalKInput.value = String(settings.retrievalK || 5);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const parsedK = Math.round(Number(retrievalKInput.value));

  await setSettings({
    apiKey: apiKeyInput.value.trim(),
    modelId: modelIdInput.value.trim() || DEFAULT_MODEL_ID,
    debugEnabled: debugEnabledInput.checked,
    retrievalK: Number.isFinite(parsedK) && parsedK > 0 ? parsedK : 5,
  });

  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

void loadSettings();
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run compile && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/entrypoints/options/index.html src/entrypoints/options/main.ts
git commit -m "feat(options): expose the retrieval k setting on the options page"
```

- [ ] **Step 5: Full manual verification on live claude.ai**

1. Load the unpacked extension (`.output/chrome-mv3`) in Chrome dev mode. Turn on the debug toggle and set a retrieval k (or leave the default 5) on the options page.
2. Open a claude.ai chat with a mix of short and long messages, including at least one short code snippet (a single command line) inside a longer answer. Wait for indexing to settle, then run `window.__glossDumpChunks()` in the page console to confirm chunking still looks right (unchanged from v2).
3. Watch the console for `[highlight-explainer] downloading embedding model (first run)…` on the very first embed of this browser profile, and confirm subsequent messages embed without that log (cached).
4. Open DevTools → Application → IndexedDB → `highlight-explainer` → `embeddings` and confirm rows exist with `status: 'done'` and a 384-number `vector` for each chunk.
5. Run `window.__glossSearch('some phrase that appears in one of the assistant answers')` and confirm: a `console.table` of scored chunks appears, the chunk containing that phrase (or a close paraphrase) scores highest, and the coverage line prints a sensible "indexed N of ~M" count.
6. Specifically test a highlight that matches text inside a short code line (e.g. a command or connection string) — confirm that exact chunk is still retrievable and doesn't get crowded out because its own embedding text was too short to be meaningful (decision 9).
7. Edit an earlier message and let it regenerate; confirm via IndexedDB inspection that the old chunk ids' embedding rows are gone, not just orphaned, and that the new chunks get embedded on the next pass.
8. If reachable (a chat long enough to have virtualized/unmounted rows, matching the user's own 27-of-403 measurement): turn on debug mode, open the chat, and check the console for either the "still streaming" skip log or the "unrecognized rows" log around the previously-missing position — this is the live diagnostic for decision 10's two candidate explanations. Note which one it turned out to be; if it's the stuck-streaming case, confirm the 60-second safety valve actually fires (it will only fire during this same tab session if a message stays visibly "streaming" that long).
9. Confirm v1's Explain flow is completely unaffected: highlight text, click "Explain," and get a correct streamed answer exactly as before.
10. Confirm no visible slowdown while a long answer streams in or while a backlog of unembedded chunks is being processed in the background.

**Do not commit any console output, exported chunks, or IndexedDB dumps from this step** — CLAUDE.md's new hard constraint (added this session) means none of that real chat content goes into the repo, even as a "here's what I saw" note in a commit message body.

---

## Self-Review

**Spec coverage:**
- Decision 1 (model choice) → Task 1 (`EMBEDDING_MODEL_ID`, `EMBEDDING_VERSION`), verification flagged in Task 1 Step 3's and Task 4 Step 6's notes.
- Decision 2 (offscreen document, CSP, caching, first-run log, content-script-can't-reach-offscreen-directly) → Task 4 (manifest, `handleEmbed.ts`, `offscreen/main.ts`).
- Decision 3 (incremental embedding, batching, failure → retry not silent-done) → Task 5 (`needsEmbedding`, `embedPendingChunks`).
- Decision 4 (embeddings store, embeddingVersion, oldVersion branching bug fix, orphan cleanup) → Task 2.
- Decision 5 (query = highlight + sentence, typed-question gap documented) → Task 3 (`buildSearchQueryText`), called out explicitly in Decisions Locked In and in the function's own doc comment.
- Decision 6 (cosine similarity, configurable k) → Task 3 (`cosineSimilarity`, `rankChunks`) + Task 1 (`retrievalK` in storage) + Task 6 (options UI for it).
- Decision 7 (inspection via console command) → Task 5 (`__glossSearch`, `dumpSearch`).
- Decision 8 (coverage line instead of auto-scroll) → Task 5 (`dumpSearch`'s coverage log).
- Decision 9 (tiny-chunk neighbor merge, stored chunk untouched) → Task 3 (`buildEmbedInputForChunk`), consumed in Task 5's `embedPendingChunks`.
- Decision 10 (position-256 diagnostics + streaming-stuck fix) → Task 5 (`getUnrecognizedRowIds` log, `streamingSince` timeout valve, adapter addition) + Task 6 Step 5.8 (live verification).
- Decision 11 (chrome.* vs browser.* split) → Task 4 (`handleEmbed.ts` uses `chrome.offscreen`/`chrome.runtime.getContexts`; messaging stays on `browser.runtime`).
- CLAUDE.md's new "never commit chat content" constraint → called out explicitly in Task 6 Step 5's closing line and in Global Constraints.

**Placeholder scan:** none found — every step has real code or a concrete, specific manual-check procedure. Two things are explicitly flagged as needing live verification rather than being asserted as fact (the offscreen `reasons` enum value and `getContexts` shape in Task 4, and the exact `@huggingface/transformers` API surface in Tasks 1 and 4) — each is flagged with a specific fallback (a synchronous throw naming valid options, or a documented alternative call shape) rather than left vague, consistent with how CLAUDE.md itself already flags the Gemini model id as something to verify rather than trust blindly.

**Type consistency:** `EmbeddingRecord` (Task 1) is used identically in `store.ts` (Task 2: `getEmbeddingRecord`, `getAllEmbeddings`, `putEmbedding` all take/return this exact shape), `search.ts` (Task 3: `rankChunks`'s `embeddings: EmbeddingRecord[]` parameter), and `indexer.ts` (Task 5: the object literals passed to `putEmbeddingRecord` match the interface field-for-field, including `status: 'done' | 'failed'` — no `'pending'` is ever constructed, matching the refinement noted in Decision 4). `EmbedRequest`/`EmbedResult`/`OffscreenEmbedRequest` (Task 1) are used with matching field names at every call site: `embedder.ts`'s `embedTexts` (Task 1) builds an `EmbedRequest` and expects an `EmbedResult` back; `handleEmbed.ts` (Task 4) receives an `EmbedRequest`-shaped message, builds an `OffscreenEmbedRequest`, and returns an `EmbedResult`; `offscreen/main.ts` (Task 4) receives the `OffscreenEmbedRequest` and returns an `EmbedResult`. `ScoredChunk` (Task 3) is returned by both `rankChunks` and `searchChunks` and consumed with the same `{ chunk, score }` shape in `indexer.ts`'s `dumpSearch` (Task 5). `Settings.retrievalK` (Task 1) is read in Task 5's `__glossSearch` wiring and written in Task 6's options form — same field name, same type, in both places.

**Task-ordering check (this plan's own addition to the standard self-review, given the corrections made while drafting):** confirmed each task's typecheck/test step only requires symbols that already exist from a strictly earlier task — Task 1 (types + messaging contract + embedder + settings) has no dependencies on anything in this plan; Task 2 (store) depends only on Task 1's `EmbeddingRecord`; Task 3 (query/search) depends only on Task 1's types and Task 2's `getAllChunks`/`getAllEmbeddings`; Task 4 (offscreen/background) depends only on Task 1's messaging types and `EMBEDDING_MODEL_ID`; Task 5 (indexer) depends on Tasks 1-3 (and functionally on Task 4 at runtime, but not at compile time); Task 6 (options UI) depends only on Task 1's `Settings.retrievalK`. No task requires editing an import statement shown in an earlier task's code block after the fact.
