# v8: ChatGPT Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlighting text on chatgpt.com gives a correct explanation, with chunking, indexing and retrieval working on its chats, and claude.ai behaving exactly as it does today.

**Architecture:** Add a second `SiteAdapter` (`src/sites/chatgpt.ts`) and a small registry that picks the adapter from `location.hostname`. Everything downstream (chunker, store, embedder, BM25, fusion, prompt assembly, popup) is not touched: the ChatGPT adapter must hand them the same shapes Claude's does (numeric-string positions as ids, typed `Block`s). The few places where Claude leaked out of `src/sites/` are fixed first, as a no-behaviour-change step.

**Tech Stack:** TypeScript (strict), WXT, vitest. No new runtime dependency. One possible new *dev* dependency (`linkedom`) is a decision for the user — see "Decisions needed".

**Spec:** `CLAUDE.md` → "v8: ChatGPT support". Fixtures: `fixtures/chatgpt-message.html`, `chatgpt-user-message.html`, `chatgpt-conversation.html`, `chatgpt-code-message.html`.

## Global Constraints

- Zero cost, personal use, no backend, no telemetry; the API key never in code.
- Only read the page's visible DOM. Never call ChatGPT's private APIs or send messages through its session.
- All ChatGPT selectors live in `src/sites/` and nowhere else. Selectors come from the captured fixtures, never from guesses or memory.
- claude.ai must keep working exactly as it does now. No change to the popup, prompt assembly, chunker, store, embedder, retrieval or `CHUNKER_VERSION`.
- Never commit real chat content. The four ChatGPT fixtures are untracked; they were scanned for emails, names and token-shaped strings (none found; 4 `<img>` tags carry long signed `images.openai.com` URLs). The chat in them is a harmless "palindrome / natural number" chat. Review them once more before `git add`.
- Build only v8. Do not start v9.

## Review Focus

Failure modes the spec implies but no obvious test exercises, most likely first:

1. **Math read three times.** KaTeX renders every formula as MathML text + a TeX annotation + a visual copy. Plain `textContent` gives `1,2,3,4,… 1,2,3,4,\ldots 1,2,3,4,…`. Expected: the formula appears once, as `$1,2,3,4,\ldots$`.
2. **Code silently dropped.** ChatGPT code is not always a `<pre>` (CodeMirror `.cm-line` divs, `<pre>`, or a bare `<code>`). Claude's block selector captured 0 of 2 code blocks in answer 0. Expected: every code block becomes one `code` block, newlines intact, language label excluded.
3. **Tables shredded.** Each table cell is a `<p>`; Claude's logic would emit one-word "paragraphs" with no row structure. Expected: one `list-item` block per row (`a | b | c`).
4. **A well-formed prompt with the wrong neighbours.** If ChatGPT's turn numbering is relative to the mounted window, positions would be wrong after scrolling and old chunks would be overwritten by different messages. Expected: ids are absolute or the adapter refuses to index (see the Phase 0 gate).
5. **Regenerated/edited answers.** ChatGPT gives a regenerated answer a *new* UUID. If we keyed by UUID the old answer's chunks would stay in the index forever and could be retrieved. Expected: keyed by position, so the new answer overwrites the old one (same as Claude).

---

## What I found (answers to the seven questions)

### 1. What `SiteAdapter` requires, and what is Claude-specific

The 13 methods ask the right *questions* (find messages, role, blocks, streaming, conversation id, neighbours). That part is general. What is Claude-specific is not the questions but what leaked around them:

| Leak | Where | Fix in v8 |
|---|---|---|
| `claudeAdapter` imported directly | `content/index.ts:10,61`, `content/promptDebug.ts:7,55,57,82`, `content/readFocal.ts:4`, `rag/coverage.ts:5`, `rag/indexer.ts:1` and ~15 call sites in it | One `getAdapter()` in `src/sites/index.ts` |
| `getTranscriptFeed()` is a Claude-only export, not on the interface | `sites/claude.ts:251`, used at `rag/indexer.ts:429` | Add `getTranscriptRoot()` to the interface |
| Claude's attribute names hard-coded in the indexer's MutationObserver | `rag/indexer.ts:434` (`data-perf-row-streaming`, `data-last-message`) | Add `observedAttributes` to the interface |
| **"A message id is a number, as a string"** | `rag/chunker.ts:93,103` (`Number(messageId)` → chunk `order`), `rag/indexer.ts:123` (`position`), `context/render.ts:45-46` (before/after labels), `rag/types.ts:16,28` | Make it an explicit, checked contract (below) |
| `claude.ai` in user-facing strings | `rag/store.ts:54`, options label, `context/report.ts:88` ("the last message isn't currently rendered") | Store/options: reword. `report.ts`: leave (see Known limitations) |

The big one is the numeric id. It is the right design for Claude (`data-index`), and `types.ts` even says so in a comment, but the type is just `string`, so nothing stops an adapter returning a UUID. `Number('3af60251-…')` is `NaN`, and `NaN * 1000` would silently scramble chat order and label every excerpt `message_number="3af60251-…"`. **That is exactly the "well-formed but wrong" bug class from CLAUDE.md.** So the contract gets written down and enforced (Task 2).

### 2. How ChatGPT's DOM answers each adapter question

Everything below was read from the fixtures, not guessed. Earlier guesses returning 0 are expected: `[data-testid^="conversation-turn"]`, `article`, `[data-message-author-role]`, `[data-message-id]` and `[data-turn]` all match **nothing** in the captured page. This ChatGPT build uses different attributes.

| Question | ChatGPT answer (verified in fixtures) |
|---|---|
| Message container | A **turn**: `[data-turn-key="<uuid>"]`. Inside: one user unit and one assistant unit (`data-chatgpt-search-unit-key="fallback-turn-N:0:user"` / `":1:assistant"`). 3 turns = 6 messages in the fixture. |
| User vs assistant | User: `[data-user-message-bubble="true"]`. Assistant: `[data-dil-message-id]` (the answer body; the same uuid also sits in `data-chatgpt-selection-message-id`). Not the sr-only `<h4>` ("You said:") — that is translated text. |
| User text | A single `div.whitespace-pre-wrap` holding plain text, **no `<p>`**. Claude's block selector would find zero blocks; we need the raw text with its line breaks. |
| Assistant blocks | Flat list of components, tagged `data-d-component`: `text` (`<p>`), `title` (`<h2>/<h3>`), `list` (`<ul>/<ol>`, items are `li > div > p`), `table`, `math`, `box`, plus untagged code blocks. |
| Code | `[data-code-block="true"]`, in **four shapes**: CodeMirror (`.cm-content > .cm-line`), `<pre>`, a bare `<code>` inside `[data-code-block-source]`, and the header (`[data-markdown-copy="exclude"]`: language label + buttons) which must be skipped. |
| Math | KaTeX. `.katex` has `annotation[encoding="application/x-tex"]` (9 of 9 have it) and an `aria-hidden` visual copy. Display math is its own block (`div[data-d-component="math"]`). **First time formulas have been seen on a real page.** |
| Tables | `div[data-d-component="table"] > table > tr > th/td > p`. |
| Streaming | `data-talvt-turn-state` on the turn. Only `"complete"` appears in the fixtures; the in-progress value has **never been observed**. (`data-d-stream-word` spans exist only in the single-message fixture, not after a reload, so they are not a signal.) |
| Conversation id | The conversation uuid is in the DOM (`data-chatgpt-selection-conversation-id`), and ChatGPT URLs are `/c/<uuid>`. The URL form is **from my general knowledge, not the fixtures** — to be confirmed live. |
| Own selection feature | ChatGPT has its own text-selection overlay (`data-selected-text-overlay-target`). It may sit on top of our Explain button. Unverified. |

### 3. Message identity

ChatGPT *does* give stable per-message ids: the turn has `data-turn-key`, the user message id equals it, and an assistant message has a uuid in three attributes. **We should not use them as our ids.**

- Our whole pipeline wants a **position** (chunk ordering, "message 12 is before the highlight", coverage, replacing a message in place).
- A UUID is identity, not position. Worse, ChatGPT gives a regenerated answer a new UUID, so UUID keys would leave the discarded answer's chunks in the index (Review Focus #5).
- So: **our id stays a positional number-as-string, and the UUIDs are only used to tell messages apart if needed.** Chunk id format (`conv:position:chunkIndex`), `MessageRecord`, and `CHUNKER_VERSION` are **unchanged**. IndexedDB is per-origin, so chatgpt.com and claude.ai data never mix.

The open question is where ChatGPT exposes an *absolute* position. The best candidate is the `fallback-turn-N` text in `data-content-search-turn-key` / `data-chatgpt-search-unit-key`. If `N` is the turn's index in the whole conversation, then position = `N*2` (user) or `N*2+1` (assistant). If `N` just counts the mounted turns from 0, it is useless. **The fixture cannot tell these apart** (all 3 turns are mounted). Phase 0 below settles it.

### 4. Virtualization

**Yes, almost certainly, but with a different shape from Claude's.** Evidence in the fixture: the turn list sits in a box with an explicit total height (`height: 6272px`), each turn is wrapped in a div with an explicit `height` and `margin-top`, and 2117 + 3092 + 1039 + 2×12 = 6272 exactly. That is a windowed list that knows every turn's height. The list's own `margin-top: 0px` is probably the offset of the first mounted turn.

What I **cannot** tell from three turns: whether the mounted turns are one contiguous window (my guess, because a windowed list usually renders one range) or disconnected islands like Claude's (rows 29–36, 217, 403–405). I also don't know whether an off-screen turn is *absent* or an *empty wrapper*.

**Consequences:**
- Same limit as Claude: only turns that have been mounted get indexed; the coverage message is still true.
- The v5 contiguity rule must **still apply**, but ChatGPT has no `data-index`, so the check runs on the positions from Q3. `contiguousPrecedingRun` (pure, in `sites/contiguity.ts`) already works on plain numbers, so it is reused unchanged.
- ChatGPT has no `data-last-message`, so `getLastMessagePosition()` returns `null` in v8: coverage shows "N messages indexed" with no total, and the stale-tail cleanup after an edit never runs. Documented limitation (see below).
- The question that produced an answer is easier here than on Claude: it is the user unit of the **same turn**, no walking needed.

### 5. Choosing the adapter, and the manifest

- Add `src/sites/index.ts` with `getAdapter()`; it reads `location.hostname` (`claude.ai` → Claude, `chatgpt.com` → ChatGPT, anything else → `null` and the content script does nothing).
- `src/entrypoints/content.ts`: `matches: ['https://claude.ai/*', 'https://chatgpt.com/*']`. One content script, not two, so the bundle is not duplicated.
- `wxt.config.ts` `host_permissions` is for extension-initiated fetches (Hugging Face). A content script only needs `matches`. I believe `chatgpt.com` does not need adding there; confirm in the live test. (`chat.openai.com` redirects to `chatgpt.com`; not matched.)
- Shadow DOM isolates the popup from ChatGPT's CSS the same way as on Claude. Risks that are unverified: ChatGPT's CSP (should not affect a content script), and its own selection overlay.

### 6. What else has to change

Honest answer: **almost nothing downstream, as long as the ChatGPT adapter produces the right shapes.**

- Chunker, store, embedder, BM25, fusion, assembly, popup: **no change.** `Block` types (`heading | paragraph | list-item | blockquote | code`) are enough: tables become `list-item` rows, display math a `paragraph` (a single block is never split by the chunker), code stays `code`.
- Changes outside `src/sites/` are only the mechanical ones from Q1, plus an id guard in the indexer.
- Not changed, and now slightly inaccurate for ChatGPT: the console text "the last message isn't currently rendered" (`context/report.ts:88`). It is accurate for Claude. For ChatGPT the true cause is "ChatGPT doesn't expose the total". I will leave it because `report.ts` is prompt-side code you said not to touch; I'll note it as a known wart.

### 7. Tests

Same pattern as v3–v5: pure logic in vitest; DOM/selector logic checked against real fixtures; the rest verified live.

- **vitest, pure:** adapter registry (hostname → site), the id guard, ChatGPT key parsing/position, table-rows-to-blocks, TeX substitution.
- **Fixture tests (need a DOM):** block extraction on the four fixtures (counts, code text, math appears once, tables as rows, no label text). **This needs `linkedom`** — see Decisions needed. I used it already in a throwaway script to survey the fixtures; it is installed only as a transitive dependency of `wxt`, so relying on it without declaring it would be fragile.
- **Claude regression:** before touching `claude.ts`, pin its current block output on the existing Claude fixtures (golden test), then confirm it is unchanged afterwards. Needs the same DOM.
- **Live (you):** checklist in Task 6.

## Honest verdict on the abstraction

**It mostly holds, and it needs three small changes, not a redesign.** The method list was the right set of questions; ChatGPT answers all of them. What was wrong was around the interface: (a) nothing chose an adapter, (b) one Claude-only function and some Claude attribute names were reached around the interface, and (c) the biggest hidden assumption, "id = numeric position", was never part of the contract. Those are the useful findings of this version. There is also one genuine new thing the interface did not anticipate: sites with **no absolute index in the DOM** (that is the Phase 0 question). If ChatGPT turns out to have none, the interface needs a different idea of "position", and I will stop and come back to you instead of improvising.

## Things that will cause problems (flagged)

1. **The DOM looks brand new and obfuscated** (`DilRenderer-tB76Jj`, `fallback-turn-…`). I use only `data-*` attributes, never the hashed class names, but the `data-*` names could change or be A/B-tested per account. Three sites means three things that can break independently (already in CLAUDE.md). Capture fixtures from a second chat/account state before trusting it.
2. **CodeMirror renders only the lines near its viewport.** A 400-line block may be partly absent from the DOM, so a code chunk could be truncated and change as you scroll inside it. Not observable in the 13-line fixture. Live check.
3. **Streaming state is a guess** (`!== 'complete'`). Safety nets exist: the indexer force-indexes a message stuck "streaming" for 60 s, and a half-written message is re-indexed when its hash changes.
4. **Only chats with one user + one assistant message per turn are understood.** Tool use, "thinking", search or agent turns may add units. v8 reports such turns (debug) and does not index them rather than guess an index.
5. **Attachments** and images in user messages have no fixture; assume invisible, as on Claude.
6. **ChatGPT's own selection overlay** may fight our Explain button.
7. **`getLastMessagePosition() === null`:** after editing an early message on ChatGPT, chunks of the discarded branch beyond the new end stay in the index until overwritten, and can be retrieved. Accepted limitation unless you want the geometry workaround (Decisions needed).

## Decisions needed from you

1. **Add `linkedom` as a devDependency?** (CLAUDE.md: ask before adding a dependency.) Recommended **yes**: it lets us check in fixture tests for ChatGPT *and* a golden test pinning Claude's behaviour. The alternative is the interactive-Playwright-only approach CLAUDE.md describes, which cannot protect claude.ai from regressions.
2. **Stale tail on ChatGPT:** accept the limitation (recommended, and document it), or add a geometry check ("last mounted turn's bottom == box height" means it is the last turn).
3. **Run the Phase 0 probe** (below). Tasks 3–5 are blocked on its result.

---

## File Structure

- Create `src/sites/index.ts`: `getAdapter()`; chooses by hostname. Pure helper `siteForHostname()` lives in `src/sites/registry.ts` so it is unit-testable without a DOM.
- Create `src/sites/registry.ts` + `registry.test.ts`.
- Create `src/rag/positionId.ts` + `positionId.test.ts`: the id contract (`positionFromId`).
- Create `src/sites/chatgpt.ts`: the adapter (selectors only here).
- Create `src/sites/chatgptKeys.ts` + test: pure parsing of `fallback-turn-N:u:role` keys (Branch A).
- Create `src/sites/chatgptBlocks.ts` + test: DOM → `Block[]`.
- Modify `src/sites/types.ts`: add `getTranscriptRoot()`, `observedAttributes`; document the id contract.
- Modify `src/sites/claude.ts`: implement the two new members; remove the standalone `getTranscriptFeed` export. Nothing else.
- Modify `src/rag/indexer.ts`, `src/rag/coverage.ts`, `src/content/readFocal.ts`, `src/content/promptDebug.ts`, `src/content/index.ts`: use `getAdapter()`.
- Modify `src/entrypoints/content.ts`: add the chatgpt.com match.
- Modify `src/rag/store.ts:54` and the options label: neutral wording.

---

## Phase 0 — live probe (you, ~10 minutes, no code, no commit)

Open your **longest** ChatGPT chat in Brave/Chrome, open DevTools console on that tab, paste this. It only prints ids and sizes, never message text.

```js
(() => {
  const turns = [...document.querySelectorAll('[data-turn-key]')];
  const list = turns[0]?.parentElement?.parentElement;
  const box = list?.parentElement;
  console.log('mounted turns:', turns.length, '| list margin-top:', list?.style.marginTop, '| box height:', box?.style.height,
    '| url path:', location.pathname,
    '| conv id in DOM:', document.querySelector('[data-chatgpt-selection-conversation-id]')?.dataset.chatgptSelectionConversationId);
  console.table(turns.map(t => ({
    searchKey: t.querySelector('[data-content-search-turn-key]')?.dataset.contentSearchTurnKey,
    units: [...t.querySelectorAll('[data-chatgpt-search-unit-key]')].map(u => u.dataset.chatgptSearchUnitKey.split(':').slice(1).join(':')).join(' '),
    state: t.querySelector('[data-talvt-turn-state]')?.dataset.talvtTurnState,
    wrapH: t.parentElement.style.height,
    wrapMT: t.parentElement.style.marginTop,
    hasContent: !!t.querySelector('[data-user-message-bubble],[data-dil-message-id]'),
  })));
})();
```

Run it (a) at the bottom of the chat, (b) after scrolling to the middle, (c) at the top, (d) once **while an answer is streaming**, (e) in a chat that used web search/thinking/tools. Paste the printed tables back to me. Reading them:

- **Absolute?** At the bottom of a 40-turn chat, do `searchKey`s read `fallback-turn-37…39` (absolute, Branch A) or `fallback-turn-0…2` (relative, Branch B)?
- **Contiguous?** Are the `searchKey`s of mounted turns consecutive, or islands?
- **Empty wrappers?** Any row with `hasContent: false`?
- **Units** always `0:user 1:assistant`? What does `state` say mid-stream?
- **URL path** matches `/c/<id>` and the id equals the DOM one?

**Gate:** Branch A (absolute keys) → continue with Tasks 3–5 as written. Branch B (relative keys) → stop, re-plan with you; do not improvise a position scheme.

---

## Task 1: Adapter registry and Claude-leak fixes (no behaviour change)

**Files:**
- Create: `src/sites/registry.ts`, `src/sites/registry.test.ts`, `src/sites/index.ts`
- Modify: `src/sites/types.ts`, `src/sites/claude.ts`, `src/rag/indexer.ts`, `src/rag/coverage.ts`, `src/content/readFocal.ts`, `src/content/promptDebug.ts`, `src/content/index.ts`

**Interfaces:**
- Produces: `siteForHostname(hostname: string): 'claude' | 'chatgpt' | null`; `getAdapter(): SiteAdapter | null`; on `SiteAdapter`: `getTranscriptRoot(): HTMLElement | null` and `readonly observedAttributes: string[]`.

- [ ] **Step 1: Write the failing test** — `src/sites/registry.test.ts`

```ts
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
    expect(siteForHostname('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/sites/registry.test.ts` → "Cannot find module './registry'".
- [ ] **Step 3: Implement** — `src/sites/registry.ts`

```ts
export type SiteId = 'claude' | 'chatgpt';

const HOSTS: Record<string, SiteId> = {
  'claude.ai': 'claude',
  'chatgpt.com': 'chatgpt',
};

/** Exact-match only: a look-alike host must never select an adapter. */
export function siteForHostname(hostname: string): SiteId | null {
  return HOSTS[hostname] ?? null;
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Pin Claude before touching it.** With the DOM decision made (linkedom accepted): add `src/sites/claude.golden.test.ts` that loads `fixtures/claude-code-message.html`, `claude-message.html`, `long-chat-with-code.html` and snapshots `getMessageBlocks` / `getMessageContent` per row. Run it on the **unmodified** `claude.ts` and commit the snapshots first. (If linkedom is declined: skip this step and compare by hand in Playwright; say so in the final report.)
- [ ] **Step 6: Extend the interface** in `src/sites/types.ts`:

```ts
  /** The element that contains the whole message list: the right thing to watch for new/removed messages. */
  getTranscriptRoot(): HTMLElement | null;

  /** Attribute names whose change should trigger an index pass (e.g. a streaming flag). */
  readonly observedAttributes: string[];
```

and replace the comment on `SiteMessage.id` with: `/** The message's position in the chat, as a decimal integer string ("0", "1", …). NOT a site uuid: chunk ordering, before/after labels and coverage all do Number(id). Enforced by positionFromId. */`
- [ ] **Step 7: Implement in `claude.ts`** (two members, existing logic moved, nothing else):

```ts
  getTranscriptRoot: () => document.querySelector<HTMLElement>(FEED_SELECTOR),
  observedAttributes: ['data-perf-row-streaming', 'data-last-message'],
```

delete the `getTranscriptFeed` export.
- [ ] **Step 8: `src/sites/index.ts`**

```ts
import { claudeAdapter } from './claude';
import { siteForHostname } from './registry';
import type { SiteAdapter } from './types';

/** The adapter for the page we are on, or null on an unsupported site. */
export function getAdapter(): SiteAdapter | null {
  const site = siteForHostname(location.hostname);
  return site === 'claude' ? claudeAdapter : null; // 'chatgpt' is added in Task 5
}
```

- [ ] **Step 9: Replace every `claudeAdapter` import outside `src/sites/`** with `getAdapter()`; in `indexer.ts` use `adapter.getTranscriptRoot()` and `attributeFilter: adapter.observedAttributes`; bail out of `initIndexer()` / the click flow when `getAdapter()` is null.
- [ ] **Step 10:** `npm run compile && npm test` → all 188+ tests pass and the golden test is unchanged. `npm run build`.
- [ ] **Step 11: Commit** — `refactor(sites): choose the adapter by hostname, move Claude-only reach-arounds behind SiteAdapter (no behaviour change)`.

---

## Task 2: Enforce "id is a position"

**Files:** Create `src/rag/positionId.ts`, `src/rag/positionId.test.ts`; Modify `src/rag/indexer.ts` (the loop at ~line 87).

**Interfaces:** Produces `positionFromId(id: string): number | null` (non-negative integer, decimal digits only; else `null`).

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { positionFromId } from './positionId';

describe('positionFromId', () => {
  it('accepts plain non-negative integers', () => {
    expect(positionFromId('0')).toBe(0);
    expect(positionFromId('217')).toBe(217);
  });
  it('rejects ids that Number() would silently mangle', () => {
    for (const bad of ['', ' ', '3af60251-1934-47c0', '1e3', '-1', '1.5', '0x10', 'NaN', '12 ']) {
      expect(positionFromId(bad)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run, FAIL. Step 3: Implement**

```ts
/** The id contract: a message id is its position as a decimal integer string. Anything else
 * (a uuid, "1e3", "") would make Number(id) NaN or wrong and scramble chat order silently. */
export function positionFromId(id: string): number | null {
  return /^\d{1,9}$/.test(id) ? Number(id) : null;
}
```

- [ ] **Step 4: PASS. Step 5:** in `runIndexPass`, before chunking: `if (positionFromId(message.id) === null) { console.warn('[highlight-explainer] skipping message with a non-positional id:', message.id); continue; }` and use the parsed value for `position`. **Claude ids are all valid, so there is no behaviour change on claude.ai.**
- [ ] **Step 6:** compile + tests. **Step 7: Commit** — `feat(rag): refuse to index a message whose id is not a position`.

---

## Task 3 (gated on Phase 0, Branch A): ChatGPT identity helpers

**Files:** Create `src/sites/chatgptKeys.ts`, `src/sites/chatgptKeys.test.ts`.

**Interfaces:** Produces `parseUnitKey(key: string): { turn: number; ordinal: number; role: 'user' | 'assistant' } | null` and `positionOf(turn: number, role): number` (`turn * 2 + (role === 'assistant' ? 1 : 0)`).

Test cases to write first (all from the real fixture values): `parseUnitKey('fallback-turn-0:0:user')` → `{0,0,'user'}`; `'fallback-turn-12:1:assistant'` → `{12,1,'assistant'}`; `'fallback-turn-x:0:user'`, `''`, `'fallback-turn-1:2:tool'` → `null`; `positionOf(0,'user')=0`, `positionOf(0,'assistant')=1`, `positionOf(12,'assistant')=25`; and `contiguousPrecedingRun` (existing) over `[25, 24, 23]` → `{length:2, endsAtGap:true}`, `[1,0]` → `{length:1, endsAtGap:false}`.

Steps: write tests → run (FAIL) → implement the two functions with exactly the semantics above → run (PASS) → commit `feat(sites): parse ChatGPT unit keys into positions`. If Phase 0 shows the formula must differ (e.g. extra units per turn), this task changes; do not start it before the probe result.

## Task 4 (gated on Branch A): ChatGPT block extraction

**Files:** Create `src/sites/chatgptBlocks.ts`, `src/sites/chatgptBlocks.test.ts`.

**Interfaces:** Produces `getAssistantBlocks(root: HTMLElement): Block[]`, `getUserBlocks(bubble: HTMLElement): Block[]`.

Behaviour (each a test against the real fixtures; the DOM comes from linkedom):
1. Walk `root` children in order; per element: `p` → paragraph; `h1–h6` → heading; `ul/ol` → one `list-item` per `li`, using the `li`'s own text without descendant lists (nested `li` become separate blocks); `[data-d-component="table"]` → one `list-item` per row, cells joined with ` | `, header row first; `[data-d-component="math"]` → one `paragraph` `$$tex$$`; `[data-code-block]` → one `code` block; `box`/other containers → recurse.
2. **Text rule:** before reading any element's text, replace each `.katex` with `$<annotation x-tex>$` (clone first, never mutate the page), then collapse whitespace.
3. **Code rule:** text is, in order of preference, the `.cm-line` elements joined by `\n`; else `<pre>` text; else `[data-code-block-source] code`; skip anything under `[data-markdown-copy="exclude"]`. Strip a leading/trailing blank line and `\r`.
4. **User rule:** the `.whitespace-pre-wrap` text, `\r` removed, trimmed, split on blank lines into paragraphs, single newlines kept.

Expected from the fixtures (assert exact numbers once the code runs, then freeze them): answer 0 yields 2 `code` blocks (13-line Python; `Palindrome`); answer 1 yields 4; the "natural numbers" answer contains the string `1,2,3,4,\ldots` exactly once per formula; no block contains `Python`/`Run` button text; the `Number | Reversed | Palindrome?` header becomes a single `list-item`.

Steps: write the failing tests (fixture loaded with `readFileSync` + linkedom) → implement → pass → commit `feat(sites): extract blocks from ChatGPT messages`.

## Task 5 (gated on Branch A): the ChatGPT adapter, manifest, build

**Files:** Create `src/sites/chatgpt.ts`; Modify `src/sites/index.ts`, `src/entrypoints/content.ts`.

Implement all `SiteAdapter` members. Selectors (all from the fixtures):

| Member | Rule |
|---|---|
| `getAllMessages` | for each `[data-turn-key]` turn, unit elements `[data-user-message-bubble]` and `[data-dil-message-id]`; `id = String(positionOf(turn, role))` from the turn's `[data-content-search-turn-key]`; a turn whose units are not exactly user then assistant is reported by `getUnrecognizedRowIds()` and not returned |
| `getMessageForNode` | `node.closest('[data-user-message-bubble]')` or `closest('[data-dil-message-id]')`; anything else (action bar, sr-only heading) → `null` |
| `getUserQuestionFor(id)` | the `[data-user-message-bubble]` in the **same turn**; `'none'` if absent |
| `getRecentMessages` | previous turns' units, checked with `contiguousPrecedingRun` over positions, never DOM adjacency |
| `isStreaming` | `closest('[data-talvt-turn-state]')?.dataset.talvtTurnState !== 'complete'` |
| `getConversationId` | `location.pathname.match(/\/c\/([^/]+)/)?.[1] ?? null` |
| `getLastMessagePosition` | `null` (documented) |
| `getTranscriptRoot` | `[data-thread-find-target="conversation"]` |
| `observedAttributes` | `['data-talvt-turn-state']` |

`content.ts` `matches: ['https://claude.ai/*', 'https://chatgpt.com/*']`; `getAdapter()` returns `chatgptAdapter` for `'chatgpt'`. Build, load unpacked, **reload the chatgpt.com tab** (stale content script trap). Commit `feat(sites): ChatGPT adapter (v8)`.

## Task 6: Live verification (you) and docs

On chatgpt.com, on a short chat then your long one:

1. Indexing: `__glossDumpChunks()` shows sensible chunks; code is whole; formulas appear once; tables are rows.
2. `__glossPrompt()` on a highlight in the middle of the chat: read the **message numbers** in the report. Question = the user message of the same turn; recent messages are the ones right before it.
3. Scroll so the mounted turns change, highlight again: numbers still absolute and correct (this is Review Focus #4).
4. Explain on a highlight inside a code block, a table cell, a formula, and a user message.
5. While an answer streams: page does not lag; the streaming message is not indexed until it finishes.
6. Edit an early user message / regenerate an answer: the new text replaces the old at that position; old text is not retrievable (`__glossSearch`).
7. ChatGPT's own selection popover and our Explain button do not block each other.
8. **claude.ai regression:** reload a claude.ai tab; Explain, `__glossSearch`, `__glossHybrid`, `__glossPrompt` behave as in v5.

Then update CLAUDE.md "Current status" only after you say v8 is done.
