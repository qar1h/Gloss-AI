# v9: "Simpler" Button in the Popup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One click in the popup regenerates the explanation at a simpler level, rebuilt from the original prompt with a different instruction, the retrieved context unchanged. Pressing again goes simpler still, up to a last level.

**Architecture:** The prompt is already a list of named sections, and the instruction is the last one (`task`). The click handler keeps the level-0 `AssembledPrompt` (now with its section texts). "Simpler" calls a pure `promptAtLevel(base, level)` that swaps only the `task` text and rejoins. Retrieval, embedding and assembly never run again, and the page is never re-read. A small pure state machine drives the button. The background worker, `src/llm/`, `src/messaging/` and `src/sites/` do not change: each press is one more ordinary `explain-request` on a new port.

**Tech Stack:** TypeScript (strict), WXT, vitest. No new dependency.

**Spec:** `CLAUDE.md` → "v9: 'Simpler' button in the popup", plus the plan agreed in chat on 2026-10-19 (summarised under "Decisions" below).

## Global Constraints

- Build only v9. No change to retrieval, the adapters, or prompt assembly beyond what v9 needs. v1–v8 keep working on claude.ai and ChatGPT.
- **Nothing site-specific.** No file in `src/sites/` changes, and no new code imports from `@/sites` except where `content/` already does. If site behaviour leaks in, the fix belongs in `src/sites/`.
- **Level 0 is byte-identical to today's prompt** on both sites. The level-0 instruction text is copied verbatim.
- The explanation shown on screen is never sent to Gemini.
- Each press is exactly one Gemini call, only on a press, never automatic.
- No new dependency. Model output is still rendered through `marked` + `DOMPurify`, and error text goes in with `textContent`.
- Prompts stay in memory and the console only. Nothing is written to storage or to the repo.

## Decisions (agreed 2026-10-19)

1. **Swap the `task` section, don't re-assemble.** Everything before `task` is identical at every level.
2. **Levels:** 0 (today) plus 3 simpler levels. The texts are fixed in Task 1. At the last level the button is disabled and reads "Simplest". There is no "less simple" button.
3. **While regenerating:** the button reads "Simplifying…" and is disabled. The old text stays, greyed, until the first chunk arrives. On failure the old text comes back with an error line, the level does not advance, and pressing again retries the same level.
4. **Replace, not stack.**
5. **Budget overage is allowed.** A simpler instruction adds about 30–50 est. tokens. The budget is NOT re-applied: excerpt selection stays the level-0 one. The overage is shown in the report (a summary line, plus a warning when it pushes the total over the budget).
6. **Context notes persist unchanged** and are not recomputed on a press.
7. **`__glossLastPrompt` shows what was actually sent, including the level.** `__glossPrompt(text, { level })` dry-runs any level.
8. **Flag 2 is a real outcome, not a footnote:** if live testing shows levels 2 and 3 near-identical, ship three levels (normal, simpler, simplest). See Task 4, L5.

## Review Focus

Failure modes the plan implies but the obvious tests would miss, most likely first:

1. **A late chunk from an earlier request lands in the new explanation** (for example the level-0 port is still open when Simpler is pressed). Expected: only the current request's chunks render. Pinned by: the reducer ignores `done`/`error` for any request but the current one (Task 2), the existing per-port `requestId` filter, and the old port is disconnected before a new one opens (Task 3).
2. **A regenerate fails after part of the new text has streamed.** Expected: the full previous explanation and its header come back, not a half answer. Pinned by: reducer test "error keeps the shown level" (Task 2) and live check L6.
3. **Context notes vanish or change on a press.** Expected: the note line is identical before and after. Pinned by: the press path never calls `setContextNote` (Task 3, code review) and live check L2 on a ChatGPT chat with a "code only partly on the page" note.
4. **A simpler prompt quietly changes the context.** Expected: every section before `task` is byte-identical to level 0, with the same excerpt ids and message numbers. Pinned by: `simplicity.test.ts` "keeps every section before task identical" (Task 1) and live check L3.
5. **A new Explain click after a closed simpler popup starts at the wrong level.** Expected: level 0, header "Explain", button disabled until the answer finishes. Pinned by: a fresh `initialSimplerState()` per click, the `initialSimplerState` view test (Task 2), and live check L7.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/context/levels.ts` | create | The level table: label and instruction per level, `MAX_SIMPLICITY_LEVEL`. Constants only. |
| `src/context/simplicity.ts` | create | `promptAtLevel`: swap the task section, rejoin, recompute the report. Pure. |
| `src/context/simplicity.test.ts` | create | Tests for both of the above. |
| `src/context/types.ts` | modify | `Section` moves here; `AssembledPrompt.sections`; `PromptReport.simplicityLevel`, `levelExtraTokens`. |
| `src/context/render.ts` | modify | Import `Section` from types; the task text comes from `SIMPLICITY_LEVELS[0]`. |
| `src/context/assemble.ts` | modify | Return `sections`; set `simplicityLevel: 0`, `levelExtraTokens: 0`. |
| `src/context/report.ts` (+ test) | modify | The `simplicity level:` summary line. |
| `src/content/simplerState.ts` (+ test) | create | Button state machine and its view. Pure. |
| `src/content/ui/popup.ts` | modify | Header title, Simpler button, the greyed/restore regenerate states. |
| `src/content/index.ts` | modify | Keep the level-0 prompt per click, wire presses to new requests. |
| `src/content/promptDebug.ts` | modify | Record what was sent at each level; the `level` dry-run option. |

Must stay unchanged (checked in Task 3): `src/sites/`, `src/background/`, `src/llm/`, `src/messaging/`, `src/rag/`, `src/context/gather.ts`.

---

### Task 1: Levels and `promptAtLevel` (pure context layer)

**Files:**
- Create: `src/context/levels.ts`, `src/context/simplicity.ts`, `src/context/simplicity.test.ts`
- Modify: `src/context/types.ts`, `src/context/render.ts`, `src/context/assemble.ts`, `src/context/report.ts`, `src/context/report.test.ts`

**Interfaces:**
- Produces:
  - `levels.ts`: `interface SimplicityLevel { label: string; instruction: string }`, `SIMPLICITY_LEVELS: readonly SimplicityLevel[]`, `MAX_SIMPLICITY_LEVEL = SIMPLICITY_LEVELS.length - 1`.
  - `types.ts`: `interface Section { name: string; text: string }` (moved from `render.ts`); `AssembledPrompt { prompt: string; report: PromptReport; sections: Section[] }`; `PromptReport` gains `simplicityLevel: number` and `levelExtraTokens: number` (est. tokens the level's prompt has over level 0's; 0 at level 0).
  - `simplicity.ts`: `promptAtLevel(base: AssembledPrompt, level: number): AssembledPrompt`.

**The level table (exact copy).** Level 0's instruction is today's `TASK` in `render.ts`, moved verbatim:

| # | `label` | `instruction` |
|---|---|---|
| 0 | `Explain` | `Explain the highlighted part in simple, plain language. Use the surrounding conversation only where it actually helps understanding — do not just repeat it back. Keep the explanation focused on the highlighted part itself.` |
| 1 | `Explain · simpler` | `Explain the highlighted part more simply than you normally would: the reader found a normal explanation too hard to follow. Assume they don't know this topic. Use short sentences and everyday words, and explain any technical term in plain words the first time you use it. Use the surrounding conversation only where it actually helps — do not just repeat it back. Keep it focused on the highlighted part, and keep it accurate.` |
| 2 | `Explain · even simpler` | `Explain the highlighted part for a complete beginner who has never studied this topic. Use no jargon at all; if a technical word can't be avoided, say what it means in everyday words. Give one concrete everyday example or comparison. Keep it short, a few short paragraphs at most. Use the conversation only to understand what the highlighted part means here. Simpler must not mean wrong: leave details out rather than say something untrue.` |
| 3 | `Explain · simplest` | `Give only the core idea of the highlighted part, in the simplest words possible, as if to a curious 10-year-old: two to four short sentences, no technical words, and one everyday comparison if it helps. Leave out details, exceptions and code. Simpler must not mean wrong: leave things out rather than say something untrue.` |

- [ ] **Step 1: Write the failing tests** in `src/context/simplicity.test.ts`. Add a helper `assembleWith(opts: AssemblyOptions, focal = makeFocal(), ranked = TWO_RANKED)` that calls `assemblePrompt` in retrieval mode, like `retrieve()` in `assemble.test.ts`. `TWO_RANKED` is two `makeChunk` candidates, `OPTS` is `{ budgetTokens: 6000, thresholdTokens: 6000, maxChunks: 8 }`, and `base = assembleWith(OPTS)`.

```ts
const LEVEL_0 =
  'Explain the highlighted part in simple, plain language. Use the surrounding conversation only where it actually helps understanding — do not just repeat it back. Keep the explanation focused on the highlighted part itself.';

it('level 0 is today\'s instruction, word for word', () => {
  expect(SIMPLICITY_LEVELS[0].instruction).toBe(LEVEL_0);
  expect(base.prompt.endsWith(LEVEL_0)).toBe(true);
});
it('has four levels, the last labelled simplest', () => {
  // Changing the count is a deliberate edit (see Task 4, L5), so this test is edited with it.
  expect(SIMPLICITY_LEVELS).toHaveLength(4);
  expect(MAX_SIMPLICITY_LEVEL).toBe(3);
  expect(SIMPLICITY_LEVELS[MAX_SIMPLICITY_LEVEL].label).toBe('Explain · simplest');
});
it('every instruction is different', () => {
  expect(new Set(SIMPLICITY_LEVELS.map((l) => l.instruction)).size).toBe(SIMPLICITY_LEVELS.length);
});
it('no instruction contains one of our tag names', () => {
  for (const l of SIMPLICITY_LEVELS) expect(neutralizeTags(l.instruction)).toBe(l.instruction);
});
it('level 0 returns the same prompt and report', () => {
  const r = promptAtLevel(base, 0);
  expect(r.prompt).toBe(base.prompt);
  expect(r.report).toEqual(base.report);
});
it('keeps every section before task identical at every level', () => {
  for (let level = 1; level <= MAX_SIMPLICITY_LEVEL; level++) {
    const r = promptAtLevel(base, level);
    expect(r.sections.slice(0, -1)).toEqual(base.sections.slice(0, -1));
    expect(r.sections.at(-1)).toEqual({ name: 'task', text: SIMPLICITY_LEVELS[level].instruction });
    expect(r.prompt.startsWith(joinSections(base.sections.slice(0, -1)))).toBe(true);
    expect(r.report.includedChunkIds).toEqual(base.report.includedChunkIds);
    expect(r.report.candidates).toEqual(base.report.candidates);
  }
});
it('recomputes the totals and records the level', () => {
  const r = promptAtLevel(base, 3);
  expect(r.report.simplicityLevel).toBe(3);
  expect(r.report.totalEstTokens).toBe(estimateTokens(r.prompt));
  expect(r.report.levelExtraTokens).toBe(r.report.totalEstTokens - base.report.totalEstTokens);
  expect(r.report.sections.find((s) => s.name === 'task')!.estTokens).toBe(
    estimateTokens(SIMPLICITY_LEVELS[3].instruction),
  );
});
it('warns when the level pushes the prompt over the budget, and only then', () => {
  // No excerpts, so the level-0 total is exact (no per-chunk upper-bound slack), and a budget
  // equal to it: level 0 fits exactly, level 3 is over.
  const bare = assembleWith(OPTS, makeFocal(), []);
  const tight = assembleWith({ ...OPTS, budgetTokens: bare.report.totalEstTokens }, makeFocal(), []);
  const r = promptAtLevel(tight, 3);
  expect(r.report.warnings.filter((w) => w.includes('over the'))).toHaveLength(1);
  expect(r.report.warnings.at(-1)).toMatch(/level 3 instruction adds ≈\d+ est\. tokens/);
  expect(promptAtLevel(base, 3).report.warnings).toEqual(base.report.warnings); // 6000 budget: no warning
});
it('rejects a level that does not exist', () => {
  for (const bad of [-1, 4, 1.5, NaN]) expect(() => promptAtLevel(base, bad)).toThrow(RangeError);
});
it('only takes a level-0 base, so levels never stack', () => {
  expect(() => promptAtLevel(promptAtLevel(base, 1), 2)).toThrow(/level-0/);
});
it('behaves the same for a ChatGPT-shaped focal', () => {
  // Positions like 10001, an order note: nothing in promptAtLevel may depend on them.
  const gpt = assembleWith(OPTS, makeFocal({
    source: { id: '10001', role: 'assistant', text: 'Intro. Set pool_pre_ping to test connections before use. Outro.' },
    question: { id: '10000', role: 'user', text: 'How?' },
    recent: [],
    orderStatus: { retrieval: 'ok', note: 'code in this message is only partly on the page', indexGeneration: 'g1' },
  }));
  const r = promptAtLevel(gpt, 2);
  expect(r.sections.slice(0, -1)).toEqual(gpt.sections.slice(0, -1));
  expect(r.report.orderNote).toBe(gpt.report.orderNote);
});
```

In `src/context/report.test.ts`, add `simplicityLevel: 0, levelExtraTokens: 0` to `makeReport`'s defaults, and:

```ts
it('names the level in the summary', () => {
  expect(summaryLines(makeReport())).toContain('simplicity level: 0 of 3 (Explain)');
  expect(summaryLines(makeReport({ simplicityLevel: 2, levelExtraTokens: 41 }))).toContain(
    'simplicity level: 2 of 3 (Explain · even simpler) — instruction ≈+41 est. tokens vs level 0; excerpts are the level-0 selection, the budget is not re-applied',
  );
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run src/context/simplicity.test.ts src/context/report.test.ts`. Expected: FAIL (the modules and fields don't exist yet).

- [ ] **Step 3: Implement.**
  - `levels.ts`: the table above.
  - `types.ts`: move `Section` here and add the new fields.
  - `render.ts`: import `Section` from `./types` (keep `export type { Section }` there, so `render.ts` importers don't change), and use `SIMPLICITY_LEVELS[0].instruction` for the `task` section.
  - `assemble.ts`: return `sections` and set both new report fields to 0.
  - `report.ts`: put the level line right after the `prompt:` line in `summaryLines`. The `— instruction …` tail appears only when `simplicityLevel > 0`; format the sign as `+N` or `-N`.
  - `simplicity.ts` `promptAtLevel`:
    - Throw `RangeError` unless `level` is an integer in `[0, MAX_SIMPLICITY_LEVEL]`.
    - Throw `Error('promptAtLevel takes the level-0 prompt')` if `base.report.simplicityLevel !== 0`.
    - Throw if there is no `task` section.
    - At level 0, return `base` unchanged.
    - Otherwise:
      - swap the task text, rejoin with `joinSections`, and recompute `totalEstTokens`, `sections` sizes, `simplicityLevel` and `levelExtraTokens`;
      - append the warning only when the new total is over `budgetTokens` and the base total was not: `level ${level} instruction adds ≈${extra} est. tokens, so the prompt (≈${total}) is over the ${budget} budget; allowed on purpose: the excerpts are kept exactly as chosen at level 0`;
      - leave every other report field as it was.

- [ ] **Step 4: Run the whole suite.** Run: `npx vitest run` and `npm run compile`. Expected: all pass, 381 existing tests unchanged plus the new ones (the existing `assemble`, `render` and `gather` tests prove level 0 is unchanged), and the compile is clean.

- [ ] **Step 5: Commit.** `feat(context): simplicity levels; promptAtLevel swaps only the task instruction`

### Task 2: The Simpler button's state machine (pure)

**Files:**
- Create: `src/content/simplerState.ts`, `src/content/simplerState.test.ts`

**Interfaces:**
- Consumes: `MAX_SIMPLICITY_LEVEL` from `@/context/levels`.
- Produces:
  ```ts
  export type SimplerPhase = 'first' | 'idle' | 'regenerating' | 'unavailable';
  export interface SimplerState { phase: SimplerPhase; shownLevel: number; pendingLevel: number | null; request: number }
  export type SimplerEvent = { type: 'press' } | { type: 'done'; request: number } | { type: 'error'; request: number };
  export interface SimplerSend { level: number; request: number }
  export interface SimplerButtonView { visible: boolean; enabled: boolean; label: string; title: string }
  export function initialSimplerState(): SimplerState; // { phase: 'first', shownLevel: 0, pendingLevel: null, request: 0 }
  export function simplerReduce(state: SimplerState, event: SimplerEvent): { state: SimplerState; send: SimplerSend | null };
  export function simplerButtonView(state: SimplerState): SimplerButtonView;
  ```
  `request` counts calls within one popup: 0 is the level-0 call, and each press that sends increments it.

**Transitions:**
- `first` + done(0) → `idle`.
- `first` + error(0) → `unavailable`.
- `idle` + press, when `shownLevel < MAX` → `regenerating`, with `pendingLevel = shownLevel + 1` and `request + 1`; send `{ level: pendingLevel, request }`.
- `idle` + press at MAX → nothing.
- `regenerating` + press → nothing.
- `regenerating` + done(current) → `idle`, `shownLevel = pendingLevel`, `pendingLevel = null`.
- `regenerating` + error(current) → `idle`, `shownLevel` unchanged, `pendingLevel = null`.
- Any `done`/`error` whose `request` is not `state.request` → ignored.
- `unavailable` + anything → unchanged.

**Views (exact copy):**

| State | visible | enabled | label | title |
|---|---|---|---|---|
| `first` | yes | no | `Simpler` | `Available when this explanation finishes` |
| `idle`, below MAX | yes | yes | `Simpler` | `Explain this again, more simply` |
| `idle`, at MAX | yes | no | `Simplest` | `This is already the simplest version` |
| `regenerating` | yes | no | `Simplifying…` | `` |
| `unavailable` | no | no | `Simpler` | `` |

- [ ] **Step 1: Write the failing tests** (`simplerState.test.ts`). Use a small `run(events)` helper that folds `simplerReduce` from `initialSimplerState()` and collects the `send`s.
  - `starts disabled while the first explanation streams`: view is `{ visible: true, enabled: false, label: 'Simpler', … }`.
  - `a press before the first explanation finishes sends nothing`.
  - `first done enables it; a press sends level 1 as request 1`: sends `[{ level: 1, request: 1 }]`, phase `regenerating`, view label `Simplifying…`, disabled.
  - `a second press while regenerating sends nothing` (double-click: one call).
  - `done commits the level`: after done(1), `shownLevel` 1, view `Simpler`, enabled.
  - `pressing through every level ends at Simplest`: after 3 press/done pairs, sends levels `[1, 2, 3]`, view `{ enabled: false, label: 'Simplest', title: 'This is already the simplest version' }`, and a fourth press sends nothing.
  - `error keeps the shown level and a retry asks for the same level again`: press, error(1) → `shownLevel` 0, idle; press → sends `{ level: 1, request: 2 }`.
  - `a done or error from an earlier request is ignored`: press (request 1), then done(0) → still `regenerating`, `shownLevel` 0.
  - `a failed first explanation hides the button for good`: error(0) → view `visible: false`; a later press sends nothing.

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run src/content/simplerState.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `simplerState.ts` to the transitions and views above. The reducer must not mutate its input state.

- [ ] **Step 4: Run it.** Run: `npx vitest run` and `npm run compile`. Expected: all pass.

- [ ] **Step 5: Commit.** `feat(content): Simpler button state machine`

### Task 3: Wire it up (popup, click handler, debug tools)

**Files:**
- Modify: `src/content/ui/popup.ts`, `src/content/index.ts`, `src/content/promptDebug.ts`

**Interfaces:**
- Consumes: `promptAtLevel` (Task 1), `SIMPLICITY_LEVELS`, `MAX_SIMPLICITY_LEVEL` (Task 1), everything in Task 2's Produces.
- Produces (popup handle additions):
  - `open(anchorRect, onClose, onSimpler?: () => void)`: with no `onSimpler`, the button is hidden (the "can't read this part" path). `open` always resets the title to `Explain` and clears any regenerate state.
  - `setSimplerButton(view: SimplerButtonView): void`
  - `beginRegenerate(title: string): void`: saves the current buffer and title as "previous" and greys the body (`.popup-body.stale { opacity: 0.45 }`). The next `appendChunk` clears the buffer, removes `stale`, sets the title and then appends.
  - `failRegenerate(message: string): void`: restores the previous buffer and title, removes `stale`, and adds `<p class="popup-error">` with `textContent` = `Couldn't simplify: ${message}` **above** the explanation, and scrolls the popup (not the page) to the top. (Changed after the final review: below a long explanation the line was off screen, so a failed press looked like it did nothing. Pinned by `src/content/ui/popup.test.ts`.)
  - `markDone` also drops "previous".

- [ ] **Step 1: Popup.** The header becomes a title `<span>`, then the Simpler `<button type="button" class="popup-simpler">` (a small pill, muted border, `:disabled` greyed), then `×`. The button is inside the shadow host, so the existing outside-click check does not close the popup.

- [ ] **Step 2: Click handler (`index.ts`).**
  - Per click, keep `prepared` (level 0) and `let simpler = initialSimplerState()`.
  - `dispatch(event)` reduces the state, calls `popup.setSimplerButton(simplerButtonView(...))`, and calls `startRequest(send)` when the reducer asks for a send.
  - `startRequest({ level, request })`, with level-0 request 0 started through the same function:
    - `sent = promptAtLevel(prepared.assembled, level)`;
    - `recordPrepared({ ...prepared, assembled: sent })`;
    - when debug is on, `printPrepared` with label `prompt sent to Gemini:` at level 0, else `prompt sent to Gemini (Simpler, level ${level} of ${MAX_SIMPLICITY_LEVEL}):`;
    - if `level > 0`, `popup.beginRegenerate(SIMPLICITY_LEVELS[level].label)`;
    - disconnect the previous port, set `state.port` to the new one (so close aborts the current call), and post `explain-request` with `sent.prompt` and a fresh `requestId`.
  - Port messages, filtered by `requestId` as now:
    - chunk → `appendChunk`;
    - done → `markDone`, then dispatch `done`;
    - error → `showError` at level 0, `failRegenerate` above it, then dispatch `error`.
  - The `catch` path for a failed prepare dispatches `error` for request 0 (hides the button).
  - `setContextNote` is called once per click, as today, **never** in the press path.
  - The `whyNotExplainable` path opens with no `onSimpler`.

- [ ] **Step 3: Debug tools (`promptDebug.ts`).**
  - `PromptDebugOptions` gains `level?: number`. If `level` is not an integer in `0..MAX_SIMPLICITY_LEVEL`, warn `${TAG} level must be a whole number from 0 to ${MAX_SIMPLICITY_LEVEL}` and stop before preparing. Otherwise print `promptAtLevel(prepared.assembled, level)`.
  - The `__glossLastPrompt` label becomes `prompt from the last Explain or Simpler click:`.
  - Update the header comment's usage lines.

- [ ] **Step 4: Verify.**
  - Run: `npx vitest run`, `npm run compile`, `npm run build`. Expected: all pass, and the build ends with `check-build-output` passing.
  - Run: `git diff --stat main -- src/sites src/background src/llm src/messaging src/rag src/context/gather.ts`. Expected: **no output**.
  - Run: `git grep -n "@/sites" -- src/context/simplicity.ts src/context/levels.ts src/content/simplerState.ts`. Expected: **no output**.

- [ ] **Step 5: Commit.** `feat(content): Simpler button in the popup; __glossPrompt level option`

### Task 4: Live verification (you) and docs

Reload the extension, **then reload each chat tab** (stale content script, see CLAUDE.md). Run every item on **claude.ai and on chatgpt.com**. Both sites must behave the same.

- **L1 Level 0 unchanged.** Explain works as before. The button shows "Simpler", disabled, while the answer streams, then becomes enabled. `__glossPrompt()` ends with the level-0 instruction and says `simplicity level: 0 of 3 (Explain)`.
- **L2 One press.** The old text greys, the new text replaces it as it streams, and the header reads "Explain · simpler". The muted note line is word-for-word the same; on ChatGPT, use a chat with a "code only partly on the page" note.
- **L3 Context kept.** After the Explain click, run `__glossLastPrompt()` and note the excerpt ids and message numbers. Press Simpler and run `__glossLastPrompt()` again. Expected: level 1, the same ids and numbers, and the same text up to the instruction.
- **L4 Last level.** Press through to "Explain · simplest". The button reads "Simplest", is disabled, and has the tooltip.
- **L5 Are the levels really different? (decides 3 vs 4 levels)**
  - Go through all levels on at least 4 highlights per site: a technical term, a line of code, a formula (ChatGPT), and a whole paragraph.
  - Record per highlight whether level 3 is clearly shorter and simpler than level 2, and whether any level says something false.
  - **If level 3 is not clearly different from level 2 on most highlights, drop a level:** delete the `Explain · even simpler` row, change the count test to 3 and `MAX_SIMPLICITY_LEVEL` to 2, rebuild, and re-run L4.
  - Tune wording with `__glossPrompt("text", { level: n })`, which costs no calls.
  - Write the result and the reason in CLAUDE.md.
- **L6 Failure keeps the old text.**
  - With a popup open after a finished explanation, change the API key on the options page (another tab) to an invalid one, and press Simpler. Expected: the previous explanation and header come back with the red "Couldn't simplify: …" line, and the button is enabled again.
  - Restore the key and press again. Expected: level 1 (a retry, not level 2).
- **L7 Close mid-regenerate.** Press Simpler, then Escape at once. Expected: the background console shows no error. Then a new Explain click gives header "Explain", level 0, and the button disabled until it finishes.
- **L8 One call per press.** With the debug toggle on, double-click Simpler. Expected: exactly one `prompt sent to Gemini (Simpler, level 1 of 3):` report.
- **L9 Regression.** `__glossSearch`, `__glossHybrid` and `__glossPrompt` print as before, apart from the new level line, on both sites. The "can't read this part" popup on ChatGPT shows no Simpler button.

Then update CLAUDE.md "Current status": the v9 notes (what was built, decisions, the L5 outcome, the test count), and move the current version to v10 **only after you say so**.

---

## Self-review notes

- **Spec coverage:** original-prompt rebuild (Task 1, Task 3 Step 2), levels (Task 1 table, Task 2), regenerating look (Task 2 views, Task 3 Step 1), replace vs stack (Task 3 `beginRegenerate`), cost (one send per press: Task 2 tests, L8), notes persist (Task 3 Step 2, L2), `__glossLastPrompt` and the level (Task 1 report line, Task 3 Step 3, L3), unit tests (Tasks 1–2), both sites identical (Task 3 Step 4 diff check, L1–L9 on both sites).
- **Cost, for the record:** each press is one full call with the same input (about 6000 est. tokens at most, plus up to about 50 at higher levels). The full ladder is 4 calls per highlight. The daily request cap is the free-tier limit this uses up fastest. Check the current numbers in AI Studio; they change.
