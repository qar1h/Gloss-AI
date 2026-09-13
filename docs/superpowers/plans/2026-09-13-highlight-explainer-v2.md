# Highlight Explainer v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v2 — chunking and storage. Split each claude.ai conversation into ~100–180 word chunks (never splitting a code block), store them in IndexedDB keyed per conversation, and keep the index incrementally up to date as messages stream in, get edited, get regenerated, or the branch gets shorter. No embeddings, no retrieval, no change to how the v1 explain prompt is built.

**Architecture:** All new code lives in `src/rag/` (chunker, hash, store, indexer) plus small additive methods on the existing `SiteAdapter` (`src/sites/claude.ts`). A debounced `MutationObserver` on the transcript feed drives an incremental indexing pass: for each message currently in the DOM, compare its content hash (and the chunker's own version number) against what's stored, and only re-chunk what's new or changed. Chunking itself is a pure function (`rag/chunker.ts`) over an ordered list of typed `Block`s that the adapter extracts from a message's DOM — this is the piece v1 never needed, since v1 only ever wanted one flattened string per message.

**Tech Stack:** Same as v1 (WXT/TS/Manifest V3), plus the native `indexedDB` API (no new dependency) and one new devDependency, `vitest`, added specifically because this plan asks for real unit tests on the pure chunker — see Task 4 and "New Dependency" below.

**Spec:** `CLAUDE.md` (this repo's root), the "v2: Chunking and storage" section, plus the four refinements the user requested during v2 planning (see "Decisions Locked In Beyond CLAUDE.md" below).

## Global Constraints

- Zero cost, personal use only, API key handling: unchanged from v1 (v2 touches none of this).
- Only the visible DOM of the chat page is read — no site private APIs, no network calls added.
- All claude.ai selectors/DOM knowledge live in `src/sites/claude.ts` and nowhere else.
- v1's behavior must not change. Every v1 file this plan touches (`src/sites/types.ts`, `src/sites/claude.ts`, `src/content/index.ts`) only gets **additions**, never edits to existing methods' logic.
- No embeddings, no retrieval, no BM25 — those are v3/v4. This plan only builds chunking + storage.
- Do not add a dependency without asking first — **except** `vitest`, which the user explicitly asked for in the form of "add unit tests for chunker.ts," and which this plan calls out by name before installing it.

## Decisions Locked In Beyond CLAUDE.md

These were resolved during planning, in response to the user's four requested changes:

1. **Chunk ceiling is 180 words, not 300.** All-MiniLM-L6-v2 (v3's default candidate) truncates at 256 tokens (~190 words); bge-small-en-v1.5 goes to 512 tokens (~380 words). Locking today's ceiling to something that only works if v3 later picks bge-small would make v2 quietly depend on a v3 decision that hasn't been made — and CLAUDE.md's own workflow rule says not to presuppose later versions. A 180-word ceiling is safe under **either** model, so it keeps v3's model choice genuinely open. It also has no real downside: smaller chunks are generally fine (often better) for retrieval precision. One caveat carried forward to v3, not solved here: a code chunk is deliberately allowed to exceed this ceiling (never split), so an oversized code chunk will still get silently truncated at embed time regardless of which model v3 picks — that's a v3-time decision (truncate-and-embed vs. rely on v4's BM25 to find it instead).
2. **`chunkerVersion` on the message bookkeeping row.** `CHUNKER_VERSION` is a constant in `chunker.ts` (starts at `1`). A message is re-chunked if its content hash changed *or* its stored `chunkerVersion` is behind the current constant — so bumping the constant after a future chunking-rule change forces a clean re-index without needing every message's content to also change.
3. **Stale-tail cleanup uses the true last message, not "however many rows happen to be in the DOM."** The original ask was "delete rows for positions beyond the current message count." That's unsafe as literally stated: claude.ai virtualizes/paginates the transcript (`transcript-sizer`/`transcript-spacer` in the fixtures), so a long chat scrolled away from the bottom can have *fewer* rows in the DOM than the conversation actually has — deleting on that basis would wrongly discard real, older indexed chunks. Fixed version: only run the cleanup when the row with `data-last-message="true"` is currently rendered (confirmed present in `fixtures/short-chat.html`) — that row's `data-index` is the conversation's true final position, independent of how many rows happen to be mounted right now. Delete any indexed message beyond *that* position. If the last-message row isn't currently rendered, skip cleanup for this pass entirely rather than guess.
4. **Nested blocks (`blockquote > p`, `li > pre`) are de-duplicated in the adapter, in two steps:**
   - A block is dropped if a *closer* ancestor within the same message also matches the block selector (`p, li, h1-h6, blockquote, pre`) — this collapses `blockquote > p` down to just the blockquote, since the blockquote's own `textContent` already includes the paragraph's text.
   - `pre` is the one exception to that rule: it is **always** kept as its own block regardless of nesting (so `li > pre` keeps the `pre` as a code chunk). To stop the *surrounding* block's text from then repeating the code, any kept non-code block has its own nested `<pre>` elements stripped (via a detached clone) before its `textContent` is read. So `li > pre` yields a `code` block (the pre, verbatim) and, separately, whatever text the `li` had *outside* the pre (often nothing).
   - One bonus fix found while implementing this: code text must **not** go through the same whitespace-collapsing used for prose (`text.replace(/\s+/g, ' ')`) — that would destroy indentation and line breaks. Code blocks keep their raw `textContent` (trimmed only at the ends); every other block type gets whitespace-normalized.
   - A related fix this surfaced: the small-leftover-merge rule (fold a tiny trailing chunk into the previous one) must **not** apply to a group that starts with a heading — otherwise a short section immediately after a heading would get silently folded back into the *previous, unrelated* section, undoing the "heading always starts a new chunk" rule. Heading-led groups are exempted from the merge.

## New Dependency: vitest

`chunker.ts` is pure (no DOM), which is exactly the case CLAUDE.md's dependency rule exists to gate sensibly on: the user explicitly asked for real unit tests on it, and `vite` (which vitest reuses) is already a devDependency, so `vitest` is a small, natural addition — one new devDependency, no config beyond a `test` script. Flagging it here by name rather than adding it silently.

---

## File Structure

```
Gloss/
  package.json                       # + vitest devDependency, + "test" script
  fixtures/
    claude-code-message.html         # (already added by the user) real code-block markup
    long-chat-with-code.html          # NEW: full transcript with headings, long paragraphs, and a real code block
  src/
    sites/
      types.ts                       # + Block import, + 5 new SiteAdapter methods (additive only)
      claude.ts                      # + implementations of those 5 methods (additive only)
    rag/
      types.ts                       # NEW: Block, Chunk, MessageRecord
      hash.ts                        # NEW: sha256 truncated-hex helper
      chunker.ts                     # NEW: pure chunking logic + CHUNKER_VERSION
      chunker.test.ts                # NEW: vitest unit tests
      store.ts                       # NEW: IndexedDB wrapper (messages + chunks object stores)
      indexer.ts                     # NEW: debounce/observe/diff orchestration, debug dump
    content/
      index.ts                       # + one call to initIndexer() (additive only)
```

**Design note:** `rag/chunker.ts` never touches the DOM — it takes `Block[]` (already extracted) and returns `Chunk[]`. All DOM extraction (which is also all the claude.ai-specific knowledge) stays in `src/sites/claude.ts`, matching the existing adapter boundary. `rag/store.ts` never touches the DOM either — it only knows about `Chunk`/`MessageRecord` shapes. `rag/indexer.ts` is the one file that ties the DOM (via the adapter) to the pure logic (chunker) and to storage (store) — it's intentionally the "messy" orchestration layer so the other three stay simple and testable.

---

## Task 1: Shared types and the hash helper

**Files:**
- Create: `src/rag/types.ts`
- Create: `src/rag/hash.ts`

**Interfaces:**
- Produces: `Block { type: 'heading'|'paragraph'|'list-item'|'blockquote'|'code'; text: string }`, `Chunk { id, conversationId, messageId, role, chunkIndex, order, text, textHash, wordCount, hasCode, createdAt }`, `MessageRecord { key, conversationId, messageId, position, role, textHash, chunkerVersion, chunkIds, lastIndexedAt }`, `hashText(text: string): Promise<string>`.

- [ ] **Step 1: Write `src/rag/types.ts`**

```ts
// Shared types for chunking and storage. No DOM access anywhere in this file.

export type BlockType = 'heading' | 'paragraph' | 'list-item' | 'blockquote' | 'code';

export interface Block {
  type: BlockType;
  text: string;
}

export interface Chunk {
  id: string; // `${conversationId}:${messageId}:${chunkIndex}`
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  chunkIndex: number;
  order: number; // Number(messageId) * 1000 + chunkIndex — cheap chat-order sort key
  text: string;
  textHash: string;
  wordCount: number;
  hasCode: boolean;
  createdAt: number;
}

export interface MessageRecord {
  key: string; // `${conversationId}:${messageId}`
  conversationId: string;
  messageId: string;
  position: number; // Number(messageId)
  role: 'user' | 'assistant';
  textHash: string;
  chunkerVersion: number;
  chunkIds: string[];
  lastIndexedAt: number;
}
```

- [ ] **Step 2: Write `src/rag/hash.ts`**

```ts
// sha256 hex digest, truncated to 16 hex chars (64 bits) — enough to detect content
// changes for incremental indexing. Not used for anything security-sensitive.

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run compile`
Expected: no errors (these two files aren't imported anywhere yet, but must still typecheck standalone).

- [ ] **Step 4: Commit**

```bash
git add src/rag/types.ts src/rag/hash.ts
git commit -m "feat(rag): add chunk/message types and a truncated sha256 helper"
```

---

## Task 2: Adapter additions — conversation id, all-messages, streaming check, last-message position, block extraction

**Files:**
- Modify: `src/sites/types.ts`
- Modify: `src/sites/claude.ts`

**Interfaces:**
- Consumes: `Block` from `src/rag/types.ts` (Task 1).
- Produces (added to `SiteAdapter`, consumed by `rag/indexer.ts` in Task 6):
  `getConversationId(): string | null`
  `getAllMessages(): SiteMessage[]`
  `isStreaming(el: HTMLElement): boolean`
  `getLastMessagePosition(): number | null`
  `getMessageBlocks(el: HTMLElement): Block[]`

- [ ] **Step 1: Add the five method signatures to `SiteAdapter` in `src/sites/types.ts`**

```ts
import type { Block } from '@/rag/types';

export interface SiteAdapter {
  // ...existing v1 methods unchanged...

  /** The current conversation's stable id (from the URL), or null if not on a chat page. */
  getConversationId(): string | null;

  /** Every message currently rendered in the DOM, in chat order. */
  getAllMessages(): SiteMessage[];

  /** Whether a message is still being written (mid-stream). */
  isStreaming(el: HTMLElement): boolean;

  /** The position of the conversation's true last message, if that row is currently rendered. */
  getLastMessagePosition(): number | null;

  /** A message's content broken into ordered, typed blocks (paragraphs, headings, code, ...). */
  getMessageBlocks(el: HTMLElement): Block[];
}
```

- [ ] **Step 2: Implement block extraction in `src/sites/claude.ts`**

Add near the existing `BLOCK_SELECTOR` constant:

```ts
import type { Block, BlockType } from '@/rag/types';

function blockType(el: Element): BlockType {
  switch (el.tagName) {
    case 'PRE': return 'code';
    case 'BLOCKQUOTE': return 'blockquote';
    case 'LI': return 'list-item';
    case 'P': return 'paragraph';
    default: return 'heading'; // H1-H6
  }
}

function blockText(el: Element, type: BlockType): string {
  if (type === 'code') {
    return (el.textContent ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
  }
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('pre').forEach((pre) => pre.remove());
  return normalizeWhitespace(clone.textContent ?? '');
}

function getBlocks(messageRoot: HTMLElement): Block[] {
  const candidates = Array.from(messageRoot.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const kept = candidates.filter((el) => {
    if (el.tagName === 'PRE') return true; // code always wins, regardless of nesting
    if (el.closest('pre')) return false; // inside a code block, not a separate block
    const ancestorBlock = el.parentElement?.closest(BLOCK_SELECTOR);
    return !(ancestorBlock && messageRoot.contains(ancestorBlock));
  });
  return kept.map((el) => {
    const type = blockType(el);
    return { type, text: blockText(el, type) };
  });
}
```

- [ ] **Step 3: Implement the other four methods on the `claudeAdapter` object**

```ts
getConversationId(): string | null {
  const match = location.pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
},

getAllMessages(): SiteMessage[] {
  return allRows()
    .map((row) => {
      const role = roleFromRow(row);
      const id = row.dataset.index;
      return role && id !== undefined ? { id, role, element: row } : null;
    })
    .filter((m): m is SiteMessage => m !== null);
},

isStreaming(el: HTMLElement): boolean {
  return el.dataset.perfRowStreaming === 'true';
},

getLastMessagePosition(): number | null {
  const row = document.querySelector<HTMLElement>(`${ROW_SELECTOR}[data-last-message="true"]`);
  if (!row || row.dataset.index === undefined) return null;
  const n = Number(row.dataset.index);
  return Number.isNaN(n) ? null : n;
},

getMessageBlocks(el: HTMLElement): Block[] {
  const role = roleFromRow(el);
  if (!role) return [];
  const selector = role === 'user' ? USER_TEXT_SELECTOR : ASSISTANT_TEXT_SELECTOR;
  const contentEl = el.querySelector<HTMLElement>(selector);
  return contentEl ? getBlocks(contentEl) : [];
},
```

- [ ] **Step 4: Verify against fixtures**

Open `fixtures/short-chat.html` in a browser (or a quick scratch script with `jsdom` is overkill here — a manual DevTools check is enough per the project's existing manual-testing approach). Confirm:
- `document.querySelector('[data-testid="transcript-row"][data-last-message="true"]')` finds the row with `data-perf-row-from-tail="0"`.
- `location.pathname` pattern `/\/chat\/([^/]+)/` — **verify this against a real claude.ai chat URL before relying on it**; this was not read off a captured fixture (fixtures don't capture the URL), so treat it as an assumption to confirm live, the same way selectors are confirmed, not shipped on faith.

- [ ] **Step 5: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sites/types.ts src/sites/claude.ts
git commit -m "feat(sites): add conversation-id, message-list, streaming, and block-extraction to the claude.ai adapter"
```

---

## Task 3: New fixture — long multi-paragraph answer with a real code block

**Files:**
- Create: `fixtures/long-chat-with-code.html`

**Interfaces:**
- Consumes: the real code-block markup the user already captured in `fixtures/claude-code-message.html`.

- [ ] **Step 1: Build the fixture**

Take the row structure from `fixtures/short-chat.html` (the `data-testid="transcript-row"` wrapper, `data-cds="Prose"` / `data-perf-reply-text` content container) and build a conversation with:
- one short user message (`data-index="0"`),
- one long assistant answer (`data-index="1"`) containing: a heading, two paragraphs each over 150 words, a second heading, then the **real** code block from `fixtures/claude-code-message.html` pasted in as-is (not re-typed — copy the actual `<div role="group">…<pre class="code-block__code">…</pre></div>` markup, since that's the real DOM shape claude.ai renders, not a guess), followed by one more short paragraph after the code.
- The final row must carry `data-last-message="true"` and `data-perf-row-from-tail="0"`, matching the real pattern confirmed in `short-chat.html`, so Task 2's `getLastMessagePosition()` has something real to find.

- [ ] **Step 2: Sanity-check by hand**

Open the file in a browser, confirm the code block renders (syntax highlighting aside, the text should read as valid Python), and confirm `document.querySelectorAll('[data-testid="transcript-row"]')` returns exactly 2 rows.

- [ ] **Step 3: Commit**

```bash
git add fixtures/long-chat-with-code.html
git commit -m "test: add a fixture with a long multi-paragraph answer and a real code block"
```

---

## Task 4: The chunker, its tests, and vitest

**Files:**
- Create: `src/rag/chunker.ts`
- Create: `src/rag/chunker.test.ts`
- Modify: `package.json` (add `vitest` devDependency + `test` script)

**Interfaces:**
- Consumes: `Block`, `Chunk` from `src/rag/types.ts` (Task 1); `hashText` from `src/rag/hash.ts` (Task 1).
- Produces: `CHUNKER_VERSION: number`, `chunkMessage(conversationId: string, messageId: string, role: 'user'|'assistant', blocks: Block[]): Promise<Chunk[]>` — consumed by `rag/indexer.ts` in Task 6.

- [ ] **Step 1: Install vitest**

```bash
npm install -D vitest
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing tests first — `src/rag/chunker.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { chunkMessage } from './chunker';
import type { Block } from './types';

const CONV = 'conv-1';

describe('chunkMessage', () => {
  it('keeps a code block whole even past the word ceiling', async () => {
    const longCode = Array.from({ length: 100 }, (_, i) => `line_${i} = ${i}`).join('\n');
    const blocks: Block[] = [
      { type: 'paragraph', text: 'Here is the function you asked for.' },
      { type: 'code', text: longCode },
    ];
    const chunks = await chunkMessage(CONV, '5', 'assistant', blocks);
    const codeChunks = chunks.filter((c) => c.hasCode);
    expect(codeChunks).toHaveLength(1);
    expect(codeChunks[0].text).toBe(longCode);
  });

  it('starts a new chunk at a heading, even if the following section is short', async () => {
    const blocks: Block[] = [
      { type: 'paragraph', text: 'x '.repeat(150).trim() },
      { type: 'heading', text: 'Next section' },
      { type: 'paragraph', text: 'Some content after the heading.' },
    ];
    const chunks = await chunkMessage(CONV, '2', 'assistant', blocks);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].text.startsWith('Next section')).toBe(true);
  });

  it('folds a small trailing leftover into the previous chunk', async () => {
    const blocks: Block[] = [
      { type: 'paragraph', text: 'x '.repeat(170).trim() },
      { type: 'paragraph', text: 'one two three four five six seven eight nine ten eleven twelve' },
    ];
    const chunks = await chunkMessage(CONV, '3', 'assistant', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('twelve');
  });

  it('never duplicates text from nested blocks once the adapter has de-duplicated them', async () => {
    const blocks: Block[] = [
      { type: 'blockquote', text: 'A quoted paragraph in full.' },
      { type: 'list-item', text: '1.' },
      { type: 'code', text: 'print("hi")' },
    ];
    const chunks = await chunkMessage(CONV, '4', 'assistant', blocks);
    const combined = chunks.map((c) => c.text).join('\n');
    expect(combined.match(/A quoted paragraph in full\./g)).toHaveLength(1);
    expect(combined.match(/print\("hi"\)/g)).toHaveLength(1);
  });

  it('never mixes text from two different messages', async () => {
    const chunksA = await chunkMessage(CONV, '0', 'user', [{ type: 'paragraph', text: 'Message A content.' }]);
    const chunksB = await chunkMessage(CONV, '1', 'assistant', [{ type: 'paragraph', text: 'Message B content.' }]);
    expect(chunksA.every((c) => c.messageId === '0')).toBe(true);
    expect(chunksB.every((c) => c.messageId === '1')).toBe(true);
    expect(chunksA.some((c) => c.text.includes('Message B'))).toBe(false);
    expect(chunksB.some((c) => c.text.includes('Message A'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run`
Expected: FAIL — `./chunker` does not exist yet.

- [ ] **Step 4: Write `src/rag/chunker.ts`**

```ts
import type { Block, Chunk } from './types';
import { hashText } from './hash';

export const CHUNKER_VERSION = 1;

const MAX_CHUNK_WORDS = 180;
const MERGE_THRESHOLD_WORDS = 20;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

interface Group {
  blocks: Block[];
  words: number;
}

export function groupBlocks(blocks: Block[]): { text: string; hasCode: boolean }[] {
  const groups: Group[] = [];
  let current: Group = { blocks: [], words: 0 };

  const flush = () => {
    if (current.blocks.length > 0) {
      groups.push(current);
      current = { blocks: [], words: 0 };
    }
  };

  for (const block of blocks) {
    const words = wordCount(block.text);

    if (block.type === 'code') {
      flush();
      groups.push({ blocks: [block], words });
      continue;
    }

    if (block.type === 'heading' && current.blocks.length > 0) {
      flush();
    }

    if (current.words > 0 && current.words + words > MAX_CHUNK_WORDS) {
      flush();
    }

    current.blocks.push(block);
    current.words += words;
  }
  flush();

  // Fold a small trailing leftover into the previous group — but never a group
  // that starts with a heading (that's a deliberate new section, not an orphan)
  // and never onto/from a code group (code never merges with prose).
  for (let i = groups.length - 1; i > 0; i--) {
    const group = groups[i];
    const prev = groups[i - 1];
    const isCode = (g: Group) => g.blocks.length === 1 && g.blocks[0].type === 'code';
    const startsWithHeading = group.blocks[0]?.type === 'heading';
    if (group.words < MERGE_THRESHOLD_WORDS && !isCode(group) && !isCode(prev) && !startsWithHeading) {
      prev.blocks.push(...group.blocks);
      prev.words += group.words;
      groups.splice(i, 1);
    }
  }

  return groups.map((g) => ({
    text: g.blocks.map((b) => b.text).join('\n\n'),
    hasCode: g.blocks.some((b) => b.type === 'code'),
  }));
}

export async function chunkMessage(
  conversationId: string,
  messageId: string,
  role: 'user' | 'assistant',
  blocks: Block[],
): Promise<Chunk[]> {
  const groups = groupBlocks(blocks);
  const position = Number(messageId);
  const now = Date.now();

  return Promise.all(
    groups.map(async (group, chunkIndex) => ({
      id: `${conversationId}:${messageId}:${chunkIndex}`,
      conversationId,
      messageId,
      role,
      chunkIndex,
      order: position * 1000 + chunkIndex,
      text: group.text,
      textHash: await hashText(group.text),
      wordCount: wordCount(group.text),
      hasCode: group.hasCode,
      createdAt: now,
    })),
  );
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/rag/chunker.ts src/rag/chunker.test.ts
git commit -m "feat(rag): add the pure chunker with word-ceiling, heading, and code-atomicity rules, plus unit tests"
```

---

## Task 5: IndexedDB store

**Files:**
- Create: `src/rag/store.ts`

**Interfaces:**
- Consumes: `Chunk`, `MessageRecord` from `src/rag/types.ts` (Task 1).
- Produces: `getMessageRecord(key)`, `getAllMessageRecords(conversationId)`, `getAllChunks(conversationId)`, `replaceMessage(record, chunks, previousChunkIds)`, `deleteMessage(record)` — all consumed by `rag/indexer.ts` in Task 6.

- [ ] **Step 1: Write `src/rag/store.ts`**

```ts
// A minimal, hand-rolled promise wrapper around the native IndexedDB API — no
// dependency added. Two object stores: "messages" (one bookkeeping row per
// indexed message, keyed by "<conversationId>:<messageId>") and "chunks" (the
// chunk records, keyed by "<conversationId>:<messageId>:<chunkIndex>"). Both
// carry a conversationId field with a matching index, since every read in this
// file is scoped to one conversation. Conversation-sized result sets (at most a
// few thousand rows for a very long personal chat) are small enough to sort and
// filter in memory rather than building compound-key range queries.

import type { Chunk, MessageRecord } from './types';

const DB_NAME = 'highlight-explainer';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const CHUNKS_STORE = 'chunks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(MESSAGES_STORE, { keyPath: 'key' }).createIndex(
          'by_conversation',
          'conversationId',
        );
        db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' }).createIndex(
          'by_conversation',
          'conversationId',
        );
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getMessageRecord(key: string): Promise<MessageRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(MESSAGES_STORE, 'readonly');
  return promisifyRequest(tx.objectStore(MESSAGES_STORE).get(key));
}

export async function getAllMessageRecords(conversationId: string): Promise<MessageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(MESSAGES_STORE, 'readonly');
  return promisifyRequest(tx.objectStore(MESSAGES_STORE).index('by_conversation').getAll(conversationId));
}

export async function getAllChunks(conversationId: string): Promise<Chunk[]> {
  const db = await openDb();
  const tx = db.transaction(CHUNKS_STORE, 'readonly');
  const chunks = await promisifyRequest<Chunk[]>(
    tx.objectStore(CHUNKS_STORE).index('by_conversation').getAll(conversationId),
  );
  return chunks.sort((a, b) => a.order - b.order);
}

/**
 * Replace everything derived from one message: delete its previous chunks (if
 * any), write the new ones, and write its bookkeeping row — all in one
 * readwrite transaction spanning both stores, so a mid-write failure can't
 * leave chunks and bookkeeping out of sync.
 */
export async function replaceMessage(
  record: MessageRecord,
  chunks: Chunk[],
  previousChunkIds: string[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  for (const id of previousChunkIds) chunkStore.delete(id);
  for (const chunk of chunks) chunkStore.put(chunk);
  tx.objectStore(MESSAGES_STORE).put(record);
  await promisifyTx(tx);
}

/** Delete a message's bookkeeping row and all of its chunks (used for stale-tail cleanup). */
export async function deleteMessage(record: MessageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  for (const id of record.chunkIds) chunkStore.delete(id);
  tx.objectStore(MESSAGES_STORE).delete(record.key);
  await promisifyTx(tx);
}
```

- [ ] **Step 2: Manual smoke check**

This file has no DOM dependency, but it does need a real IndexedDB, which vitest's default `node` environment doesn't provide — writing a real test here would need `fake-indexeddb`, a second new test dependency the user didn't ask for. Per the "don't add what wasn't asked for" rule, skip automated tests for this file; instead, smoke-test it manually from the browser console once Task 6 wires it in (Task 6, Step 4) — this is consistent with v1's own testing approach (manual browser checks for anything that needs a real browser API).

- [ ] **Step 3: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/rag/store.ts
git commit -m "feat(rag): add an IndexedDB-backed store for chunks and message bookkeeping"
```

---

## Task 6: The indexer — orchestration, debounce, incremental diff, stale-tail cleanup, debug dump

**Files:**
- Create: `src/rag/indexer.ts`

**Interfaces:**
- Consumes: `claudeAdapter` (Task 2), `chunkMessage`/`CHUNKER_VERSION` (Task 4), `hashText` (Task 1), all of `store.ts` (Task 5), `getSettings` from `src/options/storage.ts` (existing, unchanged).
- Produces: `initIndexer(): () => void` — consumed by `content/index.ts` in Task 7.

- [ ] **Step 1: Write `src/rag/indexer.ts`**

```ts
import { claudeAdapter, getTranscriptFeed } from '@/sites/claude';
import { getSettings } from '@/options/storage';
import { chunkMessage, CHUNKER_VERSION } from './chunker';
import { hashText } from './hash';
import {
  deleteMessage,
  getAllChunks,
  getAllMessageRecords,
  getMessageRecord,
  replaceMessage,
} from './store';
import type { MessageRecord } from './types';

const DEBOUNCE_MS = 800;
const NAVIGATION_POLL_MS = 1000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIndexPass(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runIndexPass(), DEBOUNCE_MS);
}

async function runIndexPass(): Promise<void> {
  const conversationId = claudeAdapter.getConversationId();
  if (!conversationId) return;

  for (const message of claudeAdapter.getAllMessages()) {
    if (claudeAdapter.isStreaming(message.element)) continue; // revisited once it flips to false

    const flatText = claudeAdapter.getMessageText(message.element);
    const textHash = await hashText(flatText);
    const key = `${conversationId}:${message.id}`;
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
  if ((await getSettings()).debugEnabled) await dumpChunks(conversationId);
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

  return () => {
    feedObserver.disconnect();
    clearInterval(navigationPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run compile`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/rag/indexer.ts
git commit -m "feat(rag): add the indexer — debounced, incremental, skips mid-stream, cleans up stale tails"
```

---

## Task 7: Wire into the content script, and manually verify on live claude.ai

**Files:**
- Modify: `src/content/index.ts`

**Interfaces:**
- Consumes: `initIndexer` from `src/rag/indexer.ts` (Task 6).

- [ ] **Step 1: Call `initIndexer()` from `initHighlightExplainer`**

```ts
import { initIndexer } from '@/rag/indexer';

export async function initHighlightExplainer(ctx: ContentScriptContext): Promise<void> {
  const stopIndexer = initIndexer();
  ctx.onInvalidated(stopIndexer);

  const button = await createExplainButton(ctx, () => void handleExplainClick());
  // ...rest unchanged...
}
```

If `ContentScriptContext` doesn't have `onInvalidated` in the installed WXT version (verify against `node_modules/wxt`'s types, don't assume), fall back to just calling `initIndexer()` without wiring its cleanup to anything — the observer/poll are harmless to leave running for the lifetime of the tab, and correctness doesn't depend on the cleanup path in v2.

- [ ] **Step 2: Typecheck and build**

Run: `npm run compile && npm run build`
Expected: no errors.

- [ ] **Step 3: Manual test on live claude.ai**

1. Load the unpacked extension (`.output/chrome-mv3`) in Chrome dev mode.
2. Turn on the debug toggle on the options page.
3. Open a claude.ai chat with at least one long answer. Wait ~1 second after it finishes rendering, then check the DevTools console for the `console.table` dump.
4. Open DevTools → Application → IndexedDB → `highlight-explainer` and confirm the `messages` and `chunks` stores have sensible rows for that conversation.
5. Ask a follow-up that produces a new answer; confirm a new row appears without the old ones being rewritten (check `lastIndexedAt` on the untouched messages stays the same).
6. Edit an earlier message and let it regenerate; confirm the edited message's old chunks are gone (not just added-to) and any messages that existed only in the old branch are cleaned up — run `window.__glossDumpChunks()` before and after to compare.
7. Highlight text and click "Explain" as in v1 — confirm the popup still streams a correct explanation, unchanged from v1 behavior.
8. Confirm no visible slowdown while a long answer streams in (the button/selection should stay responsive throughout).

- [ ] **Step 4: Commit**

```bash
git add src/content/index.ts
git commit -m "feat: start the v2 indexer alongside the v1 explain flow"
```

---

## Self-Review

**Spec coverage:** chunking rules (message boundary, heading/paragraph grouping, ~100-180 words, code never split) → Task 4. Metadata incl. hash → Task 1 (`Chunk`/`MessageRecord`) + Task 4 (`textHash` computed via `hashText`). IndexedDB schema + per-conversation keying → Task 5. Incremental indexing incl. edits/regen → Task 6 (`runIndexPass`, hash + `chunkerVersion` comparison). Trigger + streaming safety → Task 6 (`initIndexer`, debounce, `isStreaming` skip, per-message yield). Chunk inspection → Task 6 (`dumpChunks`, `__glossDumpChunks`) + Task 7 Step 3 (DevTools IndexedDB view). Fixtures with code + long answer → Task 3. The four locked-in decisions → called out explicitly above and threaded through Tasks 2, 4, 6. Unit tests → Task 4.

**Placeholder scan:** none found — every step has real, complete code or a concrete manual-check procedure.

**Type consistency:** `Block`/`Chunk`/`MessageRecord` (Task 1) are the only shapes used by name across Tasks 2, 4, 5, 6 — checked they match at each use site (`getMessageBlocks` returns `Block[]`; `chunkMessage` takes `Block[]` and returns `Promise<Chunk[]>`; `store.ts` takes exactly the `Chunk`/`MessageRecord` fields Task 1 defines; `indexer.ts` builds a `MessageRecord` object literal with exactly those fields).
