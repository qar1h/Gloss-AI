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
- **Never commit real chat content to the repo.** Chunk dumps, IndexedDB exports, and similar debug output contain real conversation text, which can include secrets (API keys, tokens, credentials the user pasted into a chat). None of that may be committed to the public repo. Before v6's evaluation dataset (`eval/dataset.jsonl`) goes anywhere near GitHub, it must be scrubbed by hand of any such content.

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
  background/     # Service worker: receives the finished prompt, calls the LLM, streams results back to the content script
  llm/
    provider.ts   # LLMProvider interface: streamExplain(prompt) -> async stream of text
    gemini.ts     # Gemini implementation (the only one for now)
  context/        # Assembles the prompt (from v5): always-include material, token budget, length switch, debug report
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
- **The content script owns retrieval and prompt assembly (from v5); the background worker only sends the finished prompt.** The chunk index lives in the chat page's IndexedDB and the query embedding is relayed from the content script, so the background worker cannot do either. The assembly rules are pure modules in `src/context/` with unit tests; `src/context/gather.ts` is the thin I/O layer.

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
- claude.ai virtualizes long chats (it un-mounts rows that scroll far out of view), so the chunk index only covers messages that have actually been in the DOM at some point — a very long chat you haven't scrolled through yet won't be fully indexed until you do. **The gaps are not just "the old messages".** Observed live on the long Supabase chat (v5 test): the mounted rows were `29–36`, `217`, and `403–405`, three disconnected islands, including a lone message `217` far from anything on screen. So the index can have arbitrary holes in the middle of a chat, not only a missing beginning, and a hole can sit right next to a highlight.
- Gemini is a different model from the one that wrote the answer, so it interprets the text rather than "remembering" what was meant.
- Site HTML changes can break the adapter.
- Free-tier limits can change, and Google may use free-tier inputs to improve its models.
- **Retrieval widens what leaves my machine.** Before v5, only the nearby messages went to Gemini. Now any chunk of the chat can be sent, including credentials, API keys or tokens I pasted into a chat much earlier. No redaction is built; this is a known, accepted risk. `__glossPrompt()` shows exactly what a click would send before I click.
- Desktop Chrome only.

## Communication with the user

- Explain things in simple, plain language, but still properly and in detail.
- When making a technical choice, say why in a sentence or two.

## Development gotchas

- **STALE CONTENT SCRIPT — reload the claude.ai tab after every extension reload.** Refreshing the extension on `chrome://extensions` does *not* replace the content script already injected into an open claude.ai tab. The old one keeps running, pointed at an extension context that no longer exists, and fails with `chrome-extension://invalid` errors and "Could not establish connection. Receiving end does not exist." This cost a lot of time during v3 (it looked like a second bug after the first was fixed) and **will happen again** after every `npm run build` + extension refresh. First thing to do when anything messaging-related fails: reload the tab, then re-test. Only chase a real bug if it survives a tab reload.

- **Look for bugs that produce a well-formed but wrong prompt.** The worst bugs in this project don't crash or log an error; they send Gemini a plausible prompt with the wrong content in it, and the explanation just comes out subtly off. The v5 example: reading "the previous message" by DOM adjacency across claude.ai's virtualization gaps (see v5 notes). Any code that reads neighbours, ids, or order from the page must check that what it found is really what it asked for (for example `data-index` continuity), and when it can't find it, say so in the debug report instead of substituting the nearest thing. The `__glossPrompt()` report exists to catch exactly this: read the message numbers in it, not just the text.

## Current status

- **Current version:** v5, built, awaiting live test
- **Completed versions:** v1, v2, v3, v4
- **Notes:**

  **v5 (built, not yet live-tested):** plan in `docs/superpowers/plans/2026-10-04-highlight-explainer-v5.md`. Retrieval now reaches the prompt: always-include (highlight, paragraph, source message, user question, plus the N recent messages) first, then fused excerpts within a 6000-est-token budget, or the whole indexed chat if it fits the same threshold. Inspect with `__glossPrompt()` (dry run), `__glossLastPrompt()`, or the debug toggle. Live-test steps are in Task 10 of the plan. Two things to remember when reading results: the debug prompt report now prints in the **claude.ai tab's console** (content script), not the service-worker console; and an explain's BM25 statistics are computed over the chunks left after exclusion, so its ranking can differ slightly from `__glossHybrid` on the same text (which ranks all chunks). The "what was built / key decisions / what went wrong" notes for v5 get written after the live test, as for v1–v4. **Found in the first live test and already fixed:** a recent message (255, a whole models.py, ≈1670 est. tokens, under the 2000 ceiling) was 53% of a prompt it was irrelevant to. Recent messages over `RECENT_ALWAYS_MAX_TOKENS` (1000) are now *demoted*: not sent whole, and left in the retrieval pool; the recent-message trim ceiling was removed as dead code. An empty `<user_question>` (messages 184 and 256) is no longer emitted and is warned about in the report. **A v1 bug found during v5 testing, now fixed: the adapter walked across virtualization gaps.** `getUserQuestionFor` and `getRecentMessages` (unchanged since v1) walked DOM siblings with no check that `data-index` was consecutive. A live probe showed `217 <- DOM previous row: 126` and `403 <- DOM previous row: 217`, same parent, so a highlight in message 217 got message 126 as "the user question that produced it", labelled `message_number="126"`, plus recent messages 126/125/124. The prompt was well-formed and nothing errored; it simply contained the wrong part of the conversation. It would never have surfaced as an error, and v1–v4 had it too. Fix: `contiguousPrecedingRun` (`src/sites/contiguity.ts`, pure, unit-tested) decides how far back the rows are really the previous messages, counting every row including ones the adapter doesn't recognise, and the walk stops at the first break; a missing question or a short recent list is now reported, not silent (see the report's `questionState` and `recentShortfall`, the warnings, and the popup coverage line). The two causes of a missing question are worded differently: "the question that produced this message isn't loaded" (a gap) versus "the question message has no readable text" (empty). Verified against the saved fixtures with simulated gaps, not yet live. **Still open:** why those user messages read as empty. The cause is not identified; the adapter reads user text only from `[data-testid="user-message"]` and has never been checked against a real attachment message. A DOM probe on the live page is pending. **Code formatting fix:** the source, question and recent message text sent in the prompt used to be the whole message flattened to one line (code lost its newlines and indentation). It is now built from the same blocks the chunker indexes, rendered by one shared function (`blocksToText` in `src/rag/chunker.ts`), so a whole message and its excerpts cannot drift apart; the highlight's paragraph uses the same per-block text. **Paragraph cap:** for a code highlight the "paragraph" is the whole code block, which the source message already contains, so a paragraph over `PARAGRAPH_CEILING_TOKENS` (400) is windowed around the highlight with a `[… trimmed …]` marker (the highlight itself is never trimmed). Not yet tried live. `getMessageText` (flattened) remains only as the indexer's change-detection key. The chunker output and `CHUNKER_VERSION` are unchanged, so nothing re-indexes. Verified against the saved fixtures (`fixtures/`), not yet on the live site.

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

  **What was built (v3):** Every stored chunk is embedded locally (transformers.js, `Xenova/all-MiniLM-L6-v2` quantized, 384-dim vectors, no network calls after the one-time model download) and ranked by cosine similarity against a query made from the highlight plus the sentence around it. The model runs in a `chrome.offscreen` document, relayed through the background worker. Vectors live in a new `embeddings` IndexedDB store (schema version 2). Embedding is incremental and piggybacks on the v2 indexing pass: only new, changed, stale-version or previously-failed chunks are embedded, in batches of 8, yielding to the page between batches. `window.__glossSearch(text, k?)` prints the top-k chunks with scores plus a coverage line ("indexed N of ~M messages"); `k` is a setting on the options page (default 5). Retrieval is **not** used in the explain prompt — v3 ends at the console.

  **Key decisions:**
  - **MiniLM over bge-small:** roughly half the transformer layers and a smaller download, for a tool meant to feel instant; bge-small's few extra retrieval-benchmark points aren't a metric this project measures until v6. The model id lives in one constant (`EMBEDDING_MODEL_ID` in `src/rag/embedder.ts`); `EMBEDDING_VERSION` forces a re-embed if it ever changes.
  - **The orchestration loop stays content-script-side.** The IndexedDB lives in claude.ai's page origin, which the offscreen document (a `chrome-extension://` origin) cannot see, so only a plain `texts -> vectors` call crosses to the offscreen document.
  - Tiny chunks (under ~12 words) are embedded with trimmed neighbor text from the same message, never excluded and never changed in storage. A failed embedding is stored as `status: 'failed'` with a retry cap (`failureCount`, max 3), never as a vector. No exponential backoff — that is for Gemini's HTTP 429s, not local compute.
  - The spec's "plus the user's typed question" is inert: no such input exists in the popup, so `buildSearchQueryText` takes an optional `typedQuestion` that every caller passes empty.
  - Auto-scrolling the page to mount more of a virtualized chat was considered and rejected (it would move the user's reading position); the coverage line makes the gap visible instead.
  - Also fixed during v3: `onupgradeneeded` now branches on `oldVersion`; deleting or replacing a message also deletes its orphaned embeddings; a message stuck "streaming" for 60 s is indexed anyway; overlapping index passes are serialized; blocked/superseded IndexedDB connections are handled.

  **What went wrong in live testing, and what it taught (v3):**
  1. **The offscreen document never appeared at all at first.** The extension's inspect views showed only the service worker, and both the content-script and background consoles showed "Could not establish connection. Receiving end does not exist." The relay/loading fixes for this are in commits `9b67c50` (answer embed messages with `sendResponse`), `2c4c08b` (load onnxruntime's WASM locally; use a model repo that actually ships a quantized file — the first-choice `onnx-community` repo did not) and `569e731` (verify the offscreen document is really alive instead of trusting `createDocument()`); the live session did not record which one fixed the missing-offscreen symptom specifically.
  2. **After that fix, `chrome-extension://invalid` errors appeared. These were a stale content script, not a bug** — see "Development gotchas" above. Reloading the claude.ai tab cleared them.
  3. **A harmless warning on first run** in the offscreen console: "Failed to cache ort-wasm-simd-threaded.asyncify.wasm: Request scheme 'chrome-extension' is unsupported". The WASM loads fine from inside the extension; only the Cache API write fails. Ignore it.
  4. **Chunks stuck at `failureCount >= 3`** from before the fix would never be retried, so `window.__glossResetFailedEmbeddings()` was added and was needed in live testing to clear them (it deletes only `failed` records, never `done` ones, then re-indexes).

  **Confirmed live on claude.ai (v3):**
  - Search quality on a real chat: the query "lie detection accuracy" returned 5 relevant chunks with scores 0.59, 0.58, 0.46, 0.40, 0.40 — a clear gap between the top two and the rest.
  - Coverage: **3 of ~36 messages were indexed without scrolling.** The virtualization limit is real and still unresolved; only messages that have been mounted in the DOM are searchable.

  **Known open issues carried into v4:** virtualization coverage (above) — a long chat is only searchable where you have scrolled; formula/math rendering has still never been observed on a real page; the stale-content-script trap (see "Development gotchas"); the first run downloads the model (~23 MB) before any search works; the typed-question input does not exist yet.

  **What was built (v4):** Keyword search and fusion, ending at the console like v3. Our own BM25 (`src/rag/tokenize.ts`, `bm25.ts`) ranks the stored chunks; reciprocal rank fusion (`fusion.ts`, score = sum of 1/(60 + rank)) merges that with v3's embedding ranking; `hybrid.ts` ties them together. `window.__glossHybrid(text?, k?, depth?)` prints the embedding, BM25 and fused rankings side by side with each chunk's rank and score in every list, which terms matched, and an "own msg" column flagging chunks from the highlight's own message (kept deliberately so the self-match effect is visible before v5 decides anything). With no `text` it uses the current page selection and the real paragraph around it. The prompt, the popup, `__glossSearch`, the chunker and the IndexedDB schema are untouched. Plan: `docs/superpowers/plans/2026-10-04-highlight-explainer-v4.md`.

  **Key decisions (v4):**
  - **No persisted index.** Term statistics are rebuilt in memory on every search, so edits, regenerations and deletes are always correct. The one expensive step, tokenising, is skipped for unchanged chunks through an in-memory cache keyed by each chunk's own `textHash`.
  - **Tokenisation:** an identifier like `pool_pre_ping` is indexed whole *and* as its parts (`pool`, `pre`, `ping`); snake_case, camelCase, acronyms and dotted paths are all split; dots, hyphens and other punctuation are separators; tokens over 40 characters (hashes, pasted keys) are dropped; no stemming. Stopwords are removed from the query only, so `not`/`in`/`is` stay findable in code, and an all-stopword highlight makes BM25 abstain.
  - **The BM25 query is the highlighted text only** (the embedding query still carries the surrounding sentence), so the two lists contribute different signals.
  - **Fusion:** 1-based ranks, constant 60, each list cut to `RRF_DEPTH` = 50 (a named constant, also a per-call argument). Chats with fewer embedded chunks than that are unaffected by the cap, and there a chunk is "bm25 only" only if it has no embedding. Ties break by chat order, never by chunk id (ids sort as strings, so `…:10:0` would sort before `…:2:0`). No "earlier chunk is better" bonus — that waits for v6 to measure it.
  - **Done-when (weakened on purpose):** the chunk where an exact term is defined appears in the top-k, not necessarily rank 1 — BM25 finds where a term is densest, not where it first appeared.
  - **Measured, not assumed:** `npm run bench` (synthetic text, plain timing; numbers and machine in `docs/benchmarks/2026-10-04-bm25-3000-chunks.md`). The first estimate was wrong — a cold 3000-chunk index build was ~580 ms — which is why the tokenizer fast path and the term-count cache exist. Now ~187 ms cold and ~32–49 ms warm at 3000 chunks (about 3 ms warm at 300).

  **Confirmed live on claude.ai (v4):** on a real long chat (the Supabase chat, 152 chunks indexed), `__glossHybrid('pool_pre_ping')` gave:

  | chunk | what it is | embedding rank | BM25 rank | fused | BM25 matched terms |
  |---|---|---|---|---|---|
  | 257:4 | prose explaining it | 1 | 2 | 1 | `pool_pre_ping`, `pool`, `pre`, `ping` (all four) |
  | 257:3 | the code block | 4 | 1 | 2 | `pool_pre_ping`, `pool`, `pre`, `ping` (all four) |
  | 243:1 | | 6 | 3 | 3 | `pool` only |
  | **243:2** | explains `create_engine` / pooling | **37** | **4** | **4** | **`pool` only** |

  **The 243:2 result is the evidence that hybrid search is worth keeping — and it exists only because of a specific tokenizer decision.** Embeddings alone ranked that chunk 37th, so it would never have been retrieved at any realistic k. BM25 ranked it 4th, and fusion made it 4th overall. The matched terms show why: 243:2 and 243:1 matched only `pool`, while 257:3 and 257:4 matched all four terms. **243:2 does not contain `pool_pre_ping` at all.** It was found solely because the tokenizer emits an identifier's *parts* as well as the whole token (`pool_pre_ping` -> `pool_pre_ping`, `pool`, `pre`, `ping`). With a whole-token-only tokenizer, the query would have been the single term `pool_pre_ping`, it would have matched just the two chunks that literally contain it, and this chunk — the clearest case for hybrid search — would never have surfaced. **Do not simplify the tokenizer to whole tokens only** without re-running this case (and the 230:0 counter-example below, which comes from the same mechanism). Both lists put the prose and the code block at the top; it is the chunk only BM25 (via the parts) could surface that justifies the second ranking. This was also the first time the depth cap (`RRF_DEPTH` = 50) was binding on the embedding list, as expected for a chat with 152 chunks. Negative control: on an unrelated chat, BM25 returned 0 matches and invented none — correct abstention.

  **Counter-example to the 243:2 result — a BM25 false positive (found in the v5 live test, same Supabase chat, same highlight `pool_pre_ping`).** Chunk **230:0**, a pip `ReadTimeoutError`, was **BM25 rank 1 but embedding rank 25**, and it was included in the explain prompt. It is irrelevant to `pool_pre_ping`. **Cause: CONFIRMED.** `__glossHybrid('pool_pre_ping')` shows 230:0 matched on **`pool` only**, which comes from `HTTPSConnectionPool` in the pip `ReadTimeoutError` text, split by the tokenizer's identifier-part rule. So the **same mechanism produced both outcomes** for the same highlight: the win (243:2: matched `pool`, embedding rank 37, genuinely useful) and the loss (230:0: matched `pool`, embedding rank 25, irrelevant, and it still made the prompt). Part-splitting is therefore a **trade-off to measure in v6, not a bug to fix and not a proven win**: v6 should report the net effect on recall@k, MRR and answer quality, for example hybrid with and without part-splitting, on a set of highlights that includes both of these. One highlight each way is an anecdote either way. **Do not change the tokenizer** before that measurement.

  **Also observed in that run:** a 243 chunk appeared as "bm25 only", with no embedding rank at all. First time seen. In a chat with more chunks than `RRF_DEPTH` (here 152 vs 50), "bm25 only" can mean the chunk's embedding rank was past the depth cap, or that it has no embedding record at all; which one it was has not been checked. To tell them apart, rerun with a deeper cap, `__glossHybrid('pool_pre_ping', 5, 200)`, and see whether that chunk then gets an embedding rank.

  **Known open issues carried into v5:**
  - **Virtualization coverage is now the biggest open issue.** The same chat shows "indexed 50 of ~406 messages": only messages that have been mounted in the DOM are indexed or searchable, so retrieval over a long chat is blind to everything not yet scrolled into view. (v3 saw 3 of ~36 without scrolling.) Still unresolved; auto-scrolling was rejected in v3 because it moves the user's reading position.
  - The self-match effect (the highlight's own chunk ranks near the top of both lists) is visible via the "own msg" column but unhandled until v5, which always includes the source message separately and should exclude it from retrieval.
  - A one-word highlight like "it" gives BM25 nothing; `C++`, `$ref` and `@Override` lose their symbols in tokenising; no stemming; formulas still never observed on a real page.
  - The BM25 benchmark numbers are from Node on synthetic text, not Chrome on real chats.
