// Console tools for seeing exactly what an Explain click sends, and why.
//   __glossPrompt(text?, opts?)  dry run: builds the same prompt a click would, calls nothing
//                                (opts.level: the prompt a Simpler press would send at that level)
//   __glossLastPrompt()          reprints the prompt of the last real Explain, Simpler or follow-up
//                                (a follow-up's report includes what it sent of the thread)
// With the debug toggle on, every real click also prints this report. Everything goes to the
// console only — prompts contain real chat text and are never written anywhere.

import { requireAdapter } from '@/sites';
import { getSettings } from '@/options/storage';
import { finalizeFocal } from '@/context/focal';
import { prepareExplainPrompt, type DebugOverride, type PreparedExplain } from '@/context/gather';
import { MAX_SIMPLICITY_LEVEL } from '@/context/levels';
import { resolveRecentCount } from '@/context/limits';
import { promptAtLevel } from '@/context/simplicity';
import { candidateTable, describeCoverageForConsole, sectionTable, summaryLines } from '@/context/report';
import type { RawFocal } from '@/context/types';
import { rawFocalForMessage, readRawFocal, whyNotExplainable } from './readFocal';

const TAG = '[highlight-explainer]';

export interface PromptDebugOptions {
  /** Force full-chat or retrieval, whatever the length switch would pick. */
  mode?: 'full' | 'retrieval';
  /** Override the budget / threshold / excerpt cap for this call only. */
  budget?: number;
  threshold?: number;
  k?: number;
  /** The "Simpler" level to show (0 = the normal instruction). */
  level?: number;
}

let lastPrepared: PreparedExplain | null = null;

export function recordPrepared(prepared: PreparedExplain): void {
  lastPrepared = prepared;
}

export function printPrepared(prepared: PreparedExplain, label: string): void {
  const { report, prompt } = prepared.assembled;
  console.log(`${TAG} ${label}`);
  for (const line of summaryLines(report)) console.log(`${TAG} ${line}`);
  console.log(`${TAG} ${describeCoverageForConsole(prepared.coverage)}`);
  if (report.candidates.length > 0) {
    console.log(`${TAG} candidates (what retrieval returned, and what assembly did with each):`);
    console.table(candidateTable(report));
  }
  console.log(`${TAG} tokens per section (est.):`);
  console.table(sectionTable(report));
  console.log(`${TAG} final prompt:\n${prompt}`);
}

async function dryRun(textOrOptions?: string | PromptDebugOptions, maybeOptions?: PromptDebugOptions): Promise<void> {
  const text = typeof textOrOptions === 'string' ? textOrOptions : undefined;
  const options = (typeof textOrOptions === 'object' ? textOrOptions : maybeOptions) ?? {};
  const level = options.level ?? 0;
  if (!Number.isInteger(level) || level < 0 || level > MAX_SIMPLICITY_LEVEL) {
    console.warn(`${TAG} level must be a whole number from 0 to ${MAX_SIMPLICITY_LEVEL}`);
    return;
  }

  let raw: RawFocal | null;
  const selection = window.getSelection();
  if (text !== undefined) {
    // Typed text: use the first mounted message that contains it as the source message.
    const message = requireAdapter()
      .getAllMessages()
      .find((m) => requireAdapter().getMessageText(m.element).includes(text));
    if (!message) {
      console.warn(
        `${TAG} no indexed message currently on the page contains that text. (On ChatGPT, a window you jumped to with the scrollbar is not indexed: select the text with the mouse instead of typing it.)`,
      );
      return;
    }
    raw = rawFocalForMessage(message, text, text);
  } else if (selection && selection.rangeCount > 0 && !selection.isCollapsed && selection.toString().trim()) {
    raw = readRawFocal(selection.getRangeAt(0), selection.toString().trim());
  } else {
    console.warn(`${TAG} select some text in a message first, or pass text: __glossPrompt("text")`);
    return;
  }
  if (!raw) {
    console.warn(`${TAG} ${(selection && selection.rangeCount > 0 && whyNotExplainable(selection.getRangeAt(0))) || 'the selection is not inside a recognized chat message.'}`);
    return;
  }

  const settings = await getSettings();
  const focal = finalizeFocal(raw, resolveRecentCount(settings.recentMessageCount));
  const override: DebugOverride = {
    mode: options.mode,
    budgetTokens: options.budget,
    thresholdTokens: options.threshold,
    maxChunks: options.k,
  };
  const prepared = await prepareExplainPrompt(requireAdapter().getConversationId(), focal, settings, override);
  printPrepared(
    { ...prepared, assembled: promptAtLevel(prepared.assembled, level) },
    level === 0
      ? 'dry run — this is what an Explain click would send (nothing was sent):'
      : `dry run — this is what Simpler at level ${level} would send (nothing was sent):`,
  );
}

export function initPromptDebug(): void {
  const w = window as unknown as {
    __glossPrompt?: typeof dryRun;
    __glossLastPrompt?: () => void;
  };
  w.__glossPrompt = dryRun;
  w.__glossLastPrompt = () => {
    if (!lastPrepared) {
      console.warn(`${TAG} no Explain click yet in this tab.`);
      return;
    }
    printPrepared(lastPrepared, 'prompt from the last Explain, Simpler or follow-up click:');
  };
}
