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
    index.ts      # picks the adapter by hostname (registry.ts); everything outside sites/ goes through it
    claude.ts
    chatgpt.ts    # + chatgptBlocks.ts (message content) and turnSequence.ts (ChatGPT has no absolute message index)
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
- The LLM sits behind the `LLMProvider` interface, so a local model (Ollama or Chrome's built-in Gemini Nano) can be added later without touching other code. Do **not** build those other providers now. The only extra provider planned is Ollama in v13; Gemini Nano is ruled out (see "Decisions already made").
- The adapter must handle two things:
  - messages that are still streaming in (watch the page with a `MutationObserver`),
  - older messages that the site has not loaded onto the page.
- Handle Gemini rate-limit errors (HTTP 429) with retry and exponential backoff. Show a clear message in the popup if a request finally fails.
- Add a debug toggle on the options page that logs the exact prompt sent and its approximate token count.
- **The content script owns retrieval and prompt assembly (from v5); the background worker only sends the finished prompt.** The chunk index lives in the chat page's IndexedDB and the query embedding is relayed from the content script, so the background worker cannot do either. The assembly rules are pure modules in `src/context/` with unit tests; `src/context/gather.ts` is the thin I/O layer.

**Target site for v1:** claude.ai. Support for other sites comes later, through new adapters (ChatGPT in v8, Gemini in v11).

## Build plan: one version at a time

**Workflow rules (important):**
0. **Build order is not numeric order.** v6 (evaluation) is deferred, not cancelled. The order is v7, v8, v9, v10, v11, v12, v13, and then v6 (see "Plan change" below). "The next version" always means the next one in that order, as named in "Current status".
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

### v6: Evaluation — DEFERRED (not cancelled; built after v13, but before applying anywhere)
Postponed so features can come first (see "Plan change" below). It must still happen **before I apply for jobs**, because "did the RAG help?" needs a real answer, and it is the main AI/ML evidence on the resume. **Untuned guesses awaiting this version:** `retrievalK` = 8, the 6000-token prompt budget, and the 180-word chunk ceiling. None of them has been measured. Also awaiting it: BM25 part-splitting (the 243:2 win against the 230:0 loss) and the budget-crowding finding from v5. By the time v6 runs, the prompt may have been touched by v9 and v10 (a "simpler" instruction, follow-up history) and the adapters by v8 and v11, so check that the eval scripts still reuse the real `src/rag` and `src/context` code.
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

## Plan change (decided after v5): features first, evaluation later

I chose to add features before v6. The versions below (v7–v13) are built **one at a time, in order**, with the same workflow rules as v1–v5: build one, stop, I test it live, and only when I explicitly say so move on. They are not a batch. Do not start any of them early. Each version gets its own plan under `docs/superpowers/plans/`.

### v7: Browser compatibility
- Verify the extension works in **Brave, Opera and Vivaldi**. All three are Chromium-based, so the existing build should load unpacked.
- **I test all three myself first and report what breaks.** Do not guess at fixes before I report.
- Likely trouble spots: Brave Shields blocking the Gemini call, and Brave's storage partitioning affecting IndexedDB or the offscreen document.
- **Done when:** the explain flow works in all three, or the ones that don't are written up as known limitations with the reason.
- **Status: COMPLETE. No code changes were needed** (see the v7 notes under "Current status").

### v8: ChatGPT support
- A second `SiteAdapter`. All claude.ai knowledge lives in `src/sites/claude.ts` behind the `SiteAdapter` interface, so this is the test of that design.
- Expect to answer the same questions v1 and v2 answered for Claude: how to find messages, how to tell user from assistant, how to locate code blocks, how to detect streaming, whether the site virtualizes, and whether message ids are stable or positional.
- **I capture real fixtures before any selectors are written, same rule as v1. Never guess selectors.**
- **Deliberately before the popup features.** Every popup feature built against claude.ai alone risks baking in Claude-specific assumptions; a second site surfaces those early. Anything Claude-specific that leaks out of `src/sites/` is a bug to fix here (v5's `data-index` contiguity check is one such place: check it still holds for a site with different or no virtualization).
- **Done when:** highlighting on chatgpt.com gives a correct explanation, with chunking, indexing and retrieval working on its chats, and claude.ai still works.

### v9: "Simpler" button in the popup
- One click regenerates the explanation at a simpler level.
- It **rebuilds from the original prompt with a different instruction**, not by paraphrasing the explanation already shown, so the retrieved context is kept (and retrieval does not need to re-run).
- Pressing it repeatedly keeps getting simpler, so it tracks a **level**, not a flag.

### v10: Follow-up questions in the popup
- A text box so I can ask a question about the explanation without leaving the popup. This is the core problem the whole project exists to solve, so it matters.
- **Open questions to settle in its plan:**
  - popup sizing and scrolling for a thread,
  - how much history each follow-up carries, and the budget cap for it,
  - whether retrieval re-runs per question,
  - whether the thread survives closing the popup.
- **Stretch goal for later (not part of v10 unless I say so):** highlighting text inside the popup's own answer to go a level deeper.

### v11: Gemini support
- A third `SiteAdapter` (gemini.google.com), same approach as v8, including captured fixtures first. It comes after ChatGPT so the general lessons from the second site are already learned.
- Careful with naming: "Gemini" is both a chat site and our LLM. The adapter is the site; `src/llm/gemini.ts` is the API.

### v12: Popup UI improvements
- After v9 and v10, because those change what the popup has to hold. Scope is set in its plan.

### v13: Local model option (Ollama)
- A second `LLMProvider` I can select on the options page, alongside Gemini. Needs: provider choice, Ollama URL, model name, a test-connection button, and clear errors for **Ollama not running**, **`OLLAMA_ORIGINS` not allowed**, and **model not pulled**.
- `OLLAMA_ORIGINS` is where users will get stuck: the error message must say exactly what to set and how.
- Consider a per-provider token budget, since local models read less at once.
- **Last on purpose:** it is the feature least likely to improve the tool for me. I'm happy with Gemini, and a local model would be slower and weaker. It's for other users and for proving the provider abstraction.

## Decisions already made (do not revisit unless I raise them)

- **Gemini Nano is NOT being built.** Decided against for now. (The Ollama provider in v13 is the only extra provider planned.)
- **Routing requests through my claude.ai session is NOT being built.** It is fragile, against the terms of service, and worse on a resume.
- **The API key stays.** The Gemini free tier costs nothing, so a key is friction, not cost. Do not propose removing it or adding a backend to hide it.
- **Multi-site support is a goal.** It is what makes the `SiteAdapter` abstraction worth having, and it is the strongest item on the resume. But **each site is its own version, not a batch.**
- **v6 is deferred, not cancelled.** It must happen before I apply anywhere. The k=8, 6000-token budget and 180-word chunk ceiling stay untuned guesses until then; do not "tune" them by feel in the meantime.

## Later ideas (not scheduled; do not build unless asked)

- Highlighting text inside the popup's own answer, for a nested explanation (the stretch goal under v10).
- A personal glossary of every term the user has looked up.

## Known limitations (be upfront about these)

- The extension only sees text that is on the page. It cannot see the chat site's hidden instructions, its memory, the full contents of uploaded files, or older messages that haven't been loaded.
- claude.ai virtualizes long chats (it un-mounts rows that scroll far out of view), so the chunk index only covers messages that have actually been in the DOM at some point — a very long chat you haven't scrolled through yet won't be fully indexed until you do. **The gaps are not just "the old messages".** Observed live on the long Supabase chat (v5 test): the mounted rows were `29–36`, `217`, and `403–405`, three disconnected islands, including a lone message `217` far from anything on screen. So the index can have arbitrary holes in the middle of a chat, not only a missing beginning, and a hole can sit right next to a highlight.
- Gemini is a different model from the one that wrote the answer, so it interprets the text rather than "remembering" what was meant.
- Site HTML changes can break the adapter. **Supporting three sites (v8, v11) triples that maintenance:** when any one of them redesigns, only that site's adapter should need fixing, but each of the three can break independently and at any time. **Each site needs its own captured fixtures** in `fixtures/` (real HTML, never hand-written for selector work), and the adapter's selectors are checked against them.
- Free-tier limits can change, and Google may use free-tier inputs to improve its models.
- **Retrieval widens what leaves my machine.** Before v5, only the nearby messages went to Gemini. Now any chunk of the chat can be sent, including credentials, API keys or tokens I pasted into a chat much earlier. No redaction is built; this is a known, accepted risk. `__glossPrompt()` shows exactly what a click would send before I click.
- **ChatGPT (v8): a stale tail can survive an edit.** ChatGPT's page has no "last message" marker, so `getLastMessagePosition()` returns `null` there and the stale-tail cleanup never runs. If you edit an early message and the new branch ends up shorter, chunks of the discarded branch beyond the new end stay in the index and can be retrieved, until a message is later indexed at that position. Accepted on purpose, the same call v2 made for a message vanishing from the middle of a chat; no layout-geometry workaround. The coverage line also shows no chat total on ChatGPT.
- **ChatGPT (v8): the index lives for one page load.** Positions only mean something inside one load, so reloading the tab (or opening the chat in another tab) starts an empty index for that chat and removes earlier loads' rows. Retrieval on ChatGPT covers only what you have scrolled through since the page loaded, and ChatGPT shows just 3-12 turns at a time. A window you jump to with the scrollbar, which touches nothing already indexed, still gets an explanation, but from nearby messages only (the popup says so) and it is not indexed. When that window later connects, only the turns mounted at that moment are indexed. The first turn on screen always reports "nearby messages not loaded", because the start of the chat cannot be known (no geometry check, on purpose). A message still being written cannot be explained until it finishes. Option C (persisting the turn-to-position map so the index survives a reload) is not built; I will decide after living with this.
- **ChatGPT code indentation: verified live (2026-10-18).** Leading indentation is real spaces in the `.cm-line` text; three Python blocks showed nesting of 0/4/8/12/16 spaces. The captured fixtures cannot show this and must not be used for it: they were pretty-printed by the editor when saved (CRLF, wrapped text, runs of spaces collapsed to one). Trust a fixture for STRUCTURE (gaps, line counts, which elements exist), never for the whitespace inside a line.
- **ChatGPT (v8): a second tab of the same chat removes the first tab's rows for it.** Each page load has its own rows (so two tabs can never mix numberings), and a load removes earlier loads' rows once, when it first uses the index. The first tab notices that its message records are gone and re-indexes what it still shows; chunks it had indexed from turns that are no longer on screen are lost until they are scrolled to again. Retrieval there is thinner, not wrong.
- **ChatGPT extraction reads some nested shapes approximately.** Text before and after a nested list inside one list item is joined into one item (its order relative to the nested items is lost); image alt text is not read.
- **ChatGPT (v8): long code blocks are not read.** A code block that CodeMirror only partly rendered (it has a `.cm-gap`) becomes a constant placeholder in the index and in the prompt's message text, so it can't be retrieved and the answer does not see its code, except through the highlight: the paragraph around a highlight is the run of rendered lines around it, with a marker where the code continues off the page. The popup says "code in this message is only partly on the page". Reading the full code would need scrolling the block, clicking Copy, or reading CodeMirror's state from page JavaScript; all three were ruled out (they move what the user is looking at, interact with the page, or reach into page internals). A code block with nothing rendered yet gets the same placeholder.
- **ChatGPT (v8), OPEN ITEM: a turn with a question and no answer body.** Seen once in a live probe (three consecutive turns of a 10-turn chat, since not reproduced). Handled either way: the turn is numbered, its question is indexed and sent as nearby context, its neighbours are unaffected, and a selection inside any part of it that is not the question explains why in the popup instead of doing nothing. **Not known:** whether those answers are genuinely absent (a cancelled generation, or messages sent back to back) or rendered under an attribute `[data-dil-message-id]` misses. If the latter, those answers are invisible as context (incomplete, not misplaced). **Trigger to reopen:** an "unfamiliar message layout" popup on something that looks like a normal answer; its console log already lists the turn\'s attribute names, and the probe in the v8 plan\'s results section prints the rest. Then capture that turn as a fixture, unformatted, and add the selector.
- Desktop Chromium browsers only: Chrome, plus Brave, Opera and Vivaldi (verified in v7). No Firefox or Safari.

## Communication with the user

- Explain things in simple, plain language, but still properly and in detail.
- When making a technical choice, say why in a sentence or two.

## Development gotchas

- **STALE CONTENT SCRIPT — reload the claude.ai tab after every extension reload.** Refreshing the extension on `chrome://extensions` does *not* replace the content script already injected into an open claude.ai tab. The old one keeps running, pointed at an extension context that no longer exists, and fails with `chrome-extension://invalid` errors and "Could not establish connection. Receiving end does not exist." This cost a lot of time during v3 (it looked like a second bug after the first was fixed) and **will happen again** after every `npm run build` + extension refresh. First thing to do when anything messaging-related fails: reload the tab, then re-test. Only chase a real bug if it survives a tab reload.

- **"IT ISN'T UTF-8 ENCODED" CAN MEAN A UNICODE NONCHARACTER, NOT BAD BYTES.** Chrome refused v8's first build ("Could not load file 'content-scripts/content.js' for content script. It isn't UTF-8 encoded. Could not load manifest.") although the file decoded as valid UTF-8, had no BOM and no null bytes. It contained one U+FFFF, a Unicode noncharacter, which Chrome rejects (as it does U+FFFE, U+FDD0 to U+FDEF in any plane, and lone surrogates). The "could not load manifest" half was only a knock-on of the content script failing. The character was a range-query upper bound in `src/rag/store.ts`: it had been typed as an escape and was saved into the source as the raw character, then copied into the bundle.
  - Never use U+FFFF (or any noncharacter) as a sentinel. The upper bound of "all keys starting with a prefix" is `prefixRangeEnd(prefix)` in `src/rag/namespace.ts`.
  - `npm run build` now ends with `scripts/check-build-output.mjs` (the `postbuild` script), which scans `.output/` for exactly these characters and fails the build. It reproduced the failure before the fix.
  - To debug this error, strict-decode the built file and scan its code points; looking at the bytes (BOM, nulls, size) cannot find it.
  - Some editing tools turn a typed `\uXXXX` into the raw character. If a build suddenly will not load, scan the sources for stray noncharacters too.
- **RECURRING FAILURE MODE: a well-formed prompt with the wrong content in it, and no error.** The worst bugs in this project don't crash or log anything; they send Gemini a plausible prompt with the wrong content (or the right content in the wrong order), and the explanation just comes out subtly off. **This has now happened five times in the list below, plus one caused by a fix (the bullet after the list), and no test caught any of them. Each was found by reading (live output, or the code and design), not by running anything. It is a pattern, not a coincidence:**
  1. **v5, the island bug.** Reading "the previous message" by DOM adjacency across claude.ai's virtualization gaps (a highlight in 217 got message 126 as its question). Found by reading the live `__glossPrompt()` report and probing the page (see v5 notes).
  2. **v8, `Number(id)`.** The pipeline silently assumes a message id is a numeric position (`Number(messageId)` in the chunker, the indexer and the prompt's before/after labels), but the type was just `string`. A site uuid (ChatGPT's DOM has only those) gives `NaN`, scrambles chat order and labels excerpts with a uuid, all with a well-formed prompt and nothing logged. Found by reading the code and the ChatGPT fixtures while planning, before any ChatGPT code existed. Now enforced: `positionFromId` / `firstNonPositionId` in `src/rag/positionId.ts`, checked in the indexer and in the Explain path, and documented on `SiteMessage.id`.
  3. **v8, two tabs sharing IndexedDB.** ChatGPT's positions are only valid for one page load (they are assigned from the mounted window), but the chunk index lives in IndexedDB, which every tab of the site shares, under keys (`<chat id>:<position>:<chunk>`) that assumed one numbering per chat. Two tabs of the same chat, or a reload while an old tab lives on, would have written the same rows in different numberings: chunks in the wrong order and one tab's text under another's positions, a well-formed prompt, nothing logged. Found in a self-review of the design, before any live use. Now structural: on ChatGPT the conversation id is `<chat>~<page load token>` (`src/rag/namespace.ts`), each load has rows of its own, and a load removes earlier loads' rows of that chat.
  4. **v8, the numbering changes while a prompt is being built.** `prepareExplainPrompt` read the chunk index after the ids of the highlight were read, with a query embedding of up to 8 s in between. If the chat was renumbered in that gap (an edit, a conflict), the index was rewritten under the new numbering and the prompt mixed the two: the source message came back as its own "excerpt" under another id, with a wrong before/after label, and no note. Found by the independent review, reproduced in a simulation and then in a test of the real function. Now structural: after every await that touches the index, `generationIsCurrent` is checked again, and if it fails nothing from the index is used and the popup says the chat changed while the explanation was being prepared.
  5. **v8, long code blocks on ChatGPT.** Code is a CodeMirror editor, and CodeMirror renders only the lines near the viewport; the rest is a `.cm-gap` spacer with an explicit height. Read as plain `.cm-line`s, a long block was indexed as if it were the whole code with most of it missing (probe: four blocks stuck at exactly 36 lines, one with a gap of 17740 px, roughly 880 lines), looked like a normal code chunk, and changed whenever the rendered window changed, so it also re-chunked and re-embedded a different slice each time. The reviewer predicted the possibility; a live probe (`.cm-gap` count) proved it. Now structural: a block with a gap is never read as code (see the v8 notes, "Windowed code").

  The common shape: code that reads neighbours, ids or order from the page, that converts an id to a number, **or that stores something under a key which assumes a single writer or a single numbering,** has an unstated assumption that holds on the site it was written for. **Treat every such assumption as suspect when a new site or a new data shape arrives.** Check that what was found is really what was asked for (for example `data-index` continuity, ids that are positions), and when it can't be verified, say so in the debug report or refuse, instead of substituting the nearest thing. The `__glossPrompt()` report exists to catch this: read the message numbers in it, not just the text. Since tests have not caught either one, a new adapter's live verification must include reading a real prompt report, not only a green test run.

- **A FIX FOR THIS CLASS OF BUG NEEDS CHECKING FOR THE SAME CLASS OF BUG.** The two-tab fix (item 3 above) purged earlier page loads' rows on every wipe, to avoid stale data. An independent review found that this created a new instance of the same failure: when tab 2 started it deleted tab 1's rows, but tab 1's in-memory cache still said its chunks were embedded (same text hash), so tab 1 never embedded them again. Its retrieval silently became keyword-only while the popup still said "N excerpts from elsewhere in the chat". The safeguard against one silent failure had caused another. **Purging aggressively to avoid stale data trades one silent failure for another whenever anything holds a copy of what was purged** (a cache, a pass already in flight, another tab).
  - After writing a fix for this class, ask the same questions of the fix: who else holds a copy of what this deletes or renumbers, and how will they find out?
  - Purge as little as possible. Earlier loads' rows are now removed once per page load, not on every reset.
  - Whatever caches facts about stored rows must drop or re-verify them when the rows can vanish behind it. The embedding-status cache now forgets a message's chunks whenever the message has no record.
  - A fix to shared state wants a reviewer who did not write it. My own review of the design found the original hole and missed this one.

## Current status

- **Current version:** v8 (ChatGPT support), **built on branch `v8-chatgpt`, waiting for my live test** (not merged, not marked complete). Plan: `docs/superpowers/plans/2026-10-14-highlight-explainer-v8.md` ("Scheme B tasks" and the live checklist at its end). ChatGPT's DOM has no absolute message index (probe rounds 1-3), so its positions are assigned from the contiguous mounted window by `TurnSequence` and are valid for one page load; see the v8 notes below. 364 unit tests pass. An independent whole-branch review found seven issues; all are fixed (see "Review of v8" in the notes).
- **Completed versions:** v1, v2, v3, v4, v5, v7 (v6 is deferred, not done)
- **Remaining order:** v8, v9, v10, v11, v12, v13, then v6 (deferred; see "Plan change")
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

  **What was built (v5):** Retrieval now reaches the prompt. On an Explain click the content script reads the page and the chat index (IndexedDB), and builds the whole prompt; the background worker only sends it to Gemini. The prompt has the always-include material (the highlight, its paragraph, the source message, the user question that produced it, and the N nearby messages, default 2), then fused excerpts (embedding + BM25 + RRF, the v3/v4 code) in chat order with speaker and before/after labels, within a 6000-estimated-token budget (characters ÷ 4) and at most `retrievalK` excerpts (default 8). If the whole indexed chat fits the threshold (default equal to the budget), retrieval is skipped and all of it is sent. The popup shows one muted line saying what the answer was based on. `window.__glossPrompt(text?, opts?)` is a free dry run that prints the exact prompt a click would send, with a per-candidate table (embedding rank, BM25 rank, what assembly decided and why), tokens per section and the coverage line; `window.__glossLastPrompt()` reprints the last real one; the debug toggle prints the same report on every click, in the claude.ai tab's console. Settings added: prompt budget, whole-chat threshold, nearby-message count. Code is commit `1a74058`; plan is `docs/superpowers/plans/2026-10-04-highlight-explainer-v5.md`; 188 unit tests. v1–v4 behaviour, `__glossSearch` and `__glossHybrid` are unchanged.

  **Key decisions (v5):**
  - **The content script assembles the prompt.** The chunk index lives in the chat page's IndexedDB and the query embedding is relayed from the content script, so the background worker can do neither. This also gives a free dry run, and the report shows exactly the object that was sent.
  - **The budget covers the whole prompt; `retrievalK` caps excerpts.** The cap exists because the tail of the fused ranking is mostly noise; the budget stays as a ceiling for pathological cases. Both have now been seen binding (see the findings below).
  - **Messages already sent in full are excluded from retrieval before ranking** (source, question, nearby messages), so they don't take slots in the depth-capped lists. This removed the self-match effect v4 showed.
  - **Selection is greedy by fused rank and skips what doesn't fit** (a huge chunk can't block smaller ones). Duplicates (same text hash) are skipped.
  - **A big nearby message is demoted, not trimmed.** Over `RECENT_ALWAYS_MAX_TOKENS` (1000) it is not sent whole and stays in the retrieval pool, so only its relevant chunks can come back. Head and tail of a big message are usually its least useful parts. The question counts as one of the nearby messages and has its own slot; it is never demoted.
  - **Per-item ceilings:** source message 4000 and question 4000 est. tokens (a window around the paragraph, and head + tail), and the highlight's paragraph 400 (windowed around the highlight, because for a code highlight the paragraph is the whole code block, which the message already contains). All use a visible `[… trimmed …]` marker and are listed in the report. The highlight itself is never trimmed. A trimmed message is still excluded from retrieval by id, so its cut part can't be retrieved.
  - **Tags instead of triple quotes** around quoted chat text (a Python docstring breaks `"""`), and our own tag names inside quoted text are defused.
  - **Whole-message text comes from the same blocks the chunker indexes**, rendered by one shared function (`blocksToText`, `src/rag/chunker.ts`), so a whole message and its excerpts can't drift apart and code keeps its newlines. `getMessageText` (flattened) stays only as the indexer's change-detection key. `CHUNKER_VERSION` is unchanged.
  - **Neighbouring messages are checked by `data-index`**, never by DOM adjacency (`contiguousPrecedingRun`, `src/sites/contiguity.ts`, pure and unit-tested; it counts every row, including ones the adapter doesn't recognise).
  - **A retrieval failure never blocks an explanation:** the query embedding has an 8 s timeout, then keyword-only search; an unreadable index falls back to the always-include part alone. Each fallback is named in the report and the popup line.
  - **A missing piece is never silent.** The report and popup line distinguish a question that "isn't loaded" (a gap on the page) from one that "has no readable text", and say "only N of M nearby messages loaded" when a gap cut the list short.

  **What went wrong in testing, and what it taught (v5):**
  1. **A separate whole-branch review before live testing found no critical bug** (message ids line up from the adapter to the stored chunks; the budget math holds), but one important issue: the popup said "whole indexed chat included" and "older messages not loaded" when the index was unreadable or a new chat simply wasn't indexed yet. Fixed, with the smaller review findings.
  2. **A big nearby message crowded the prompt.** Message 255, a whole `models.py` (≈1670 est. tokens, under the first 2000 ceiling), was 53% of a prompt it was irrelevant to. Fixed by demotion, not a lower ceiling (see decisions).
  3. **The empty `<user_question>` was an attachment.** Messages 256 (and almost certainly 184) are attachments ("Pasted text.txt"), not typed text, so `[data-testid="user-message"]` had nothing to read. **Confirmed.** An empty question is no longer sent and the report warns about it. The extension still can't see attachment contents.
  4. **Code arrived flattened to one line, with the language label glued on** (`pythonfrom …`), because message text came from `textContent` with all whitespace collapsed. The label is a separate element outside `<pre>`, so the block path never includes it. Fixed with `blocksToText`.
  5. **A code highlight's paragraph was the whole code block, sent in addition to the message that contains it.** Fixed with the 400-token window.
  6. **A v1 bug, found during v5 testing: the adapter walked across virtualization gaps.** `getUserQuestionFor` and `getRecentMessages` (unchanged since v1) walked DOM siblings without checking that `data-index` was consecutive. A live probe showed `217 <- DOM previous row: 126` and `403 <- DOM previous row: 217`, same parent, so a highlight in 217 would have got message 126 as "the question that produced it", labelled `message_number="126"`, plus recent messages 126/125/124. The prompt was well-formed and nothing errored: the wrong part of the conversation, silently. See "Development gotchas" for the lesson.

  **Confirmed live on claude.ai (v5), 7 tests on the Supabase chat unless noted:**
  1. **Demotion: passed.** Highlighting in 257 produced no `<recent_messages>` section at all (255 correctly demoted). The freed budget went to relevant excerpts, 239, 245, 246, 247, 249, 250, 251 (the connection-troubleshooting thread), in chat order. A clear improvement over the earlier run.
  2. **Code line breaks: passed.** SCSS and Python arrive with real newlines and indentation, and no glued-on language label.
  3. **Paragraph cap: passed.** Highlighting inside the big `models.py` block gave "WARNING: paragraph hit its size ceiling and was trimmed", paragraph = 411 est. tokens.
  4. **Empty question: passed, cause identified** (attachment, above).
  5. **Gap fix: could not be reproduced live.** Tried three times. Any action that brings a message into view (scrolling, `scrollIntoView`) loads its neighbours and closes the gap first, so the broken state is hard to reach by hand. The contiguity rule is verified by unit tests, and the adapter walk was checked once against the saved fixtures with simulated gaps (a throwaway check, not kept in the repo). **Not verified live.**
  6. **Explanation quality: passed.** Explanations are better than before. Example: highlighting `Column(Integer, primary_key=True, index=True)` gave an accurate, clear explanation of all three parts.
  7. **Regression: passed.** `__glossSearch` and `__glossHybrid` print as in v4, including the coverage line.

  **Findings recorded for v6:**
  - **Budget exhaustion in code-heavy chats.** One run hit 5977 of 6000 est. tokens, with excerpts alone at 3458 for 7 chunks, and dozens of candidates rejected as "too-big — needs 281, only 14 left". Chunk 243:2 (the one that explains `create_engine`) was rejected that way at fused rank 76. So large code chunks can crowd out small relevant ones. Both constraints have now been seen binding: k=8 with budget to spare (earlier run: 8 excerpts, about 2800 tokens unused), and the budget with k to spare. Nothing was changed; v6 should vary k and the budget together.
  - **More fusion evidence, on a different chat.** `__glossHybrid('connection pooling')` showed 45:0 at embedding rank 38 / BM25 rank 5 → fused 5, and 45:7 at embedding 20 / BM25 2 → fused 4. The same pattern as 243:2, now on a second chat. Read together with the 230:0 false positive in the v4 section, it is still two or three anecdotes, which is exactly what v6 must turn into numbers.
  - **Coverage scales with chat length:** 51 of 64 messages indexed on a short chat (80%) against 134 of 406 on a long one (33%).

  **Known open issues carried into v6** (none of these blocked v5):
  - **Virtualization coverage** is still the biggest limit, and the holes are arbitrary (see Known limitations). When a gap sits next to a highlight, the prompt now says so, but that path has only been tested off the live site.
  - **Attachments are invisible.** A user message that is an attachment has no readable text and its contents can't be seen; its question is omitted with a warning.
  - **Pasted multi-line user text may be flattened.** Claude.ai puts a user's text in one `<p>` with `whitespace-pre-wrap`, and the shared block text collapses newlines in non-code blocks. Unverified on a real message. Fixing it would change chunk text, so it needs a `CHUNKER_VERSION` bump and a re-embed; deliberately not done on a suspicion.
  - **The cause of the "bm25 only" 243 chunk is unchecked** (embedding rank past the depth cap, or no embedding record; see the v4 section for the check).
  - **Large code chunks can crowd the budget** (above), and `k=8` and the 6000 budget are untuned defaults.
  - **Estimates are characters ÷ 4,** which undercounts code and non-Latin text; v6 will use the API's real usage counts.
  - **BM25 part-splitting is an unmeasured trade-off** (243:2 win, 230:0 loss); the tokenizer was not changed.
  - Carried from v4: a one-word highlight like "it" gives BM25 nothing; formulas have still never been observed on a real page.

  **What was done (v7): browser compatibility. No code changes.** The existing Chromium build, loaded unpacked, works in **Vivaldi, Opera and Brave**. No browser-specific code was needed, and none was added. I tested all three myself. Four checks passed in each browser: indexing, offscreen document present, `__glossSearch`, and Explain. **Brave passed with Shields ON**; there is no need to turn them off. The two trouble spots predicted in the plan (Shields blocking the Gemini call, storage partitioning breaking IndexedDB or the offscreen document) did not happen. Because nothing was built, v7 has no plan file and no commit besides this doc update.

  **Two harmless warnings seen in Vivaldi** (both known; ignore them, they are not bugs):
  1. `options.html` shows modulepreload warnings ("cross-world extension resource mismatch" / "preloaded but not used"). This is build-output noise from WXT/Rolldown; the page works fine.
  2. The `ort-wasm` Cache API warning ("Failed to cache ort-wasm-simd-threaded.asyncify.wasm: Request scheme 'chrome-extension' is unsupported"), already recorded under v3.

  **Not covered by v7:** only these four browsers on desktop; Edge was not tested (it is Chromium too, so it is expected to work, but that is an assumption, not a result). The stale-content-script trap (see "Development gotchas") applies in every one of these browsers: reload the chat tab after refreshing the extension.

  **What was built (v8): ChatGPT support (on `v8-chatgpt`, waiting for my live test).** A second `SiteAdapter` (`src/sites/chatgpt.ts`, content in `chatgptBlocks.ts`), registered for chatgpt.com (`src/sites/index.ts`, the content script's `matches`). Claude is untouched: a golden test written first, against unmodified `claude.ts`, pins its output on the real fixtures (`linkedom` added as a devDependency, with my approval) and has not changed.

  **Key decisions (v8):**
  - **No absolute index exists in ChatGPT's DOM.** Three live probe rounds: `fallback-turn-N` renumbers as the window moves (the same turn was `fallback-turn-0` and later `-5`), some turns carry a UUID instead, heights of the same turn change between runs. What does hold (a 27-turn sweep, 1047 samples: one chain, 0 conflicts; a fast drag: 2 chains, 5 jumps, 0 conflicts): the turns mounted at one moment are consecutive in the chat, and `data-turn-key` is a stable per-turn identity within a session.
  - **Positions come from `TurnSequence` (`src/sites/turnSequence.ts`, pure, 20 tests).** The first window is the base (slot 5000); a window containing a known turn is numbered from it by distance; a window containing none is *detached* (window-local numbers from 100000, nothing stored, not indexed); a disagreement (a known turn at another distance, or a different turn wanting an occupied slot, which is what an edit looks like) is a *conflict*: the frame is thrown away, the current window becomes the new base, and the conflict is counted forever so a note stays visible. Message id = `slot*2` (user) or `slot*2+1` (the turn's answer), so the id contract, the chunk id format, the schema, the chunker and `CHUNKER_VERSION` are all unchanged. The prompt's message numbers on ChatGPT are arbitrary but consistent.
  - **The index is per page load and per tab.** `getConversationId()` returns `<chat>~<load token>` (`src/rag/namespace.ts`): IndexedDB is shared by every tab, and two tabs of one chat numbering independently would otherwise write the same rows. A generation gate (`src/rag/generationGate.ts`, `generation.ts`) wipes a chat's rows when the adapter's numbering generation changes, and purges earlier loads of the same chat on first use. It runs before any read or write (indexer and `prepareExplainPrompt`), and the indexer abandons a pass if the numbering changes mid-pass.
  - **Visibility, as decided:** an `OrderStatus` (`retrieval`, `note`, `indexGeneration`) flows `RawFocal` -> `FocalInput` -> `PromptReport.orderNote` -> the popup's muted line (first in the line) and a WARNING in the console report. It says when the window is not connected to the indexed part (retrieval is then switched off and the index is not read) and, for the rest of the page load, that the chat changed earlier and the index was rebuilt. The prompt text is unchanged. This was the one deliberate edit to `src/context/`, optional fields only; claude.ai output is identical.
  - **A message still being written is left out of the frame** (the window is cut at the first turn whose state is `in_progress`), because its key might change when it finishes; the adapter watches the list itself (throttled to 100 ms), because the indexer is debounced by 800 ms and fast scrolling would otherwise skip windows and lose overlaps.
  - **Content extraction** (`chatgptBlocks.ts`, 25 tests against the four fixtures plus hand-built DOMs): code in its four shapes (CodeMirror lines, `<pre>`, bare `<code>`) read once without the Run/Copy header; KaTeX formulas written once as TeX (the DOM holds each one three times); tables as one `list-item` per row; user text with its line breaks. **First time formulas have been seen on a real page.** Claude's block logic, run on these answers, captured only 80-94% of the text and none of the CodeMirror code.
  - **Found by reading, not by a test (see the recurring failure mode):** `Number(id)` assuming positions (planning), and two tabs of one chat sharing IndexedDB rows in different numberings (self-review of the design). Both are now enforced or removed structurally.

  **Still to verify live on chatgpt.com (v8):** see the live checklist at the end of the plan. The ones most likely to bite: that the key of a turn does not change when its answer finishes (otherwise every message you send would look like a conflict), that switching chats in the sidebar without reloading keeps ids and index with the chat you are in, that code indentation survives, that ChatGPT's own selection overlay does not hide the Explain button, and a real `__glossPrompt()` report whose message numbers and neighbours I have read.

  **Review of v8 (an independent, fresh-context reviewer, before the first live test).** It traced the Explain click, the indexer, the generation gate and the Claude path end to end and found no Critical issue; the id contract, detached windows, the retrieval-disabled path and Claude's behaviour held. Seven findings, all fixed with a failing test first (commits `d6245a2`, `42d9481`, `681ac4d`, `d634b20`):
  - **F1 (Important)** the numbering could change between reading the ids and reading the index (see item 4 of the failure-mode list).
  - **F2 (Important)** caused by the two-tab fix itself (see the lesson after the failure-mode list).
  - **F4** `rankChunks` now ignores a vector whose `chunkTextHash` differs from the chunk's own (a re-used chunk id could be ranked with another message's vector). This is shared code, so it also applies to claude.ai; it can only remove wrong matches, and the Claude golden test is unchanged.
  - **F5** `SiteAdapter.isMessageCurrent`: the indexer checks that a DOM element is still the message before it reads it and before it writes, in case the page recycles rows.
  - **F7** the indexer read the chat id before an await and the messages after it; now both in one tick. The ChatGPT adapter also requires every turn's chat id to agree with the URL.
  - **F3, F6** extraction no longer drops text beside block children or glues words at block boundaries, a code block inside a quote is kept; the `__gloss*` console helpers go through the generation gate.
  - Test infrastructure added on the way: `vitest.config.ts` (the `@/` alias), `runIndexPass` exported for tests only, and in-memory harnesses for `prepareExplainPrompt` and the indexing pass (storage, embedder and site mocked). These I/O layers had no tests before, which is why none of these were caught earlier.

  **Windowed code (v8, found by live probe A5).** Detection is exact: `.cm-content .cm-gap` exists with an inline `height` (fixture `fixtures/chatgpt-long-code.html`: a first line, a 10340 px gap, 72 lines, a 6660 px gap). Complete blocks (15 and 18 lines) have no gap; the window can have a gap on both sides, so rendered lines are grouped into runs that are never joined. What was built (`chatgptBlocks.ts`, 16 tests in `chatgptWindowedCode.test.ts`): a windowed block, or one with nothing rendered, is one constant paragraph, `PARTIAL_CODE_PLACEHOLDER` (a paragraph so it merges into the prose chunk instead of becoming a code chunk of its own; constant so scrolling never changes the hash); `getParagraphAround` returns the run around the highlight with `CODE_ABOVE/BELOW/BETWEEN_NOT_ON_PAGE` markers; `getOrderStatus` adds the popup note when the source message contains one. The note rides the existing `OrderStatus.note` channel, so the console warning label there is now "page note:" rather than "message order:". Not built, on purpose: merging windows over time (CodeMirror lines have no numbers in the DOM, so a wrong merge would be silent). Whether the window depends on page scroll or on scrolling inside the block is NOT established (two probe runs gave identical numbers, an earlier run saw 36 -> 73); nothing relies on it.

  **A click never ends in silence (v8).** When an Explain click finds a selection that is not inside a message the adapter can read, the popup now says why in one sentence (`SiteAdapter.explainBlockedReason`, optional; `whyNotExplainable` in `content/readFocal.ts`; wired in `content/index.ts`). ChatGPT's reasons: no chat id in the URL; the page and URL disagree about which chat this is; the text is not part of a chat message; the message is still being written; messages above it are still being written; the turn has more than one answer body; or an unfamiliar message layout (an action bar, or an answer rendered under an attribute we do not know). It also logs the turn's STRUCTURE only (attribute names, counts, state), never its text, so a layout can be captured as a fixture and taught. A message that was found but refused by the id guard says so too. claude.ai has no such hook and behaves as before (the click does nothing in those cases). Found by the A4 live probe: three consecutive turns have a question and no answer body, and highlighting in anything there opened nothing.

  **Unrendered code blocks (v8, live probe).** On one page 5-6 of 14 code blocks had no `.cm-line` at all. A zero-line count does NOT by itself mean "not drawn": the same markup family also has `<pre>` and bare `<code>` shapes, which the line-count probe reports as empty and the extractor reads fine. A block with no lines, no `<pre>` and no `<code>` is treated like a windowed one: the same constant placeholder, and `hasUnreadCode` (windowed OR nothing read) now drives the popup note, so a message whose code is not drawn at all is flagged too (before, only the gap case was). Open: why so many are empty; the probe in the plan's results section prints each empty block's shape, whether it is on screen and its `content-visibility`, which should separate "off screen, not drawn yet" (expected, fills in when scrolled near) from "empty although visible" (a real problem).

  **Resolved (live classification probe, 2026-10-18): the "empty" code blocks were a probe artefact.** The earlier probe counted only `.cm-line`. All 14 blocks on that page were readable: 9 editor-line blocks, 3 `<pre>` (253-296 characters), 2 bare `<code>`. The real truncation is the blocks with a `.cm-gap` (four of them). The "not drawn at all" placeholder and its popup note stay as a safety net but have not been seen in practice; read the "Unrendered code blocks" paragraph above in that light.
