# CLAUDE.md — Highlight Explainer

## What this project is

A Chrome extension for AI chat websites. The user highlights a word, sentence, or paragraph in an AI's answer. A small "Explain" button appears next to the highlight. Clicking it opens a small popup, right there on the page, with a simple explanation of the highlighted part. The explanation uses the rest of the conversation as context.

**The problem it solves:** asking a follow-up in the main chat buries the original answer. The user then has to scroll back up and loses their train of thought. With this extension, the main chat stays untouched.

**Goals:**
- A tool the user actually uses every day.
- A portfolio/resume project that shows real AI/ML work: RAG-based context selection plus a measured evaluation.

## Hard constraints (do not break these)

- **Zero cost.** Use only the Gemini API free tier, with a key from Google AI Studio and billing never enabled. Run embeddings locally in the browser. No paid services and no backend server.
- **Personal use only.** Load the extension unpacked in Chrome developer mode. No Chrome Web Store publishing, analytics, accounts, or telemetry.
- **The API key never goes in the code or the repo.** The user enters it on the extension's options page, and it is stored in `chrome.storage.local`.
- **Only read the chat page's visible text (the DOM).** Never send messages through the chat site's own session, and never call its private APIs.

## Tech stack

- **Extension:** Chrome Manifest V3, TypeScript (strict mode), built with WXT.
- **Popup UI:** rendered inside a Shadow DOM, so the host site's CSS cannot break it. Keep the UI code simple; React is optional.
- **Answer rendering:** markdown via `marked` + `DOMPurify`. Always sanitize model output before inserting it into the page.
- **LLM:** Gemini REST API (`streamGenerateContent` with SSE streaming), called from the background service worker.
  - Keep the model ID in one config constant. Default to a current free-tier Flash model.
  - Verify the free-tier model IDs in Google AI Studio before starting, because they change.
- **Embeddings (from v3):** transformers.js (`@huggingface/transformers`) with a small model, `all-MiniLM-L6-v2` or `bge-small-en-v1.5`.
  - Run it in a `chrome.offscreen` document. The extension's CSP will need `'wasm-unsafe-eval'`.
- **Storage (from v2):** IndexedDB for chunks and embedding vectors.
- **Keyword search (from v4):** our own small BM25 implementation, since it is part of the learning and resume value.
- **Testing (from v2):** `vitest` for pure-logic unit tests (the chunker). Playwright, used interactively against real and hand-built fixtures to verify DOM/selector logic in an actual browser before trusting it — not a checked-in test suite.

## Architecture

```
src/
  sites/          # One adapter per chat site. ALL site-specific DOM selectors live here and nowhere else.
    claude.ts
  content/        # Content script: detect selection, show Explain button, render popup (Shadow DOM)
  background/     # Service worker: builds prompts, calls the LLM, streams results back to the content script
  llm/
    provider.ts   # LLMProvider interface: streamExplain(prompt) -> async stream of text
    gemini.ts     # Gemini implementation (the only one for now)
  context/        # Decides what context goes into the prompt (simple in v1, RAG from v2 on)
  rag/            # chunker, store (IndexedDB), embedder (offscreen), bm25, fusion, budget
  options/        # Options page: API key, model ID, debug toggle
eval/             # v6 only: dataset + evaluation scripts
```

**Design rules:**
- All DOM selectors for a chat site live in its adapter in `src/sites/`.
  - Chat sites change their HTML often, so when something breaks there should be exactly one file to fix.
  - Inspect the real page to find selectors. Never guess them.
- The LLM sits behind the `LLMProvider` interface, so a local model (Ollama or Chrome's built-in Gemini Nano) can be added later without touching other code. Do **not** build those other providers now.
- The adapter must handle two things:
  - messages that are still streaming in (watch the page with a `MutationObserver`),
  - older messages that the site has not loaded onto the page.
- Handle Gemini rate-limit errors (HTTP 429) with retry and exponential backoff. Show a clear message in the popup if a request finally fails.
- Add a debug toggle on the options page that logs the exact prompt sent and its approximate token count.

**Target site for v1:** claude.ai. Support for other sites comes later, through new adapters.

## Build plan: one version at a time

**Workflow rules (important):**
1. Build **only the current version**, shown in "Current status" below. Do not start the next version on your own.
2. Do not add features from later versions early. Only leave clean places in the code for them to plug in.
3. When a version is done, stop and give the user:
   - a short summary of what was built,
   - step-by-step manual test instructions,
   - any known issues.
4. Wait for the user to test it and explicitly say to move on. Then update "Current status" and begin the next version.
5. If the user reports a bug, fix it within the current version before moving on.
6. Ask before adding any new dependency that is not listed in the tech stack above.

### v1: Basic extension (no RAG)
- Highlight text in an AI answer on claude.ai, and a small "Explain" button appears near the selection.
- Clicking it opens a popup anchored near the highlight. The answer streams in from Gemini and is rendered as markdown.
- **Context sent:** the highlighted text, the paragraph around it, the full message it came from, the user message that produced that answer, and the last few messages.
- **Prompt instruction:** explain the highlighted part in simple, plain language, using the conversation only where it helps.
- The options page stores the API key and model ID.
- The popup closes on Escape or on a click outside it, and the main chat is never changed.
- **Done when:** the user can highlight text on claude.ai and get a correct, streamed explanation in the popup, for both short and long chats.

### v2: Chunking and storage
- Split the conversation into chunks:
  - Use message boundaries first, then paragraphs and headings for long messages, aiming for about 100–300 words per chunk.
  - Never split a code block or a formula.
- Store each chunk with its metadata: role (user or assistant), message index, position in the chat, and a hash of its text.
- Index incrementally. Only process new or changed messages, detected by their hash, which also covers edited or regenerated messages.
- Save everything in IndexedDB, keyed by conversation.
- Add a debug view or console dump for inspecting the chunks.
- **Done when:** the chunks look sensible on real chats, including chats with code and formulas.

### v3: Embedding search
- Embed chunks locally with transformers.js in an offscreen document.
- **Search query:** the highlighted text plus its surrounding sentence, plus the user's typed question if there is one.
- Rank chunks by cosine similarity and retrieve the top k (k is configurable).
- **Done when:** the debug output shows relevant chunks for test highlights, and embedding a new message does not freeze the page.

### v4: Keyword search and fusion
- Implement BM25 over the chunks.
- Merge the embedding ranking and the BM25 ranking with reciprocal rank fusion: score = sum of 1 / (60 + rank).
- **Done when:** highlights of exact technical terms find the chunk where that term first appeared or was defined.

### v5: Token budget and length switch
- Build the final prompt within a set budget, estimating tokens as characters ÷ 4:
  1. **Always include** the highlight, its paragraph, its message, and the user question that produced it.
  2. **Then add** fused retrieval results, skipping duplicates, until the budget runs out.
- Put the included chunks in their original chat order and label who said each one.
- **Length switch:** if the whole chat fits under a threshold, send it all and skip retrieval.
- Make the budget and threshold configurable.
- **Done when:** long chats produce compact prompts (visible in debug logs) and explanations are still good.

### v6: Evaluation
- Add a debug button that exports the current chat as JSON.
- **Dataset:** about 40 real highlights from the user's chats, stored in `eval/dataset.jsonl`. Each entry holds the chat ID, the highlight, its message index, and the chunk IDs the user marked by hand as relevant.
- **Retrieval metrics:** recall@k and MRR for embedding-only, BM25-only, and hybrid search.
- **Answer quality:** compare four setups on the same highlights:
  - no context,
  - full chat,
  - embedding-only,
  - hybrid with budget.

  Score each answer with Gemini as a blind judge, shuffling the order so the judge can't tell which setup produced which answer. Allow manual scoring too.
- **Also log:** tokens sent (taken from the API's usage metadata) and response time, for each setup.
- Run eval scripts in Node (tsx), reusing the same `src/rag` code. Space out API calls to stay within free-tier limits.
- **Output:** a results table in `eval/RESULTS.md`. Report the honest numbers, even if full context wins on short chats.

## Later ideas (not scheduled; do not build unless asked)

- Follow-up questions inside the popup.
- Highlighting text inside the popup's own answer, for a nested explanation.
- A "simpler / more detailed" toggle.
- A personal glossary of every term the user has looked up.
- Adapters for ChatGPT and Gemini.
- A local-model provider (Ollama or Chrome's built-in Gemini Nano).

## Known limitations (be upfront about these)

- The extension only sees text that is on the page. It cannot see the chat site's hidden instructions, its memory, the full contents of uploaded files, or older messages that haven't been loaded.
- claude.ai virtualizes long chats (it un-mounts rows that scroll far out of view), so the chunk index only covers messages that have actually been in the DOM at some point — a very long chat you haven't scrolled through yet won't be fully indexed until you do.
- Gemini is a different model from the one that wrote the answer, so it interprets the text rather than "remembering" what was meant.
- Site HTML changes can break the adapter.
- Free-tier limits can change, and Google may use free-tier inputs to improve its models.
- Desktop Chrome only.

## Communication with the user

- Explain things in simple, plain language, but still properly and in detail.
- When making a technical choice, say why in a sentence or two.

## Current status

- **Current version:** v3, not started
- **Completed versions:** v1, v2
- **Notes:**

  **What was built (v1):** Highlight text in a Claude answer on claude.ai, click the "Explain" button that appears, and get a streamed, markdown-rendered, plain-language explanation in a Shadow DOM popup anchored near the highlight — using the highlight, its paragraph, its message, the user question that produced it, and the last few messages as context. Options page stores the Gemini API key, model id, and a debug toggle. Confirmed working end-to-end on live claude.ai, for both short and longer chats.

  **Key decisions:**
  - All claude.ai selectors were read off real captured HTML (saved in `fixtures/`) and verified live in a browser before being trusted — never guessed.
  - Content script ↔ background worker talk over a single long-lived `chrome.runtime.connect` Port (name `explain`) per request, not one-off messages — needed for streamed chunks and clean cancellation (popup close → port disconnect → background aborts the Gemini fetch).
  - Gemini's SSE response parser accepts either the classic `candidates[].content.parts[].text` shape or a newer `delta: { type: 'text' }` shape, since Google is mid-migration to a new "Interactions API" and the wire format isn't fully stable.
  - The free-tier model id lives in one constant (`DEFAULT_MODEL_ID` in `src/llm/gemini.ts`), exactly so a retirement like the one below is a one-line fix.
  - No automated test framework was added — not in the tech stack, and v1's own "done when" is a manual, live-site check, so testing stayed manual (build/typecheck after every change, adapter selectors checked against real fixture DOM, final check on live claude.ai).

  **Three bugs found on live claude.ai and fixed:**
  1. **Explain button never appeared.** `shadow.querySelector('head')` was always `null` — WXT's `createShadowRootUi` (v0.21.4) builds a shadow root with no `<head>`, confirmed by reading the installed WXT source directly. Our manual `<style>` injection silently no-opped, so the button/popup CSS never applied. Fixed by passing CSS through `createShadowRootUi`'s own `css` option instead.
  2. **Gemini calls failed with 404.** `gemini-2.5-flash-lite` was retired for new users mid-project; Google pointed to `gemini-3.5-flash-lite`. Fixed by updating the single `DEFAULT_MODEL_ID` constant.
  3. **"No explanation was returned"** on an otherwise successful call. Two compounding SSE-parsing gaps: leftover buffered text was discarded when the stream closed instead of being processed, and an unrecognized or safety-blocked payload was skipped with no error or log. Fixed by flushing the trailing buffer, surfacing Gemini's own `finishReason`/`blockReason` as a real error, and logging anything still unrecognized.

  **Known open issues carried into v2:** streaming-state detection on claude.ai's own messages was inferred from a static fixture, never observed live mid-stream; the popup doesn't follow the page if you scroll while it's open (anchored at click time); the options page opens embedded in `chrome://extensions` rather than as its own tab (WXT's manifest default).

  **What was built (v2):** Conversations are split into ~100–180 word chunks — message boundaries first, then headings/paragraphs/list items/blockquotes within a message, with code blocks always kept whole even past the word ceiling. Each chunk is stored in IndexedDB (keyed per conversation) with its role, position, a content hash, word count, and a code flag. Indexing is incremental: a debounced `MutationObserver` skips messages still streaming in, and only re-chunks a message when its content hash or the chunker's own version number has changed — so edits and regenerated answers are picked up cheaply instead of re-processing the whole chat. A `console.table` dump (behind the debug toggle) plus a `window.__glossDumpChunks()` console helper make the stored chunks inspectable. v1's explain flow was not touched. Confirmed on live claude.ai: incremental indexing (only changed messages re-indexed), edit-and-regenerate cleanup, v1's Explain flow unchanged, and no lag while a long answer streams in.

  **Key decisions:**
  - **Chunk ceiling set to 180 words, not the ~300 originally sketched.** v3's two candidate embedding models truncate at very different lengths (MiniLM ~256 tokens/~190 words, bge-small ~512 tokens/~380 words); 180 words is safe under either one, so v2 doesn't quietly lock in a v3 model decision that hasn't been made yet.
  - **A `chunkerVersion` constant is stored per message, alongside its content hash.** If the chunking rules themselves change later, bumping that constant forces a clean re-chunk of every message even when its text hasn't changed — the hash alone couldn't catch a rules change.
  - **Stale-chunk cleanup (from an edit/regenerate that shortens a branch) only runs when claude.ai's `data-last-message="true"` row is actually rendered**, using its position as the conversation's true length — not "however many rows happen to be mounted right now." claude.ai virtualizes long chats, so trusting on-screen row count would risk deleting real, older chunks in a long conversation scrolled away from the bottom.
  - Code blocks keep their raw whitespace and line breaks (never collapsed like prose, or the indentation would be destroyed), and nested blocks — a paragraph inside a blockquote, a code block inside a list item — are de-duplicated in the adapter so their text is captured exactly once, never twice.
  - `vitest` was added (the only new dependency) for the chunker's pure unit tests, since it's the one piece of v2 logic with no DOM involved. DOM/selector-dependent logic was instead verified interactively in a real browser with Playwright, against both real captured fixtures and a new hand-built one combining a long multi-paragraph answer with a real code block — same "never guess a selector" discipline as v1.

  **Known open issues carried into v3:** formula/math rendering has never been observed on a real claude.ai page (no fixture shows it), so "never split a formula" isn't implemented — only code blocks are handled; a message disappearing from the *middle* of a conversation isn't handled, only the "branch got shorter" tail case; conversation-switch detection uses a 1-second poll rather than a real navigation event, since claude.ai (a single-page app) has no reliable DOM event for "you switched chats."
