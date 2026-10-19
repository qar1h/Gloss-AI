# v10: Follow-up Questions in the Popup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A text box in the popup lets the user ask follow-up questions about the explanation, as a thread, without touching the main chat, and without the thread being lost to a stray click.

**Architecture:** Each follow-up is one more ordinary `explain-request`: the click-time prompt (v5 assembly, v9 snapshot) is kept byte for byte, and a pure `followUpPrompt` appends the first explanation, the earlier follow-ups that fit a separate thread budget, the new question and a follow-up instruction. A pure state machine (`threadState.ts`, superseding v9's `simplerState.ts`) owns the thread: only finished answers enter it, and Simpler only rewrites the latest one. The per-call port logic moves into `explainCall.ts`, which settles every call exactly once, including when the background drops the connection. The background worker, `src/llm/`, `src/messaging/`, `src/rag/` and `src/sites/` do not change.

**Tech Stack:** TypeScript (strict), WXT, vitest, linkedom (tests). No new dependency.

**Spec:** `CLAUDE.md` → "v10: Follow-up questions in the popup", plus the plan agreed in chat on 2026-10-19 (summarised under "Decisions").

## Global Constraints

- Build only v10. v1–v9 keep working on claude.ai and ChatGPT.
- **Nothing site-specific.** No file in `src/sites/` changes. If site behaviour leaks in, the fix belongs in `src/sites/`.
- `src/background/`, `src/llm/` (the `LLMProvider` interface included), `src/messaging/`, `src/rag/` and `src/context/gather.ts` do not change.
- **The click-time prompt is never re-assembled.** Every section before `task` is byte-identical in every follow-up and at every level. Retrieval does not re-run.
- **Only finished answers enter the thread history**, each in its latest version. Never a failed, partial or replaced answer.
- One Gemini call at a time per popup. Each Send or Simpler press is exactly one call, only on a press.
- `THREAD_BUDGET_TOKENS = 3000` (est. tokens), a named constant, untuned: it joins v6's list next to k=8, the 6000 budget and the 180-word ceiling. `FOLLOW_UP_MAX_CHARS = 2000`.
- The thread lives in memory only, for one open popup. Nothing is written to storage or to the repo.
- Model output still goes through `marked` + `DOMPurify`; the user's question and every error line go in with `textContent`.

## Decisions (agreed 2026-10-19)

1. **Fix the stuck connection first** (v9 known issue): a dropped port, a 60 s silence, and a "done" with no text all end the call with an error.
2. **Popup:** 460 px wide, up to 600 px tall, header / scrolling thread / footer (note + text box). Placed below the highlight, or above it growing upward, never off screen.
3. **History per follow-up:** click-time prompt + first explanation (always) + earlier follow-ups newest-first until the 3000-token thread budget runs out, the **oldest dropped whole**, never cut, never summarised. The new question is always sent. The prompt, report and popup say how many were left out.
4. **No retrieval re-run.** Embedding is local, so a re-run would cost no API calls, but it would change the context mid-thread and re-read the index after a possible ChatGPT renumbering (failure #4 in CLAUDE.md). The follow-up instruction tells Gemini to say so when the answer depends on a part of the chat it was not shown.
5. **The thread does not survive closing.** But **once the user has typed in the box or asked a follow-up, outside clicks no longer close the popup**; only × and Escape do. Losing a long thread to a stray click is the worst failure v10 could have. Escape discarding an unsent draft is accepted.
6. **One level for the whole popup; follow-ups inherit it; Simpler only acts on the latest answer.** Why the second matters: if Simpler rewrote an earlier answer, the history sent with later follow-ups would quote an answer that no longer exists on screen, or the next prompt would carry an answer the later follow-ups never saw: a well-formed prompt with the wrong content, the project's recurring bug.
7. **The thread is quoted text inside the one prompt string**, not Gemini's multi-turn format, so `LLMProvider` stays `streamExplain(prompt: string, signal)` (v13's Ollama provider plugs into the same seam).
8. **The popup position bug is a v1 bug, not a v10 one.** `open()` clamps `top` to `innerHeight - 40`, so a highlight near the bottom of the screen opens a popup that is almost entirely off screen. v10 fixes it as part of the placement work, and it has its own live check (L3).
9. **The level-3 vs "show me the code" conflict is an explicit live test step** (L9), not a watch item: the follow-up instructions say the reader's question comes first, and that wording is unverified.
10. **Selections inside the popup are verified early** (Task 2, right after the connection fix): if a selection inside the popup can bring up Explain and replace the thread with an error, that destroys what v10 exists to protect, so the design must not rest on an unverified assumption about shadow-DOM selection.
11. **Stop after Task 2** and report before building the thread.

## Review Focus

Failure modes the spec implies but obvious tests would miss, most likely first:

1. **A failed, partial or replaced answer is sent as history.** Expected: the history holds exactly the finished answers, each as currently on screen. Pinned by: `threadState.test.ts` "a failed follow-up never enters the history", "Simpler on the latest follow-up replaces only that answer, and the next follow-up carries the new version" (Task 4).
2. **Keys typed into the box reach the chat page** (its global shortcuts, its paste handler attaching our text to its own composer). Expected: nothing typed or pasted in the box has any effect on the page. Pinned by: `popup.test.ts` "keys and paste in the box do not reach the page" (Task 5) and live check L11.
3. **A stray click destroys a thread.** Expected: once the user typed or asked, outside clicks do nothing. Pinned by: `popup.test.ts` "an outside click closes a fresh popup but not one the user has typed in" (Task 5) and live L8.
4. **A late message from an earlier call lands in the current one** (Simpler, then Send, then the first call's straggler). Expected: only the current call's chunks render. Pinned by: `explainCall.test.ts` "ignores everything after it settled" and "ignores messages for another request" (Task 1); the state machine's request numbers (Task 4).
5. **One huge answer swamps the prompt.** Expected: it is dropped whole with everything older; the explanation and the new question are still sent. Pinned by: `thread.test.ts` "a latest exchange bigger than the budget is dropped with everything older" (Task 3).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/content/explainCall.ts` (+ test) | create | One Gemini call over one port: chunks, done with full text, error; settles once; drop, silence and empty answer are errors. Port injected. |
| `src/content/ui/selection.ts` (+ test) | modify | Ignore selections inside our own UI hosts. |
| `src/content/ui/explainButton.ts` | modify | `hostElement()`. |
| `src/context/levels.ts` | modify | `FOLLOW_UP_INSTRUCTIONS`, one per level. |
| `src/context/limits.ts` | modify | `THREAD_BUDGET_TOKENS`, `FOLLOW_UP_MAX_CHARS`. |
| `src/context/thread.ts` (+ test) | create | `followUpPrompt`: base sections + explanation + fitted history + question + instruction. Pure. |
| `src/context/render.ts` | modify | New tag names in the defuse list. |
| `src/context/types.ts` | modify | `ThreadReport`; `PromptReport.thread`. |
| `src/context/assemble.ts`, `simplicity.ts`, `report.ts` (+ tests) | modify | `thread: null`; the v9 `fixedEstTokens` fix; the thread summary lines. |
| `src/content/threadState.ts` (+ test) | create | Popup state machine (supersedes `simplerState.ts`, which is deleted with its test). Pure. |
| `src/content/ui/placement.ts` (+ test) | create | `placePopup`. Pure. |
| `src/content/ui/popup.ts` (+ test) | modify | Thread layout, composer, sticky close, key isolation, placement. |
| `src/content/index.ts`, `promptDebug.ts` | modify | Wiring and debug labels. |

---

### Task 1: Settle every call — the stuck-connection fix

**Files:**
- Create: `src/content/explainCall.ts`, `src/content/explainCall.test.ts`
- Modify: `src/content/index.ts` (the port code inside `startRequest`)

**Interfaces:**
- Consumes: `ExplainToBackground`, `ExplainToContent` from `@/messaging/types` (unchanged).
- Produces:
  ```ts
  export interface CallPort {
    postMessage(message: ExplainToBackground): void;
    disconnect(): void;
    onMessage: { addListener(listener: (message: unknown) => void): void };
    onDisconnect: { addListener(listener: () => void): void };
  }
  export interface CallHandlers {
    onChunk(text: string): void;
    /** The whole answer (all chunks joined). Never empty: an empty answer is an error. */
    onDone(text: string): void;
    onError(message: string): void;
  }
  export interface ExplainCall { cancel(): void }
  export const CALL_IDLE_TIMEOUT_MS = 60_000;
  export const CONNECTION_LOST_MESSAGE =
    'Lost the connection to the extension before the answer finished. Try again; if it keeps happening, reload this tab.';
  export const NO_TEXT_MESSAGE = 'No explanation was returned.';
  export const TIMEOUT_MESSAGE = 'No reply from Gemini for 60 seconds, so I stopped waiting. Try again.';
  export function startExplainCall(
    connect: () => CallPort, prompt: string, handlers: CallHandlers, idleTimeoutMs?: number,
  ): ExplainCall;
  ```
  Behaviour: connects, posts one `explain-request` with a fresh `crypto.randomUUID()` id, and starts an idle timer that every message for this request resets. The call **settles exactly once** (`onDone` or `onError`); after settling or `cancel()`, every later message, disconnect and timer is ignored. `onDisconnect` before settling → `onError(CONNECTION_LOST_MESSAGE)` (Chrome fires it only for a disconnect from the other end, so our own `cancel()` can't trigger it). Timer fires → disconnect the port (aborts the background fetch) and `onError(TIMEOUT_MESSAGE)`. `explain-done` with no chunk → `onError(NO_TEXT_MESSAGE)`. `cancel()` disconnects and clears the timer. If `connect` throws, `startExplainCall` throws (the caller already handles that). 60 s is above the worst case of the background's 429 retries (about 20 s of sleeps in total).

- [ ] **Step 1: Write the failing tests** (`explainCall.test.ts`), with a `FakePort` that records posts and `disconnected`, and has `emit(message)` and `drop()` (fires the disconnect listeners). Use `vi.useFakeTimers()`.
  - `posts one explain-request with the prompt`: one post, `type: 'explain-request'`, `prompt` as given, a non-empty `requestId`.
  - `forwards chunks and finishes with the whole text`: chunks `'a'`, `'b'`, then done → `onChunk` twice, `onDone('ab')`, no `onError`.
  - `a dropped connection before done is an error, once`: chunk, `drop()` → `onError(CONNECTION_LOST_MESSAGE)` once; a later `done` and `drop()` call nothing.
  - `a drop after done is ignored`.
  - `ignores messages for another request`: chunk and done with `requestId: 'other'` → no callbacks.
  - `done with no text is an error`: → `onError(NO_TEXT_MESSAGE)`, no `onDone`.
  - `an error from the background is forwarded, and nothing after it`: `explain-error` then `drop()` → one `onError` with the background's message.
  - `silence for the idle timeout is an error and disconnects`: advance 60 000 ms → `onError(TIMEOUT_MESSAGE)`, port disconnected.
  - `each message resets the idle timer`: chunk at 59 000 ms; no error at 60 000; error at 119 000.
  - `cancel disconnects and silences everything`: `cancel()` → port disconnected; then `drop()`, `done`, and 120 s of timers call nothing.
  - `a throwing connect throws`.

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/content/explainCall.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `explainCall.ts`. Then in `index.ts`, replace `state.port` with `state.call: ExplainCall | null`: `startRequest` cancels the previous call and starts a new one with `connect = () => connectExplainPort()`; close calls `state.call?.cancel()`. `connectExplainPort()` (in `index.ts`) is `browser.runtime.connect({ name: EXPLAIN_PORT_NAME })` plus an `onDisconnect` listener that reads `browser.runtime.lastError` and, when set, logs `[highlight-explainer] explain connection closed: <message>` with `console.warn`. Handler mapping: `onChunk` → `popup.appendChunk`; `onDone` → `popup.markDone()` then dispatch `done`; `onError` → `showError` at level 0, `failRegenerate` above it, then dispatch `error`. This also makes v9's stale-message filter structural (each call ignores everything once it settled or was cancelled).

- [ ] **Step 4: Run everything.** Run: `npx vitest run`, `npm run compile`, `npm run build`. Expected: all pass (405 + the new tests), build ends with `check-build-output` passing.

- [ ] **Step 5: Commit.** `fix(content): settle every Gemini call; a dropped connection, silence or an empty answer is an error`

### Task 2: Selections inside the popup — verify, then guard

**Files:**
- Modify: `src/content/ui/selection.ts`, `src/content/ui/explainButton.ts`, `src/content/ui/popup.ts` (only `hostElement()`), `src/content/index.ts`
- Create: `src/content/ui/selection.test.ts`
- Record: the probe results in "Task 2 probe results" at the end of this plan.

**Interfaces:**
- Produces:
  ```ts
  // selection.ts
  /** True when `node` is one of `hosts`, inside one, or inside a shadow root hosted (at any depth) by one. */
  export function isInsideHosts(node: Node | null, hosts: readonly Node[]): boolean;
  export function getCurrentSelectionInfo(ignoreHosts?: readonly Node[]): SelectionInfo | null; // null when the anchor or focus node is inside a host
  export function onSelectionChange(callback: (info: SelectionInfo | null) => void, ignoreHosts?: () => readonly Node[]): () => void;
  // explainButton.ts and popup.ts handles
  hostElement(): HTMLElement | null;
  ```

- [ ] **Step 1: Probe in a real browser (Playwright, interactive, nothing checked in).** Build a page in the scratchpad: a light-DOM paragraph; a `<highlight-explainer-popup>` host with an **open** shadow root (WXT's default mode, verified in `node_modules/wxt/dist/utils/content-script-ui/shadow-root.mjs`) holding a `<p>` of text and a `<textarea>` with text; a `document` `selectionchange` listener that records, per event: `isCollapsed`, `rangeCount`, `toString()`, `anchorNode` (node name, and whether its `getRootNode()` is a `ShadowRoot`), `getRangeAt(0).startContainer` (same), and the range rect's width/height. Record for each action: (a) mouse-drag over the shadow `<p>`; (b) double-click a word in it; (c) select text inside the textarea; (d) drag from the light paragraph into the shadow `<p>`; (e) whether `Selection.prototype.getComposedRanges` exists. Write the table into "Task 2 probe results".
  **Decision rule:** if (a) or (b) gives a non-collapsed selection with text and a non-zero rect, today's code shows the Explain button for popup text, and on ChatGPT a click would replace the thread with a "not part of a chat message" error. The guard below is built **either way** (it is cheap, and selection in shadow DOM is a moving part of the platform); the probe decides which node shapes its tests must cover. **If the probe shows anything else** (for example a range that starts in the page and ends in the popup, or selection events that report the host instead of the text node), stop and report before Step 2.

- [ ] **Step 2: Write the failing tests** (`selection.test.ts`, linkedom; `attachShadow` works there, checked): 
  - `isInsideHosts`: a text node inside the host's shadow root → true; the host itself → true; a node in a shadow root nested inside the host's shadow root → true; a light-DOM node → false; `null` → false; a node in another element's shadow root → false.
  - `getCurrentSelectionInfo ignores a selection inside our UI`: stub `window.getSelection` to return a non-collapsed selection whose `anchorNode` is a text node inside the host's shadow root and whose range has a non-zero rect → `null` with `[host]`, and the info object without hosts.
  - plus every node shape the probe reported (for example an `anchorNode` retargeted to the host).

- [ ] **Step 3: Run them and confirm they fail.** Run: `npx vitest run src/content/ui/selection.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement.** `isInsideHosts` walks `node` → `getRootNode()`; if the root is a `ShadowRoot`, continue from its `host`; true when any step is contained by (`host.contains`) one of `hosts`. In `index.ts`, pass `() => [popup.hostElement(), button.hostElement()]` (non-null ones) to `onSelectionChange`, and at the top of `handleExplainClick` return early if `isInsideHosts(selection.range.startContainer, hosts)` (belt and braces: the selection could have changed between showing the button and the click).

- [ ] **Step 5: Run everything.** `npx vitest run`, `npm run compile`, `npm run build`. Expected: all pass.

- [ ] **Step 6: Commit.** `fix(content): a selection inside our own popup or button never brings up Explain`

**STOP HERE (agreed 2026-10-19).** Report Tasks 1–2 and the probe results to the user; they can run live checks L1 and L2 now. Wait for the go-ahead before Task 3.

### Task 3: The follow-up prompt (pure context layer)

**Files:**
- Create: `src/context/thread.ts`, `src/context/thread.test.ts`
- Modify: `src/context/levels.ts`, `src/context/limits.ts`, `src/context/render.ts`, `src/context/types.ts`, `src/context/assemble.ts`, `src/context/simplicity.ts` (+ test), `src/context/report.ts` (+ test), `src/context/render.test.ts`

**Interfaces:**
- Consumes: `AssembledPrompt`, `joinSections`, `neutralizeTags`, `estimateTokens`, `SIMPLICITY_LEVELS`.
- Produces:
  ```ts
  // limits.ts
  export const THREAD_BUDGET_TOKENS = 3000;
  export const FOLLOW_UP_MAX_CHARS = 2000;
  // levels.ts
  export const FOLLOW_UP_INSTRUCTIONS: readonly string[]; // one per level, same length as SIMPLICITY_LEVELS
  // thread.ts
  export interface ThreadExchange { question: string; answer: string }
  export interface FollowUpInput {
    /** The first explanation, as currently on screen (its latest Simpler version). */
    explanation: string;
    /** Earlier finished follow-ups, oldest first. */
    exchanges: ThreadExchange[];
    question: string;
  }
  export function followUpPrompt(
    base: AssembledPrompt, input: FollowUpInput, level: number, threadBudgetTokens?: number,
  ): AssembledPrompt;
  // types.ts
  export interface ThreadReport {
    followUpNumber: number;            // 1-based number of this follow-up
    budgetTokens: number;
    explanationEstTokens: number;
    includedExchanges: number[];       // follow-up numbers sent as history, oldest first
    droppedExchanges: { number: number; estTokens: number }[]; // oldest first
    usedEstTokens: number;             // explanation + included exchanges
    questionEstTokens: number;
  }
  // PromptReport gains: thread: ThreadReport | null   (null for Explain and Simpler on the explanation)
  ```

**Exact copy.** New tag names added to `TAG_NAMES` in `render.ts`: `explanation`, `earlier_follow_ups`, `follow_up`, `follow_up_question`, `reader_question`, `previous_answer`. Sections appended after the base sections without `task`, in this order:

- `explanation` (always):
  ```
  The reader was given this explanation of the highlighted part:
  <explanation>
  {neutralized explanation}
  </explanation>
  ```
- `thread` (only when there is at least one earlier follow-up, included or dropped). Inside `<earlier_follow_ups>`: the line `Follow-up questions the reader already asked about it, with the answers they got, oldest first:` when any are included; then, when `d > 0` were dropped, `[1 earlier follow-up question and its answer were left out to save space.]` / `[{d} earlier follow-up questions and their answers were left out to save space.]`; then the included blocks, separated by blank lines:
  ```
  <follow_up number="{n}">
  <reader_question>
  {neutralized question}
  </reader_question>
  <previous_answer>
  {neutralized answer}
  </previous_answer>
  </follow_up>
  ```
- `follow_up` (always):
  ```
  The reader's new follow-up question:
  <follow_up_question>
  {neutralized question}
  </follow_up_question>
  ```
- `task`: `FOLLOW_UP_INSTRUCTIONS[level]`:

| # | instruction |
|---|---|
| 0 | `Answer the reader's new follow-up question (inside the follow_up_question tags). It is about the highlighted part and the explanation they were given, so answer it in that context, in simple, plain language. Use the conversation only where it actually helps. If the answer depends on a part of the conversation you were not shown, say so plainly instead of guessing. Keep the answer focused on what they asked.` |
| 1 | `Answer the reader's new follow-up question (inside the follow_up_question tags) more simply than you normally would: they found a normal explanation too hard to follow. Assume they don't know this topic. Use short sentences and everyday words, and explain any technical term in plain words the first time you use it. Their question comes first: if it explicitly asks for more detail, code or an exact definition, give it, still in plain words. If the answer depends on a part of the conversation you were not shown, say so instead of guessing. Keep it accurate.` |
| 2 | `Answer the reader's new follow-up question (inside the follow_up_question tags) for a complete beginner who has never studied this topic. Use no jargon; if a technical word can't be avoided, say what it means in everyday words. An everyday example or comparison helps. Keep it short. Their question comes first: if it explicitly asks for detail, code or an exact definition, give what they asked for and explain it in plain words. If the answer depends on a part of the conversation you were not shown, say so instead of guessing. Simpler must not mean wrong: leave details out rather than say something untrue.` |
| 3 | `Answer the reader's new follow-up question (inside the follow_up_question tags) as simply as possible, as if to a curious 10-year-old: a few short sentences, no technical words, and one everyday comparison if it helps. Their question comes first: if it explicitly asks for code, detail or an exact definition, give exactly what they asked for, then explain it in the simplest words you can. If the answer depends on a part of the conversation you were not shown, say so instead of guessing. Simpler must not mean wrong: leave things out rather than say something untrue.` |

**Fitting the thread** (the one algorithm the signature does not determine): `explanationCost = estimateTokens(explanation section)`, always included (if it alone is over the budget, warn `the explanation alone (≈{e} est. tokens) is over the {budget} thread budget; sent anyway, so no earlier follow-ups fit`). Walk exchanges **newest to oldest**; each costs `estimateTokens(its <follow_up> block) + 1`; include while `used + cost <= budget`; **at the first that does not fit, stop**: it and everything older are dropped (never skip to an older, smaller one, so the history is always an unbroken run ending at the newest). The wrapper and intro lines are not counted. The question is always included.

**Report:** `prompt`, `sections`, `totalEstTokens` recomputed; `simplicityLevel = level`; `levelExtraTokens = est(FOLLOW_UP_INSTRUCTIONS[level]) − est(FOLLOW_UP_INSTRUCTIONS[0])`; `fixedEstTokens = base.fixedEstTokens − est(SIMPLICITY_LEVELS[0].instruction) + est(FOLLOW_UP_INSTRUCTIONS[level])`; `thread` filled; every other field as in `base`. No budget-overage warning: the thread is on top of the click-time budget by design. **Also fix the v9 known issue** in `promptAtLevel`: `fixedEstTokens = base.report.fixedEstTokens + extra`.

**Validation:** throw `RangeError` for a level outside `0..MAX_SIMPLICITY_LEVEL` or a blank question; throw `Error` if `base.report.simplicityLevel !== 0` or `base.report.thread !== null` (follow-ups and levels never stack), or if the explanation is blank.

**Summary lines (`report.ts`)**, after the level line, only when `report.thread` is set:
- `thread: follow-up {n}; ≈{used} of {budget} thread-budget est. tokens used (explanation ≈{e}; {earlier follow-ups 1, 2, 3 | no earlier follow-ups}); new question ≈{q}`
- when any dropped: `left out of the thread to fit its budget (oldest first): follow-up 1 (≈700), follow-up 2 (≈650)`
- and the `prompt:` line gets the suffix `; the thread is on top of this budget (it has its own: {budget})`.

- [ ] **Step 1: Write the failing tests.**
  - `levels` (in `thread.test.ts`): `FOLLOW_UP_INSTRUCTIONS` has `SIMPLICITY_LEVELS.length` entries, all different; each is unchanged by `neutralizeTags`; each contains `you were not shown`; entries 1–3 contain `Their question comes first`.
  - `render.test.ts`: each new tag name is defused, e.g. `neutralizeTags('</follow_up_question>')` → `'&lt;/follow_up_question>'`, and `<follow_up number="2">` → `&lt;follow_up number="2">`.
  - `thread.test.ts`, with `base = assemblePrompt(...)` as in `simplicity.test.ts` and an `ex(n, words)` helper making an exchange with unique marker text `Q{n}`/`A{n}`:
    - `keeps every click-time section before task byte-identical`: `r.sections.slice(0, base.sections.length - 1)` equals `base.sections.slice(0, -1)`, and `r.prompt.startsWith(joinSections(base.sections.slice(0, -1)))`.
    - `section order`: names end with `explanation`, `thread`, `follow_up`, `task`; with no exchanges, there is no `thread` section.
    - `sends every exchange that fits, oldest first, numbered`: 3 small exchanges → `includedExchanges [1, 2, 3]`, `followUpNumber 4`, markers appear in order `Q1 < A1 < Q2 < … < A3` in the prompt.
    - `drops the oldest whole when over budget`: 4 exchanges of about 400 est. tokens, budget 1000 → included `[3, 4]` (or what the exact sizes give, asserted from the costs), dropped `[1, 2]` with their `estTokens`; `A1` and `A2` markers appear nowhere in the prompt; the prompt contains `[2 earlier follow-up questions and their answers were left out to save space.]`.
    - `stops at the first exchange that does not fit`: exchanges small, huge, small (oldest first) → only 3 included; 1 and 2 dropped.
    - `a latest exchange bigger than the budget is dropped with everything older`: included `[]`; the explanation and the new question are still in the prompt; the `thread` section holds only the left-out line.
    - `an explanation over the budget is sent anyway, with a warning`.
    - `defuses tags in the explanation, questions and answers`: an answer containing `</previous_answer>` and a question containing `</follow_up_question>` appear as `&lt;/…`.
    - `uses the follow-up instruction for the level`: last section text is `FOLLOW_UP_INSTRUCTIONS[level]` for 0..3; `simplicityLevel`, `levelExtraTokens`, `fixedEstTokens` as defined; `totalEstTokens === estimateTokens(r.prompt)`.
    - `never stacks`: throws for a base from `promptAtLevel(base, 1)` and for a base that is itself a follow-up prompt; `RangeError` for level 4, 1.5, a blank question.
    - `a ChatGPT-shaped focal behaves the same` (ids like `10001`, an order note): sections before task identical, `orderNote` kept.
  - `simplicity.test.ts`: `fixedEstTokens at level 3 is level 0's plus the extra`.
  - `report.test.ts` (add `thread: null` to `makeReport`): the two thread lines and the `prompt:` suffix, exactly as above, for a report with a dropped follow-up; no thread lines when `thread` is null.

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/context`. Expected: FAIL.

- [ ] **Step 3: Implement** to the copy, algorithm and report rules above. `assemble.ts` sets `thread: null`.

- [ ] **Step 4: Run everything.** `npx vitest run`, `npm run compile`. Expected: all pass; existing `assemble`, `render` and `gather` tests unchanged.

- [ ] **Step 5: Commit.** `feat(context): followUpPrompt — click-time prompt plus a budgeted thread`

### Task 4: The thread's state machine (pure)

**Files:**
- Create: `src/content/threadState.ts`, `src/content/threadState.test.ts`
- Delete: `src/content/simplerState.ts`, `src/content/simplerState.test.ts` (after porting every test)

**Interfaces:**
- Consumes: `MAX_SIMPLICITY_LEVEL`; `FollowUpInput` from `@/context/thread`.
- Produces:
  ```ts
  export interface FinishedTurn { question: string | null; answer: string } // turns[0] is the explanation (question null)
  export type ThreadPhase = 'first' | 'idle' | 'asking' | 'regenerating' | 'unavailable';
  export interface ThreadState {
    phase: ThreadPhase;
    level: number;              // popup-wide: the level of the latest finished answer
    pendingLevel: number | null;
    request: number;
    turns: FinishedTurn[];      // finished answers only, each in its latest version
    pendingQuestion: string | null;
  }
  export type ThreadEvent =
    | { type: 'press' } | { type: 'ask'; question: string }
    | { type: 'done'; request: number; text: string } | { type: 'error'; request: number };
  export type ThreadSend =
    | { kind: 'explanation'; level: number; request: number }
    | { kind: 'follow-up'; level: number; request: number; input: FollowUpInput; followUpNumber: number; regenerate: boolean };
  export interface SimplerButtonView { visible: boolean; enabled: boolean; label: string; title: string } // moved from simplerState.ts
  export interface ComposerView { visible: boolean; canSend: boolean }
  export function initialThreadState(): ThreadState; // first, level 0, request 0, no turns
  export function threadReduce(state: ThreadState, event: ThreadEvent): { state: ThreadState; send: ThreadSend | null };
  export function simplerButtonView(state: ThreadState): SimplerButtonView;
  export function composerView(state: ThreadState): ComposerView;
  ```

**Transitions** (a `done`/`error` whose `request` is not `state.request` is ignored everywhere; `unavailable` ignores everything; the reducer never mutates its input):
- `first` + done(0, text) → `idle`, `turns = [{ question: null, answer: text }]`. `first` + error(0) → `unavailable`.
- `idle` + press, `level < MAX` → `regenerating`, `pendingLevel = level + 1`, `request + 1`. Send targets **the latest turn**: with one turn, `{ kind: 'explanation', level: pendingLevel }`; otherwise `{ kind: 'follow-up', regenerate: true, level: pendingLevel, followUpNumber: turns.length - 1, input: { explanation: turns[0].answer, exchanges: turns.slice(1, -1), question: last.question } }`. At `MAX`: nothing.
- `idle` + ask(q), `q.trim()` non-empty → `asking`, `pendingQuestion = q.trim()`, `request + 1`; send `{ kind: 'follow-up', regenerate: false, level, followUpNumber: turns.length, input: { explanation: turns[0].answer, exchanges: turns.slice(1), question: q.trim() } }`. Blank: nothing.
- Press or ask in any phase but `idle`: nothing (one call at a time).
- `regenerating` + done(text) → `idle`, `level = pendingLevel`, the last turn's answer replaced by `text` (earlier turns untouched). + error → `idle`, level and turns unchanged.
- `asking` + done(text) → `idle`, append `{ question: pendingQuestion, answer: text }`. + error → `idle`, turns unchanged, `pendingQuestion = null`.

**Views:** `simplerButtonView` keeps v9's table exactly (`first`, `idle` below/at MAX, `regenerating`, `unavailable`) and adds `asking` → `{ visible: true, enabled: false, label: 'Simpler', title: 'Available when this answer finishes' }`. `composerView`: `unavailable` → `{ visible: false, canSend: false }`; `idle` → `{ visible: true, canSend: true }`; every other phase → `{ visible: true, canSend: false }` (the box can be typed in while an answer streams; Send waits).

- [ ] **Step 1: Write the failing tests.** Port every `simplerState.test.ts` case (`done` now carries `text`), then add:
  - `an ask before the first explanation finishes sends nothing`.
  - `a follow-up inherits the level`: press, done(1), ask → send level 1, `followUpNumber 1`, `exchanges []`.
  - `the history is the earlier finished follow-ups, oldest first`: two asked-and-done follow-ups, then a third ask → `exchanges` equals the two, in order.
  - `a failed follow-up never enters the history`: ask, error → turns unchanged; the next ask's `exchanges` does not contain it.
  - `Simpler on the latest follow-up replaces only that answer, and the next follow-up carries the new version`: explanation, follow-up 1 done with `'old'`, press → send `regenerate: true`, `followUpNumber 1`, `question` of follow-up 1, `exchanges []`; done `'new'` → `turns[0]` is the same object as before, `turns[1].answer === 'new'`; next ask's `exchanges[0].answer === 'new'`.
  - `Simpler on the explanation is still the v9 send` while there are no follow-ups.
  - `one call at a time`: ask while `asking` or `regenerating`, press while `asking` → no send.
  - `a blank question sends nothing`.
  - `a stale done is ignored`: a done for an earlier request does not append or replace anything.
  - `composerView` and the `asking` Simpler view, per the table.

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/content/threadState.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `threadState.ts`; delete `simplerState.ts` and its test; point `index.ts` and `popup.ts` imports at `threadState.ts` (behaviour unchanged until Task 6).

- [ ] **Step 4: Run everything.** `npx vitest run`, `npm run compile`. Expected: all pass.

- [ ] **Step 5: Commit.** `feat(content): thread state machine (supersedes the Simpler state)`

### Task 5: Popup layout, placement, composer, sticky close

**Files:**
- Create: `src/content/ui/placement.ts`, `src/content/ui/placement.test.ts`
- Modify: `src/content/ui/popup.ts`, `src/content/ui/popup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // placement.ts
  export const POPUP_WIDTH = 460, POPUP_MAX_HEIGHT = 600, VIEWPORT_MARGIN = 8, ANCHOR_GAP = 6,
    PREFER_BELOW_MIN = 320, MIN_USABLE_HEIGHT = 160;
  export interface Placement { left: number; width: number; maxHeight: number; top: number | null; bottom: number | null }
  export function placePopup(anchor: { top: number; bottom: number; left: number }, viewport: { width: number; height: number }): Placement;
  // popup.ts
  export interface PopupHandlers { onClose(): void; onSimpler?(): void; onAsk?(question: string): void }
  export interface PopupHandle {
    open(anchorRect: DOMRect, handlers: PopupHandlers): void; // no onSimpler / onAsk: that control is hidden
    appendChunk(text: string): void;       // into the latest answer
    markDone(): void;
    showError(message: string): void;      // the first explanation failed
    setSimplerButton(view: SimplerButtonView): void;
    setComposer(view: ComposerView): void;
    beginRegenerate(title: string): void;  // greys the latest answer (v9 behaviour, on the latest turn)
    failRegenerate(message: string): void; // restores it; `Couldn't simplify: …` right above it, thread scrolled to that line
    beginFollowUp(question: string): void; // clears the box; appends the question (textContent) and an answer showing "Thinking…"; scrolls the question to the top of the thread
    failFollowUp(message: string, question: string): void; // removes that turn; `Couldn't answer: …` at the end of the thread, scrolled into view; puts `question` back in the box if the box is empty
    setContextNote(text: string): void;
    hostElement(): HTMLElement | null;
    close(): void;
  }
  ```

**Placement rule:** `width = min(POPUP_WIDTH, vw − 32)`; `left = max(MARGIN, min(anchor.left, vw − width − MARGIN))`; `roomBelow = vh − MARGIN − (anchor.bottom + GAP)`; `roomAbove = anchor.top − GAP − MARGIN`. **Below** (`top = anchor.bottom + GAP`, `maxHeight = min(MAX, roomBelow)`) if `roomBelow >= PREFER_BELOW_MIN`, or if `roomBelow >= roomAbove` and `roomBelow >= MIN_USABLE_HEIGHT`. Else **above** (`bottom = vh − (anchor.top − GAP)`, `maxHeight = min(MAX, roomAbove)`; anchoring by `bottom` makes a growing thread grow upward, away from the highlight) if `roomAbove >= MIN_USABLE_HEIGHT`. Else **overlay** (`top = MARGIN`, `maxHeight = min(MAX, vh − 2·MARGIN)`), e.g. a selection taller than the screen. Placement is computed once, at open; the popup still does not follow page scroll (v1 limitation, unchanged).

**Layout:** `.popup` is a fixed flex column with the placement's inline `left`, `width`, `max-height` and `top` or `bottom`. Children: `.popup-header` (title, Simpler, ×); `.popup-thread` (`flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; position: relative`), holding the explanation's `.popup-answer`, then per follow-up a `.popup-question` (muted bubble, `white-space: pre-wrap`, text via `textContent`) and its `.popup-answer`; `.popup-footer` holding `.popup-note` and `.popup-composer` (a `textarea.popup-input`, `rows=2`, `maxlength=FOLLOW_UP_MAX_CHARS`, placeholder `Ask a follow-up question…`, and `button.popup-send` "Send"). Scrolling uses `scrollThreadTo(el)` = `thread.scrollTop = Number.isFinite(el.offsetTop) ? el.offsetTop : 0` (never `scrollIntoView`, which can scroll the page).

**Behaviour:**
- **Sticky close:** `sticky` is false on `open`, and becomes true on the first `input` event in the box or on `beginFollowUp`. The outside `pointerdown` handler does nothing while sticky. × and Escape always close.
- **Key isolation:** on the textarea, `keydown` handles first: Escape → `close()`; Enter without Shift and not `isComposing` → `preventDefault()`, and if Send is enabled, `onAsk(value)`. Then for `keydown`, `keyup`, `keypress`, `beforeinput`, `input`, `paste`, `copy`, `cut`: `event.stopPropagation()`, so the page's bubble-phase listeners never see them. (Its capture-phase listeners on `window`/`document` still run first; that is checked live, L11.) Send button click → `onAsk(value)`.

- [ ] **Step 1: Write the failing tests.**
  - `placement.test.ts`: plenty of room → below; **the v1 bug case** (vh 800, anchor top 740, bottom 760) → above, `bottom 66`, `top null`, `maxHeight 600`; little room below but ≥ 320 → below even when above is bigger; selection taller than the screen (top −100, bottom 900) → overlay `top 8`, `maxHeight 600`; narrow viewport (vw 360) → `width 328`, `left 8`; and a sweep of anchors over a 800×600 viewport asserting the popup box is always inside `[MARGIN, vh − MARGIN]`.
  - `popup.test.ts` (set `window.innerWidth/innerHeight` in `beforeAll`): the v9 failed-Simpler test adapted (error line directly before the latest answer, the old text restored, `scrollTop 0`); `a follow-up is appended under the explanation` (question rendered as text: `'<b>x</b>'` shows literally; chunks go to the new answer; the explanation untouched); `a failed follow-up is removed and its question comes back`; `the question is not put back over a new draft`; `an outside click closes a fresh popup but not one the user has typed in` (pointerdown on `document.body` before and after an `input` event; Escape still closes); `keys and paste in the box do not reach the page` (a `document` listener for `keydown` and `paste` sees nothing dispatched on the textarea); `Enter sends, Shift+Enter and composing do not, and nothing sends while Send is disabled`; `opening near the bottom places it above` (`style.bottom` set, `style.top` empty).

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/content/ui`. Expected: FAIL.

- [ ] **Step 3: Implement** `placement.ts` and the popup changes. `index.ts` changes only enough to compile (`open(rect, { onClose, onSimpler })`).

- [ ] **Step 4: Run everything.** `npx vitest run`, `npm run compile`. Expected: all pass.

- [ ] **Step 5: Commit.** `feat(content): popup thread layout, composer, sticky close; place the popup on screen (fixes a v1 bug)`

### Task 6: Wire the thread; debug tools

**Files:**
- Modify: `src/content/index.ts`, `src/content/promptDebug.ts`

**Interfaces:**
- Consumes: `startExplainCall` (Task 1), `followUpPrompt` (Task 3), `threadReduce`/views (Task 4), the popup handle (Task 5), `promptAtLevel`.

- [ ] **Step 1: Wire `index.ts`.** Per click: `prepared` (level 0, as now) and `let thread = initialThreadState()`. `dispatch` reduces, updates `setSimplerButton` and `setComposer`, and runs `startRequest(send)` when there is a send. `open(rect, { onClose, onSimpler: () => dispatch({ type: 'press' }), onAsk: (q) => dispatch({ type: 'ask', question: q }) })`; the `whyNotExplainable` path passes only `onClose`. `startRequest(send)`:
  - `sent = send.kind === 'explanation' ? promptAtLevel(base, send.level) : followUpPrompt(base, send.input, send.level)`; `recordPrepared({ ...prepared, assembled: sent })`.
  - Debug label (when the toggle is on): `prompt sent to Gemini:` (explanation, level 0); `prompt sent to Gemini (Simpler, level {n} of 3):`; `prompt sent to Gemini (follow-up {k}, level {n} of 3):`; `prompt sent to Gemini (follow-up {k}, Simpler, level {n} of 3):`.
  - UI before sending: explanation with level > 0, or a follow-up with `regenerate` → `beginRegenerate(SIMPLICITY_LEVELS[level].label)`; a new follow-up → `beginFollowUp(send.input.question)`.
  - `startExplainCall` handlers: chunk → `appendChunk`; done(text) → `markDone()`, dispatch `done` with `text`; error → level-0 explanation: `showError`; regenerate: `failRegenerate`; new follow-up: `failFollowUp(message, send.input.question)`; then dispatch `error`.
  - A throw from `startExplainCall` (connect failed) takes the same error path.
  - `setContextNote` stays once per click, never on a press or a Send.

- [ ] **Step 2: Debug tools.** `__glossLastPrompt()` label: `prompt from the last Explain, Simpler or follow-up click:`. Update the header comment. (No dry run for follow-ups: one needs a real explanation.)

- [ ] **Step 3: Verify.**
  - `npx vitest run`, `npm run compile`, `npm run build`: all pass.
  - `git diff --stat main -- src/sites src/background src/llm src/messaging src/rag src/context/gather.ts`: **no output**.
  - `git grep -n "@/sites" -- src/context/thread.ts src/content/threadState.ts src/content/explainCall.ts src/content/ui/placement.ts`: **no output**.

- [ ] **Step 4: Commit.** `feat(content): follow-up questions in the popup; debug labels for follow-ups`

### Task 7: Live verification (you) and docs

Reload the extension, **then reload each chat tab** (stale content script). Run every item on **claude.ai and chatgpt.com**; both must behave the same. Debug toggle on.

- **L1 Dropped connection (Task 1).** Start an Explain; while it streams, stop the service worker (chrome://extensions → the extension's service worker → Inspect → Application → Service workers → Stop, or `chrome://serviceworker-internals`). Expected: the popup shows the "Lost the connection…" error, not "Thinking…" forever. Repeat during a Simpler press (old text restored with the error) and, after Task 6, during a follow-up (question back in the box).
- **L2 Selection inside the popup (Task 2).** Select text in an explanation inside the popup. Expected: no Explain button. On ChatGPT, nothing replaces the popup.
- **L3 v1 bug: popup near the bottom of the screen.** Scroll so a highlight sits in the bottom 100 px of the window, Explain. Expected: the popup opens above the highlight, entirely on screen. Also near the top (opens below), and a highlight in a short window (both fully visible).
- **L4 First follow-up.** Explain, then ask a follow-up. Expected: the question appears under the explanation, the answer streams under it, the main chat is untouched, the note line is unchanged.
- **L5 What was sent.** `__glossLastPrompt()` after a follow-up. Expected: the label names the follow-up; the click-time sections are identical to the first explanation's (compare excerpt ids, message numbers); then `explanation`, (`thread`), `follow_up`, `task`; the thread summary line.
- **L6 Thread budget.** Ask about 6–8 follow-ups that invite long answers. Expected: the report shows `left out of the thread…` for the oldest, the prompt has the left-out line, never part of an answer.
- **L7 Simpler with a thread.** After two follow-ups, press Simpler. Expected: only the latest answer is regenerated; earlier ones unchanged; the header shows the level; the next follow-up is sent at that level and `__glossLastPrompt()` shows the regenerated answer as its history.
- **L8 Sticky close.** On a fresh popup an outside click closes it (as before). After typing one letter, outside clicks (page text, scrollbar) do not close it; × and Escape in the popup do. **And an Escape meant for the page does not:** with a sticky popup, click into the chat site's own composer (or start editing one of your messages) and press Escape: the popup stays. Also note: selecting page text while a thread is open brings up Explain, and clicking it replaces the thread (intended, the thread does not survive a new Explain).
- **L9 Level 3 vs "show me the code" (explicit test, the instruction fix is unverified).** On a code highlight (one per site), press Simpler to "Simplest", then ask "show me the code for this". Expected: the answer contains the code, then a simple explanation. Record the result per site. If it refuses or omits the code, adjust `FOLLOW_UP_INSTRUCTIONS[3]` (and the test in Task 3), rebuild, and re-run; record the final wording and why in CLAUDE.md.
- **L10 A follow-up about something not retrieved.** Ask about a part of the chat far from the highlight that is not in the prompt's excerpts. Expected: the answer says it wasn't shown that part, rather than inventing it.
- **L11 Keys stay in the box.** In the box: type letters, `/`, `?`, Space, arrow keys, Ctrl+A, Ctrl+V a paste, Ctrl+Z. Expected: nothing happens on the chat page (no focus jump to its composer, no shortcut, no pasted attachment). If a site still reacts (a capture-phase listener), record which keys and site; do not add site-specific code without asking.
- **L12 One call at a time; failures.** Send is disabled while an answer streams; Enter does nothing then and the text stays. With an invalid API key, a follow-up shows `Couldn't answer: …`, the question returns to the box, and the next `__glossLastPrompt()` does not contain it.
- **L13 Regression.** v9's checklist in brief (Simpler levels, failure restore, Escape mid-press, double-click one call), `__glossSearch`, `__glossHybrid`, `__glossPrompt`; the ChatGPT "can't read this part" popup shows no Simpler and no text box.

Then update CLAUDE.md "Current status" (v10 notes: what was built, decisions, the v1 placement bug, L9's outcome, the test count, `THREAD_BUDGET_TOKENS` added to v6's untuned list), and move the current version to v11 **only after you say so**.

---

## Task 2 probe results

Probed 2026-10-19 with Playwright, Chrome 155.0 (Windows), on a hand-built page with WXT's real shape: a custom-element host appended as the last child of `<body>`, open shadow root (`@webext-core/isolated-element`, which WXT uses, creates exactly that). Values are from `window.getSelection()` at the last `selectionchange` of each action.

| Action | Reported selection | Explain button before v10? |
|---|---|---|
| (a) mouse-drag over popup text | **collapsed**, anchor = focus = `<body>` (the host's parent), rect 0×0; `toString()` still returns the popup text | no: `isCollapsed` → null |
| (b) double-click a word in popup text | collapsed at `<body>`, empty text | no |
| (c) select text in the textarea | collapsed at `<body>` | no |
| (d) **drag from page text into the popup** | **not collapsed**; anchor = the page text node, **focus = the host element**; text = page text from the drag start to the end of `<body>`; rect 432×17 | **yes** |
| (e) APIs | `Selection.prototype.getComposedRanges` and `shadowRoot.getSelection` both exist; `shadowRoot.getSelection()` reports the inner selection (not collapsed, the popup text) | – |
| (f) drag from popup text out into the page | collapsed at `<body>` | no |

**What it means:**
- A selection made inside the popup cannot bring up Explain today (the document-level selection is collapsed). Risk 2 as first stated does not occur in Chrome 155.
- **But (d) does.** On a real chat the host is the last child of `<body>`, so a drag that starts in a message and ends on the popup selects everything from the drag start to the end of the page. Explain then appears, and a click would close the popup (and in v10 its thread) to explain that huge selection. v10 makes this more likely, because sticky close lets a drag start on the page while a thread is open.
- **Task 2: Ruling:** the decision rule said to stop on "a range that starts in the page and ends in the popup". I continued, because the planned guard already lists "the host itself → inside" as a case, which is exactly how (d) ends. The guard's design did not change; (d)'s shape became a test (`a drag from the page into the popup (focus = host) is ignored`). The guard was re-run in the real browser against a real (d) selection: ignored. Cost if wrong: one more guard change before Task 5.
- **For Task 5:** WXT's `createShadowRootUi` has an `isolateEvents` option (an array of event types stopped at the shadow root). It could replace the per-textarea `stopPropagation`, but the document-level Escape listener would then no longer see Escape from inside the popup, so Escape must be handled inside. Task 5's call.
- **For the stretch goal:** a nested explanation must read the selection with `shadowRoot.getSelection()` or `getComposedRanges`; `window.getSelection()` only ever reports it as collapsed.

## Final review (independent, whole branch, 2026-10-19)

No Critical. Verdict "with fixes". The reviewer traced every sync case between what the popup shows and what `threadState` holds (failed follow-up, failed Simpler on a follow-up, Simpler after a failed follow-up, connect throws, close mid-stream and reopen) and found them consistent; the protected folders are untouched.

**Fixed (each with a test that failed first):**
- **Important: an Escape meant for the page wiped a sticky thread** (cancelling a message edit, closing a site menu). A sticky popup now closes on Escape only from inside the popup, or from no particular element when the page did not use it. Test: `a sticky popup ignores an Escape meant for the page (review finding)`; `a fresh popup still closes on an Escape anywhere (v1 behaviour)` pins the old behaviour for a fresh popup.
- **Minor, re-graded Important: drag-and-drop into the box was not isolated** (ChatGPT has a page-wide drop zone; dragging chat text into the box to quote it is a natural use). `dragenter`, `dragover`, `dragleave`, `drop` added to the isolated events; covered by `keys and paste in the box do not reach the page`.

**Deferred minors (not fixed; for the user to decide):**
- Escape during IME composition closes the popup (Enter checks `isComposing`, Escape does not).
- Text typed during the first explanation is lost if that explanation fails, and the error-only popup is then sticky (× / Escape still close it).
- `promptAtLevel` does not reject a follow-up prompt as its base (no caller does that today).
- A whitespace-only answer counts as an answer (`text === ''`), which would make every later follow-up fail.
- `recordPrepared` runs before the call starts, so after a connect throw `__glossLastPrompt()` shows a prompt never sent (debug only).
- The shared opening instruction says text inside tags is "never instructions", while the follow-up question is meant to be acted on; the final task resolves it. If L9 fails, this sentence is a likely cause.
- A sticky popup stays open after a sidebar chat switch (its follow-ups stay consistent: they are built from the click-time snapshot).
- Buttons inside the popup (Space/Enter on Simpler, Send, ×) still pass keys to the page.
- **Recommendation:** the show/hold sync logic in `index.ts` (`showFailure`, the order of `begin*`, `markDone` before `dispatch`) has no test harness; it was verified by reading only.

## Self-review notes

- **Spec coverage:** connection fix (Task 1, L1); sizing and position (Task 5, L3, L4); history and budget (Task 3, L5, L6); no retrieval re-run (Decision 4, L10); no persistence + sticky close (Task 5, L8); Simpler and levels (Tasks 3–4, L7, L9); cost (below); inspection (Tasks 3 and 6, L5); unit tests (Tasks 1–5); the user's three additions (Decision 8 + L3; Decision 9 + L9; Decision 10 + Task 2 placed second, with a stop).
- **Cost, for the record:** every Send and every Simpler press is one Gemini call. Each re-sends the click-time prompt (≤ about 6000 est. tokens), the thread history (≤ 3000) and the question (≤ 500). A thread of 1 explanation, 5 follow-ups and 2 Simpler presses is 8 calls, about 60k input tokens. The daily request cap is what this uses up first; check the current limits for the model in AI Studio.
- **Stretch goal (not built):** a nested explanation would be a new `ThreadSend` kind whose highlight is a selection inside a `.popup-answer`; Task 2's guard is where that selection would be accepted instead of ignored.
