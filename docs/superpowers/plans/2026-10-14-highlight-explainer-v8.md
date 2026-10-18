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

### Phase 0, round 1 result (2026-10-16): gate NOT passed, Tasks 3–5 stay blocked

What the five tables show:

- **Verified:** streaming state is `in_progress` (else `complete`). A turn can have only a user unit (`fallback-turn-9`, complete). The assistant unit ordinal is 1 or 2, so the key's ordinal is not always 1. No empty placeholder wrappers were seen (`hasContent` always true). The mounted window is small (3–5 turns) and the chat is ~24 turns tall (box 163398px; one turn alone was 41464px). The DOM conversation id matched the URL path in every run.
- **Fits "absolute":** the runs with only `fallback-turn-N` keys read 0–2 (top), 9–13 (middle), 22–23 (end).
- **New complication:** some turns carry a UUID instead of `fallback-turn-N` in `data-content-search-turn-key`. So that attribute gives a position for only some turns.
- **Unexplained contradiction (the reason the gate is closed):** the same three UUID turns (78f672c1, 59f288c1, 21e099e3) sit *directly after* `fallback-turn-0, fallback-turn-1` in the first table, but directly *before* `fallback-turn-22` in the streaming and search tables. If numbers were absolute and DOM neighbours were chat neighbours, those turns would be 2–4 in one run and 19–21 in the other. At least one premise is false: (a) mounted turns can be non-adjacent in the chat while adjacent in the DOM, (b) `fallback-turn-N` is not an absolute index, or (c) the chat changed between runs.
- **Why it matters:** the only way to position a UUID turn is "nearest `fallback-turn-N` in the same window, plus DOM order". That is only correct if the window is contiguous. If (a) is true it would silently produce wrong positions with a well-formed prompt, the failure mode in CLAUDE.md. Not built on a guess.

Candidate position schemes, in order of preference, once round 2 settles the contradiction:

- **P1, anchor + DOM order:** position of a UUID turn = nearest `fallback-turn-N` anchor in the window, offset by DOM distance. Needs a contiguous window and an anchor in every window. A window with no anchor is reported and not indexed.
- **P2, P1 plus a remembered map:** store `data-turn-key` → position in IndexedDB once learned, so an all-UUID window can still be positioned. Needs a new object store (schema bump). Only if round 2 shows all-UUID windows are common.
- **P3, stop and re-plan:** if round 2 shows (a) or (b).

Round 2 is a recorder that logs only ids, never text; see the chat message that accompanied this commit.

### Phase 0, round 2 result (2026-10-16): `fallback-turn-N` is NOT a chat position (option (b)); the window IS contiguous

Recorder output: 7 turns seen, 1 chain, 0 adjacency conflicts, 2 label conflicts. The same turn (by `data-turn-key`, stable) was labelled `fallback-turn-0` at one moment and `fallback-turn-5` at another, so the label follows render order within the moving window. This also explains round 1's contradiction: the labels, not the turns, moved. Heights of the same turn also differ between runs, so pixel offsets are not a stable key either.

- **Superseded:** Task 3 (`chatgptKeys`, "position from `fallback-turn-N`") and the position part of Task 5. Do not execute them.
- **Still valid:** Task 4 (block extraction) does not depend on ids. Task 1 and Task 2 are done and unaffected.
- **Facts now usable:** `data-turn-key` identifies a turn within a session; DOM adjacency inside the window is chat adjacency (one sweep over 7 turns, not yet the whole chat); there is no absolute index, no total, and no last-message marker in the DOM.
- **Next:** re-plan the position/identity scheme with the user (options and recommendation in the chat message of this date). No ChatGPT adapter code until that is decided.

### Decisions (2026-10-16): scheme B, session-scoped sequence

- **B, not C.** Keep integer positions; the ChatGPT adapter assigns them from a session-stable ordered sequence of `data-turn-key` UUIDs, built from DOM adjacency inside the contiguous window. Chunk id format, schema, chunker, `CHUNKER_VERSION`, prompt assembly: unchanged. The index lives for one page load (cleared on first entering a chat in a page session, with the existing `getAllMessageRecords` + `deleteMessage`). **Built so C (a persisted UUID→position map and successor links) can be added later without changing the sequence module's interface.** C is not wanted yet; the user will judge from use whether losing the index on reload matters.
- **Arbitrary message numbers are fine** (`message_number` is a label; before/after relations stay correct). Base a few thousand, two slots per turn (user, assistant).
- **No geometry.** No "is this the start of the chat" check from layout offsets; "not loaded" when we can't tell is the safe direction (same call as v5).
- **A detected ordering conflict must be VISIBLE in the popup, not only the debug report, the same way v5 surfaces a missing question.** A conflict is the recurring failure mode (mis-ordered prompt, no error). Design requirements:
  1. The sequence module records conflicts (a turn seen followed or preceded by two different turns) and exposes them; it never silently overwrites an edge.
  2. On a conflict the adapter fails safe, not just loud: it drops the sequence and the session index for that chat and restarts from the current window, returns no recent messages that cross the conflict, and excerpts from before the conflict cannot be retrieved.
  3. The popup's muted line says so in plain words (for example "this chat changed earlier on this page, so the index was rebuilt from what is on screen") for as long as the session has an unresolved conflict. This needs one string carried through `RawFocal` → `PromptReport` → `describeCoveragePopup`, a deliberate, small exception to "no changes to prompt assembly"; the prompt text itself is not changed. `__glossPrompt()` prints the same note.
  4. Tests: the conflict is detected, the chain is dropped, and the popup/report line is produced.
- **Unattached windows** (a scrollbar drag lands on turns that connect to nothing known) are held in memory and not indexed until they connect; the debug report names them.
- **Probes before building:** a full top-to-bottom sweep (expect 1 chain, 0 jumps, 0 conflicts) and a fast scrollbar drag (expect several chains, jumps > 0, 0 conflicts). Recorder: `__probe3`.

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

## Task 3 — SUPERSEDED by scheme B (see "Scheme B tasks" at the end): ChatGPT identity helpers

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

## Task 5 — SUPERSEDED by scheme B (see "Scheme B tasks" at the end): the ChatGPT adapter, manifest, build

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

---

## Scheme B tasks (2026-10-17) — these replace Tasks 3 and 5; Task 4 (block extraction) stands

Probe round 3 (full sweep + fast drag, with a recorder that sampled 1047 and 101 times) passed: over a real 27-turn chat, **1 chain, 0 jumps, 0 conflicts** on a slow sweep (window 5–7 turns, 109k–169k px unmounted), and **2 chains, 5 jumps, 0 conflicts** on a fast drag, the two chains correctly kept apart. Turn shapes: `0:user 1:assistant` (14), `0:user 2:assistant` (10), `0:user` alone (3). Only `complete` seen in the sweep; `in_progress` confirmed earlier.

### Design (what is built)

- **Identity** = `data-turn-key` (UUID). **Position** = a number the adapter assigns. User message id = `slot*2`, assistant = `slot*2 + 1`, where `slot` is the turn's place in a session-stable frame that starts at `BASE_SLOT = 5000`. Chunk ids, `MessageRecord`, schema, `CHUNKER_VERSION`, chunker: unchanged. A user-only turn simply has no odd position.
- **`TurnSequence` (pure, `src/sites/turnSequence.ts`)** needs no edge list. It holds `slotOf` and `turnAt`. `observe(window)` takes the mounted turn ids in DOM order:
  1. empty frame → the window becomes the base;
  2. no turn of the window known → the window is **detached**: it gets window-local slots from `LOCAL_BASE = 100000`, nothing is stored, nothing is indexed;
  3. otherwise take the first known turn as an anchor; every turn gets `anchorSlot + (index − anchorIndex)`. A known turn at a different slot, or a slot already held by a different turn, is a **conflict**. This also catches an edited message (the new turn wants the slot the old one holds);
  4. a conflict **resets** the frame (generation + 1, conflict count + 1) and the current window becomes the new base. The window just read is the freshest truth, so the new frame is consistent.
- **Generation gate** (`src/rag/generationGate.ts`, pure orchestrator): an adapter may return `getIndexGeneration()`; when it differs from the last one applied for that chat, the chat's stored index is wiped (existing `getAllMessageRecords` + `deleteMessage`) **before** anyone reads or writes it. On a fresh page load nothing has been applied, so the first visit wipes: the index is session-scoped. The indexer and `prepareExplainPrompt` both call it, and the indexer aborts a pass if the generation changes mid-pass, so a reset can never leave old-numbered rows mixed with new-numbered ones. Persisting `slotOf` (option C) later only needs to feed this gate a stable generation.
- **Streaming:** the window handed to the sequence is cut at the first turn whose state is `in_progress` (and everything after it), so a turn whose key might change when it finishes is never placed. Only `in_progress` counts as streaming.
- **Navigation:** the adapter skips a sample when the URL's `/c/<id>` and the DOM's `data-chatgpt-selection-conversation-id` disagree (mid-navigation). Sequences are kept per conversation.
- **Visibility (as decided):** `getOrderStatus(messageId)` on the adapter returns `{ retrieval, note }`. A detached source window gives `retrieval: 'disabled'` (the index is not searched; the always-include material is still sent) and a note; a conflict earlier in the session gives a note on every later explanation in that chat. The note travels `RawFocal.orderStatus` → `FocalInput.orderStatus` → `PromptReport.orderNote` → the popup's muted line and the console report. The prompt text is unchanged. This is the one deliberate edit to `src/context/` (types, focal, assemble, report, gather) and is optional-field only, so claude.ai output is byte-identical.
- **Stated limits:** pending (detached) windows are not cached, so when they later connect only currently mounted turns are indexed; the first turn of the window always reports "nearby messages not loaded" because the chat start is not knowable (no geometry); the index is lost on reload (option C is the future fix); a user highlighting inside a streaming turn gets nothing until it finishes.

### Tasks, in order, each committed with its tests

1. `turnSequence.ts` + tests (base, slide down/up, detached, conflict by slot clash, conflict by position mismatch, edit replaces a turn, duplicate ids, bounds, generation/conflict counters).
2. `generationGate.ts` + tests; wire `getIndexGeneration?()` into `SiteAdapter`, the indexer (gate + mid-pass abort) and `prepareExplainPrompt`.
3. Order status through the prompt layer (`context/types`, `focal`, `assemble`, `report`, `gather`, `readFocal`) + tests.
4. `chatgptBlocks.ts` + tests against the four ChatGPT fixtures (Task 4 as written above).
5. `chatgpt.ts` adapter + tests against the conversation fixture and synthetic sliding windows; registry, manifest `matches`.
6. Build, full suite, docs, live checklist (below). Self-review of the whole branch.

### Live checklist additions for B

- Send a new message and let it finish: no conflict note, no index wipe in the debug log (the key of the streaming turn must not change).
- Switch chats from the sidebar without reloading, then Explain: ids and index belong to the chat you are in.
- Edit an early message: the next explanation shows the "chat order changed" note and the index restarts from the screen.
- Fast scrollbar drag, then highlight: the explanation still works, the popup says the part is not connected and only nearby messages were used.
- Read a real `__glossPrompt()` report on ChatGPT: the message numbers are arbitrary but the question is the same turn's user message and the recent ones are the turns just above.

### Live checklist for the built scheme B (revised 2026-10-18, after the independent review)

Build, refresh the extension, **reload the chatgpt.com tab** (stale content script), turn the debug toggle on, open DevTools and filter the console by `highlight-explainer`. **For the whole session, any line saying the order of the ChatGPT chat changed, or any "chat changed" note in a popup, that you did not cause by editing, is a finding: stop and tell me.**

Part A: the five things the reviewer could not establish from code. In this order, because a "no" to the first makes every later result suspect.

1. **Does a turn's key change after its answer finishes?** Send a message in a chat with 5+ turns. Wait for the answer to finish, then 15 more seconds. Expect: no "order changed" warning, no "chat changed" note in the popup, and the generation unchanged. If you get a conflict on every message you send, the key changes at completion (the frame logic needs the temporary-key case handled).
2. **Is there ever a mounted turn that is not next to the others (a pinned last turn, a sticky element)?** The recorder sweeps found none, but not while sending. After step 1, scroll up and down while the composer is focused. Expect no conflict. A conflict while merely scrolling means a non-adjacent turn is being mounted.
3. **Does ChatGPT recycle DOM elements for other turns?** Paste this, scroll the whole chat a few times (slowly and with the scrollbar), then run `__reuse.stop()`. `reused: 0` means elements are never handed to another turn (the F5 guard is then insurance only). Any other number: report it.
   ```js
   (() => {
     const seen = new WeakMap(); let samples = 0, reused = 0;
     const keyOf = (el) => (el.matches('[data-turn-key]') ? el : el.closest('[data-turn-key]'))?.dataset.turnKey;
     const tick = () => {
       samples++;
       document.querySelectorAll('[data-turn-key],[data-user-message-bubble],[data-dil-message-id]').forEach((el) => {
         const key = keyOf(el); const prev = seen.get(el);
         if (prev && key && prev !== key) reused++;
         if (key) seen.set(el, key);
       });
     };
     const timer = setInterval(tick, 200); tick();
     window.__reuse = { stop() { clearInterval(timer); console.log({ samples, reused }); } };
   })();
   ```
4. **How common are turns with more than one answer body (thinking, search, tools)?** In a chat that used them, run the line below and count turns where `answers` is not 1. Also note whether Explain works in those turns (it opens nothing in a turn with two bodies; the debug log lists them).
   ```js
   [...document.querySelectorAll('[data-turn-key]')].map((t) => ({ users: t.querySelectorAll('[data-user-message-bubble]').length, answers: t.querySelectorAll('[data-dil-message-id]').length }))
   ```
5. **Does CodeMirror only render the lines near its viewport?** Ask ChatGPT for a 300-line script. Run the line below, scroll inside the code block, run it again. If the line count changes as you scroll, long code is only partly in the DOM and its chunk would be truncated.
   ```js
   [...document.querySelectorAll('[data-code-block]')].map((b) => ({ cmLines: b.querySelectorAll('.cm-line').length, pre: b.querySelectorAll('pre').length }))
   ```

Part B: the normal flows.

6. **claude.ai is unchanged:** reload a claude.ai tab; Explain, `__glossSearch`, `__glossHybrid`, `__glossPrompt` behave as in v5.
7. **Indexing and code:** scroll slowly down a ChatGPT chat. `__glossDumpChunks()` shows chunks for what you scrolled through; code blocks whole; formulas once as `$...$`; tables as `a | b | c` rows. **Check a Python block: is the indentation there?**
8. **Explain, ordinary case:** highlight inside an answer. Read the `__glossPrompt()` report, not just the text: the question is the user message of the same turn, the recent messages are the turns just above, the excerpts are in chat order, the message numbers are arbitrary but consistent.
9. **Switch chats from the sidebar without reloading**, then Explain: the ids and the index belong to the chat you are in (try A, B, then back to A).
10. **Fast scrollbar drag, then highlight:** the explanation works; the popup says this part is not connected and only nearby messages were used; the report shows retrieval disabled. Scroll step by step back to where you were: it connects and the note goes away.
11. **Edit an early message, and separately regenerate the last answer:** after an edit the next explanation shows the "chat changed" note and the index restarts from the screen; a plain regenerate replaces the old answer's chunks and shows no note.
12. **Two tabs of the same chat** (the case that caused F2): scroll in both, then in the FIRST tab run `__glossHybrid("some term")`. It must still show embedding ranks for chunks (not only BM25) once that tab has re-indexed what it shows. Each tab explains correctly and neither shows the other's chunks.
13. **Typing and streaming:** no lag while an answer streams; scrolling does not feel slower.
14. **ChatGPT's own selection overlay** and our Explain button do not hide each other; the popup closes on Escape and outside click.
15. A user-only turn, an attachment-only question, a table answer and a formula highlight each explain sensibly, or say why not.

Probe tools used along the way are in the chat history only (the recorders were throwaway and are not in the repo).

### Results so far from the live checklist (2026-10-18)

- **Item 3 (element recycling): `reused: 0`** over 130 samples. The F5 guard is insurance only.
- **Item 4 (answer bodies): no turn has two.** Three consecutive turns (5, 6, 7 of 10) have a question and NO answer body. They are handled (numbered, question indexed, neighbours unaffected). Whether the answers are genuinely absent or rendered under an attribute we do not know is open; the question-only probe in the chat history decides it, and a selection inside such a turn currently opens no popup (proposed: say so).
- **Item 5 (CodeMirror): it does virtualize.** Handled as "windowed code" (see CLAUDE.md, v8 notes). Open: confirm indentation on a nested block with the `leadingSpaces` one-liner below (no fixture can answer it).

```js
[...document.querySelectorAll('[data-code-block]')].map((b, i) => ({ block: i, leadingSpaces: [...b.querySelectorAll('.cm-line')].slice(0, 40).map((l) => (l.textContent.match(/^[ \t]*/)[0] || '').length).join(' ') }))
```

**Capturing fixtures:** the editor may format a pasted file. Turn off format-on-paste/save for `fixtures/*.html` (or paste through a plain-text editor) and check that the file is not CRLF-wrapped. A fixture is trusted for structure only if you are not sure.

- **New in the final shape:** select text in a turn that has a question and no answer (or any part of a turn that is not the question or the answer, such as its action bar) and click Explain. Expect a popup with a sentence saying it cannot read this part, never nothing. Select text in the sidebar or the composer and click Explain: expect "not part of a chat message". While an answer streams, select inside it: expect "still being written".

- **Indentation: PASSED.** Real spaces in the text (nesting 0/4/8/12/16 on three Python blocks).
- **Empty code blocks:** 5-6 of 14 on one page had zero `.cm-line`. Run this to tell "off screen, not drawn yet" from "a `<pre>`/`<code>` shape" from "empty although visible":

```js
(() => {
  const blocks = [...document.querySelectorAll('[data-code-block]')];
  const rows = blocks.map((b, i) => {
    const cm = b.querySelectorAll('.cm-line').length;
    const pre = [...b.querySelectorAll('pre')];
    const code = [...b.querySelectorAll('code')];
    const rect = b.getBoundingClientRect();
    const turn = b.closest('[data-turn-key]');
    const cv = (el) => (el ? getComputedStyle(el).contentVisibility : null);
    return {
      i,
      shape: cm ? 'editor lines' : pre.length ? 'pre' : code.length ? 'code' : 'EMPTY',
      cmLines: cm,
      gaps: b.querySelectorAll('.cm-gap').length,
      editor: !!b.querySelector('.cm-editor'),
      contentChildren: b.querySelector('.cm-content') ? b.querySelector('.cm-content').children.length : null,
      preChars: pre.reduce((n, p) => n + p.textContent.length, 0),
      codeChars: code.reduce((n, p) => n + p.textContent.length, 0),
      height: Math.round(rect.height),
      topFromViewport: Math.round(rect.top),
      onScreen: rect.bottom > 0 && rect.top < innerHeight,
      turnContentVisibility: cv(turn),
      blockContentVisibility: cv(b),
    };
  });
  console.table(rows);
  console.log('summary:', rows.reduce((a, r) => ((a[r.shape] = (a[r.shape] || 0) + 1), a), {}));
})();
```

- **Question-only turns: recorded as an open item, not chased (2026-10-18).** A later run found none in the chat on screen. Harmless if the answer is genuinely absent; thinner context if it is rendered under an attribute we do not know. See the open item in CLAUDE.md, with its trigger. Skip it in the live run unless a popup says "unfamiliar message layout" on a normal-looking answer.
