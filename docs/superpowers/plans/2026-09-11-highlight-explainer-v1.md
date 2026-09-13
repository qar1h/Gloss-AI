# Highlight Explainer v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v1 of the Highlight Explainer Chrome extension: highlight text in a Claude.ai answer, click "Explain", get a streamed plain-language explanation in an on-page popup. No RAG, no storage, no other sites.

**Architecture:** A WXT/Manifest V3 extension with three real execution contexts — a content script injected into claude.ai (owns selection detection, the "Explain" button, and the popup, which is just DOM inside the content script's Shadow DOM, not a separate browser-action popup), a background service worker (owns the Gemini API call and streams text back), and an options page (owns API key / model id / debug toggle, talks to chrome.storage.local directly, no messaging needed). Content script and background talk over a single long-lived `chrome.runtime.connect` Port per explain request, so streamed chunks and cancellation are natural. All claude.ai-specific DOM knowledge is isolated in one adapter file behind a `SiteAdapter` interface, so it's the only file that has to change when claude.ai's markup changes.

**Tech Stack:** Manifest V3 + WXT, TypeScript strict, marked + DOMPurify for rendering, Gemini REST `streamGenerateContent` (SSE) called from the background worker. No test runner is added in v1 (see Testing Approach below) — that would be a new dependency not listed in CLAUDE.md's tech stack, so it needs explicit sign-off first.

**Spec:** `CLAUDE.md` (this repo's root) — see the "v1: Basic extension (no RAG)" section and the general "Design rules".

## Global Constraints

- Zero cost: Gemini free tier only, embeddings/backend never introduced in v1.
- Personal use only: unpacked dev-mode extension, no Web Store, no analytics/telemetry.
- The Gemini API key is entered on the options page and stored only in `chrome.storage.local` — never hardcoded, never committed.
- Only the visible DOM of the chat page is read. Never call claude.ai's own private APIs or piggyback its session.
- All claude.ai selectors live in `src/sites/claude.ts` and nowhere else.
- Only build v1. Leave clean seams for later versions (a `context/` module that can grow into RAG, an `LLMProvider` interface that can grow more providers) but do not build those later pieces now.
- Do not add a dependency that isn't already in CLAUDE.md's tech stack without asking first.

---

## Testing Approach for v1

CLAUDE.md's tech stack section lists no test framework, and the v1 "Done when" criterion is a manual check ("the user can highlight text on claude.ai and get a correct, streamed explanation"). So v1 uses **manual browser testing** as the primary verification method, task by task, instead of introducing vitest/jest. Pure-logic files (prompt building, SSE parsing) get a tiny throwaway manual check (a one-off `console.log` or a scratch script run with `tsx`, nothing checked in) rather than a real test suite. If you'd rather have real automated tests for the logic-only files, say so and I'll ask about adding a minimal test runner — that's a dependency decision CLAUDE.md says to check with you on first.

## Fixture Dependency

Task 10 (`src/sites/claude.ts`) is the only task that needs real claude.ai HTML. Everything before it can be built and manually smoke-tested without touching claude.ai's real markup. **Save fixtures before we reach Task 10** — see "What to save in fixtures/" below.

---

## File Structure

```
Gloss/
  wxt.config.ts                    # WXT config: manifest permissions, host_permissions for claude.ai
  package.json / tsconfig.json
  fixtures/                        # real claude.ai HTML snapshots (user-provided, not shipped)
  src/
    entrypoints/
      content.ts                   # content script entry: matches claude.ai, calls content/index.ts
      background.ts                # service worker entry: sets up the Port listener
      options/
        index.html
        main.ts                    # options page UI, reads/writes via options/storage.ts
    content/
      index.ts                     # wires selection + button + popup + adapter + messaging together
      ui/
        selection.ts                # detects text selection, gives back the Range + bounding rect
        explainButton.ts            # creates/positions the floating "Explain" button
        popup.ts                    # Shadow DOM popup: renders streamed markdown, Escape/outside-click to close
    sites/
      types.ts                     # SiteAdapter interface — the contract every site adapter must implement
      claude.ts                    # the claude.ai adapter (all claude.ai selectors live here)
    background/
      handleExplain.ts             # core background logic: context -> prompt -> Gemini -> stream back
    llm/
      provider.ts                  # LLMProvider interface: streamExplain(prompt, signal) -> async text chunks
      gemini.ts                    # Gemini implementation: SSE fetch, 429 retry/backoff
    context/
      prompt.ts                    # pure function: ExplainContext -> final prompt string
    messaging/
      types.ts                     # shared message/port contract between content script and background
    options/
      storage.ts                   # get/set apiKey, modelId, debugEnabled in chrome.storage.local
  public/
    icon-*.png                     # extension icons
```

**Design note:** `context/prompt.ts` is deliberately pure (no DOM access) so it can run in the background worker and can grow into the RAG-aware prompt builder from v5 without moving files around. Gathering the raw pieces of context (highlight, paragraph, message, etc.) requires the DOM, so that happens in `content/index.ts` using the adapter, and the *shaped* result is what crosses the Port to the background worker.

---

## Communication Contract

Defined once, in `src/messaging/types.ts`, and imported by both `content/index.ts` and `background/handleExplain.ts`:

```ts
export interface ExplainContext {
  highlight: string;
  paragraph: string;
  message: { role: 'user' | 'assistant'; text: string };
  userQuestion: string;
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
}

export type ExplainToBackground =
  | { type: 'explain-request'; requestId: string; context: ExplainContext };

export type ExplainToContent =
  | { type: 'explain-chunk'; requestId: string; text: string }
  | { type: 'explain-done'; requestId: string }
  | { type: 'explain-error'; requestId: string; message: string };
```

**Flow, in plain language:**

1. User selects text on claude.ai. `content/ui/selection.ts` notices and `content/ui/explainButton.ts` shows a small button near the selection.
2. User clicks the button. `content/index.ts` asks the adapter (`src/sites/claude.ts`) for the surrounding paragraph, the full message, the user question that led to it, and the last few messages — and packs that into an `ExplainContext`.
3. `content/index.ts` opens the popup (`content/ui/popup.ts`) in a "loading" state, then opens a `chrome.runtime.connect({ name: 'explain' })` Port and sends one `explain-request` message with a fresh `requestId` and the context.
4. The background worker's Port listener (`background/handleExplain.ts`) builds the final prompt (`context/prompt.ts`), reads the API key/model from `chrome.storage.local`, and calls `llm/gemini.ts`'s `streamExplain`.
5. As text chunks arrive from Gemini, the background worker posts `explain-chunk` messages back over the same Port. The popup appends each chunk and re-renders markdown live.
6. On completion, background sends `explain-done`. On failure (including a 429 that exhausted retries), it sends `explain-error` and the popup shows a clear error message.
7. If the user closes the popup (Escape or click outside), `content/index.ts` disconnects the Port. The background worker's `port.onDisconnect` handler aborts the in-flight Gemini fetch via an `AbortController`, so nothing keeps streaming into a closed popup.

The options page never goes through this Port — it's a normal extension page that reads and writes `chrome.storage.local` directly through `options/storage.ts`.

---

## How We'll Find Messages and Selected Text

Two different problems, handled in two different places:

- **"What text did the user select, and where on screen is it?"** — This is plain Web Platform API (`window.getSelection()`, `Range`, `getBoundingClientRect()`), the same on every site. Lives in `content/ui/selection.ts`, has nothing to do with claude.ai specifically.
- **"Given that selection, which chat message is it inside, what role does that message have, what's the paragraph around it, what's the message before it, and how do we notice a message that's still streaming in or hasn't loaded yet?"** — This is claude.ai-specific and lives entirely in `src/sites/claude.ts`, behind this contract (`src/sites/types.ts`):

```ts
export interface SiteAdapter {
  getMessageForNode(node: Node): { id: string; role: 'user' | 'assistant'; element: HTMLElement } | null;
  getMessageText(el: HTMLElement): string;
  getParagraphAround(range: Range): string;
  getUserQuestionFor(assistantMessageId: string): string | null;
  getRecentMessages(beforeId: string, count: number): { role: 'user' | 'assistant'; text: string }[];
  watchForStreamingUpdate(el: HTMLElement, onUpdate: () => void): () => void; // returns an unsubscribe fn
}
```

I will **not** guess the CSS selectors that back this interface. They get filled in once real claude.ai HTML is available (see below), by inspecting the actual markup, per CLAUDE.md's explicit instruction to inspect the real page rather than guess.

### What to save in `fixtures/`

Tell me once you've saved these, and I'll use them to write `src/sites/claude.ts`:

1. **A short chat with 2-3 user/assistant pairs.** In Chrome DevTools, right-click the element that wraps the *whole conversation* (the scrollable message list) → "Copy" → "Copy outerHTML" → paste into e.g. `fixtures/short-chat.html`.
2. **If you can catch it, a snapshot taken while an assistant answer is still streaming in** (copy outerHTML mid-response). This helps me see whether a streaming message has a distinguishing class/attribute — if it doesn't, I'll instead detect "still growing" purely by watching for DOM mutations, which works either way.
3. **A longer chat, scrolled to the top**, so I can see how claude.ai represents messages that exist in the conversation but aren't currently rendered/loaded — this matters for the "last few messages" and "message before this one" lookups if the conversation is long.

A static HTML snapshot can't fully prove out live streaming behavior (mutation timing, whether nodes get replaced vs. appended) — for that last part I may ask you to try the real extension against a live streaming answer once it's wired up, rather than relying on the fixture alone.

---

## Tasks

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `wxt.config.ts`, `.gitignore`
- Create: `public/icon-16.png`, `public/icon-48.png`, `public/icon-128.png` (placeholder icons, swappable later)

**What it does:** Sets up a WXT + TypeScript-strict project targeting Manifest V3, with `host_permissions` for `https://claude.ai/*` and the `storage` permission. No claude.ai-specific code yet.

**Manual test:** `pnpm dev` (or `npm run dev`) builds without errors and Chrome can load the unpacked extension from the output directory with no manifest errors.

### Task 2: Messaging contract

**Files:**
- Create: `src/messaging/types.ts`

**What it does:** Defines `ExplainContext`, `ExplainToBackground`, `ExplainToContent` exactly as shown in the Communication Contract section above. Pure types, nothing else.

**Manual test:** `tsc --noEmit` passes.

### Task 3: LLMProvider interface + Gemini implementation

**Files:**
- Create: `src/llm/provider.ts`, `src/llm/gemini.ts`

**What it does:** `provider.ts` defines `interface LLMProvider { streamExplain(prompt: string, signal: AbortSignal): AsyncGenerator<string> }`. `gemini.ts` implements it: calls the Gemini `streamGenerateContent` SSE endpoint with the stored API key and model id, yields text chunks as they arrive, and retries with exponential backoff on HTTP 429 before giving up and throwing.

**Manual test:** A throwaway script run with `tsx` (not checked in) that calls `streamExplain` with a real free-tier key and prints chunks to the terminal.

### Task 4: Prompt builder

**Files:**
- Create: `src/context/prompt.ts`

**What it does:** Pure function `buildPrompt(context: ExplainContext): string` that assembles the final Gemini prompt: the highlight, its paragraph, its message, the user question, the last few messages (in order, labeled by role), followed by the fixed instruction to explain the highlighted part in simple, plain language, using the conversation only where it helps.

**Manual test:** Call it with a hand-written sample `ExplainContext` and eyeball the printed prompt string.

### Task 5: Background worker

**Files:**
- Create: `src/entrypoints/background.ts`, `src/background/handleExplain.ts`

**What it does:** `background.ts` registers a `chrome.runtime.onConnect` listener for Ports named `explain`. `handleExplain.ts` holds the logic: on the `explain-request` message, read `apiKey`/`modelId`/`debugEnabled` from storage, build the prompt, and call `gemini.streamExplain` with an `AbortController` tied to `port.onDisconnect`. Post `explain-chunk` per chunk, `explain-done` at the end, `explain-error` on failure. If `debugEnabled`, `console.log` the full prompt and an approximate token count (`prompt.length / 4`).

**Manual test:** Load the extension, open the service worker's console, manually open a Port from the DevTools console and send a fake `explain-request` — confirm chunks/done/error print as expected.

### Task 6: Options page

**Files:**
- Create: `src/options/storage.ts`, `src/entrypoints/options/index.html`, `src/entrypoints/options/main.ts`

**What it does:** `storage.ts` exposes typed `getSettings()`/`setSettings()` over `chrome.storage.local` for `{ apiKey, modelId, debugEnabled }`. The options page is a plain HTML form (no React, per CLAUDE.md) wired to those functions.

**Manual test:** Open the options page, enter a key/model, reload the page, confirm the values persist.

### Task 7: Selection detection + Explain button

**Files:**
- Create: `src/content/ui/selection.ts`, `src/content/ui/explainButton.ts`

**What it does:** `selection.ts` listens for selection changes and exposes the current `Range` and its bounding rect (or `null` when the selection is empty/collapsed). `explainButton.ts` shows/hides/positions a small button near that rect and exposes an `onClick` callback. Both are site-agnostic — they work on any page.

**Manual test:** Temporarily wire these two into `content/index.ts` on any page (e.g. this doesn't even need claude.ai yet) and confirm the button appears near a text selection and disappears when the selection clears.

### Task 8: Popup

**Files:**
- Create: `src/content/ui/popup.ts`

**What it does:** Opens a Shadow DOM host near the highlight, renders streamed text as markdown via `marked` + `DOMPurify` (sanitize before every insertion), shows a loading state, an error state, and closes on Escape or a click outside the shadow root. Exposes `open()`, `appendChunk(text)`, `showError(message)`, `close()`.

**Manual test:** Drive it manually (temporary test button) to confirm it renders sample streamed markdown correctly and closes on Escape/outside click, and that the host page's CSS doesn't leak in or out.

### Task 9: SiteAdapter interface

**Files:**
- Create: `src/sites/types.ts`

**What it does:** Defines the `SiteAdapter` interface exactly as shown above. No implementation yet — this just locks the contract so `content/index.ts` (Task 11) can be written against it before the real adapter (Task 10) exists.

**Manual test:** `tsc --noEmit` passes.

### Task 10: claude.ai adapter — **blocked on fixtures**

**Files:**
- Create: `src/sites/claude.ts`

**What it does:** Implements `SiteAdapter` for claude.ai using selectors found by inspecting the fixture files in `fixtures/` (see "What to save in fixtures/" above) — not guessed. Covers: mapping a DOM node to its enclosing message + role, extracting message text, finding the paragraph around a selection, finding the preceding user message, collecting the last N messages, and watching a message element for streaming updates via `MutationObserver`.

**Manual test:** Load the fixture HTML in a throwaway local page (or directly on claude.ai once available) and manually call each adapter function from the DevTools console against real messages, confirming correct role/text/paragraph extraction.

### Task 11: Wire it all together in the content script

**Files:**
- Create: `src/entrypoints/content.ts`, `src/content/index.ts`

**What it does:** `content.ts` is the WXT entrypoint matching `https://claude.ai/*`, delegating to `content/index.ts`. That file wires: selection → button → (on click) adapter gathers `ExplainContext` → popup opens loading → Port opens and sends `explain-request` → popup renders incoming chunks/done/error → popup close disconnects the Port.

**Manual test:** This is the full v1 end-to-end manual test from CLAUDE.md: on a real claude.ai chat (short and long), highlight text in an answer, click Explain, confirm a correct streamed explanation appears, and confirm the main chat is never modified and the popup closes cleanly on Escape and outside click.

---

## Self-Review

- **Spec coverage:** highlight → button → popup (Tasks 7, 8, 11); streamed Gemini answer rendered as markdown (Tasks 3, 8); context = highlight + paragraph + message + user question + last few messages (Tasks 4, 9, 10, 11); options page for API key/model (Task 6); debug toggle logging prompt + token count (Task 5); popup closes on Escape/outside click, main chat untouched (Tasks 8, 11); all claude.ai selectors isolated to one file (Task 10); `LLMProvider` seam left open for future providers without building them (Task 3); `context/` left as a plain module that can grow into RAG later without relocation (Task 4). All covered.
- **Placeholder scan:** no TBD/"add error handling"-style steps; Task 10 is explicitly marked blocked-on-fixtures rather than silently guessing, which is a real dependency, not a placeholder.
- **Type consistency:** `ExplainContext`/`ExplainToBackground`/`ExplainToContent` (Task 2) are the exact types used unchanged in Tasks 4, 5, and 11. `SiteAdapter` (Task 9) is the exact interface implemented in Task 10 and consumed in Task 11.
