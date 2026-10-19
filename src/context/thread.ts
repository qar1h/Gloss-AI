// Follow-up questions (v10): the prompt for a question asked in the popup. It is the click-time
// prompt with its instruction removed, every section before it byte for byte (retrieval is not
// re-run, nothing is re-read from the page), then the explanation the reader was given, the earlier
// follow-ups that fit the thread budget, the new question, and a follow-up instruction at the
// popup's level. The thread is quoted text inside the one prompt string, so LLMProvider stays a
// plain `streamExplain(prompt)`. Pure.
//
// The history is whatever the caller passes, so the caller must pass only finished answers, each
// in its latest version (threadState.ts guarantees it). When the budget runs out the OLDEST
// follow-ups are dropped whole, never cut and never summarised, and the prompt says how many.

import { FOLLOW_UP_INSTRUCTIONS, MAX_SIMPLICITY_LEVEL, SIMPLICITY_LEVELS } from './levels';
import { THREAD_BUDGET_TOKENS } from './limits';
import { joinSections, neutralizeTags } from './render';
import { estimateTokens } from './tokens';
import type { AssembledPrompt, Section, ThreadReport } from './types';

export interface ThreadExchange {
  question: string;
  answer: string;
}

export interface FollowUpInput {
  /** The first explanation, as currently on screen (its latest Simpler version). */
  explanation: string;
  /** Earlier finished follow-ups, oldest first. */
  exchanges: ThreadExchange[];
  question: string;
}

const HISTORY_INTRO = 'Follow-up questions the reader already asked about it, with the answers they got, oldest first:';

function leftOutLine(count: number): string {
  return count === 1
    ? '[1 earlier follow-up question and its answer were left out to save space.]'
    : `[${count} earlier follow-up questions and their answers were left out to save space.]`;
}

function renderExchange(exchange: ThreadExchange, number: number): string {
  return [
    `<follow_up number="${number}">`,
    '<reader_question>',
    neutralizeTags(exchange.question),
    '</reader_question>',
    '<previous_answer>',
    neutralizeTags(exchange.answer),
    '</previous_answer>',
    '</follow_up>',
  ].join('\n');
}

export function followUpPrompt(
  base: AssembledPrompt,
  input: FollowUpInput,
  level: number,
  threadBudgetTokens: number = THREAD_BUDGET_TOKENS,
): AssembledPrompt {
  if (!Number.isInteger(level) || level < 0 || level > MAX_SIMPLICITY_LEVEL) {
    throw new RangeError(`simplicity level must be a whole number from 0 to ${MAX_SIMPLICITY_LEVEL}, got ${level}`);
  }
  if (base.report.simplicityLevel !== 0) throw new Error('followUpPrompt takes the level-0 prompt, so levels never stack');
  if (base.report.thread !== null) throw new Error('followUpPrompt takes the click-time prompt, not a follow-up prompt');
  if (!input.question.trim()) throw new RangeError('a follow-up question must not be blank');
  if (!input.explanation.trim()) throw new Error('a follow-up needs the explanation it is about');
  const taskIndex = base.sections.length - 1;
  if (base.sections[taskIndex]?.name !== 'task') throw new Error('the prompt has no task section to replace');

  const explanationText = `The reader was given this explanation of the highlighted part:\n<explanation>\n${neutralizeTags(input.explanation)}\n</explanation>`;
  const explanationEstTokens = estimateTokens(explanationText);
  const warnings = [...base.report.warnings];
  if (explanationEstTokens > threadBudgetTokens) {
    warnings.push(
      `the explanation alone (≈${explanationEstTokens} est. tokens) is over the ${threadBudgetTokens} thread budget; sent anyway, so no earlier follow-ups fit`,
    );
  }

  // Newest to oldest; stop at the first that does not fit, so the history is always an unbroken
  // run ending at the newest follow-up (never a gap with an older one after it).
  let used = explanationEstTokens;
  let firstIncluded = input.exchanges.length;
  for (let i = input.exchanges.length - 1; i >= 0; i--) {
    const cost = estimateTokens(renderExchange(input.exchanges[i]!, i + 1)) + 1;
    if (used + cost > threadBudgetTokens) break;
    used += cost;
    firstIncluded = i;
  }
  const dropped = input.exchanges.slice(0, firstIncluded).map((exchange, i) => ({
    number: i + 1,
    estTokens: estimateTokens(renderExchange(exchange, i + 1)) + 1,
  }));
  const included = input.exchanges.slice(firstIncluded).map((exchange, i) => ({ exchange, number: firstIncluded + i + 1 }));

  const sections: Section[] = [...base.sections.slice(0, taskIndex), { name: 'explanation', text: explanationText }];
  if (input.exchanges.length > 0) {
    const parts = ['<earlier_follow_ups>'];
    if (included.length > 0) parts.push(HISTORY_INTRO);
    if (dropped.length > 0) parts.push(leftOutLine(dropped.length));
    const head = parts.join('\n');
    const blocks = included.map(({ exchange, number }) => renderExchange(exchange, number));
    const body = blocks.length > 0 ? `${head}\n\n${blocks.join('\n\n')}` : head;
    sections.push({ name: 'thread', text: `${body}\n</earlier_follow_ups>` });
  }
  const questionText = `The reader's new follow-up question:\n<follow_up_question>\n${neutralizeTags(input.question)}\n</follow_up_question>`;
  sections.push({ name: 'follow_up', text: questionText });
  const task = FOLLOW_UP_INSTRUCTIONS[level]!;
  sections.push({ name: 'task', text: task });

  const prompt = joinSections(sections);
  const thread: ThreadReport = {
    followUpNumber: input.exchanges.length + 1,
    budgetTokens: threadBudgetTokens,
    explanationEstTokens,
    includedExchanges: included.map((e) => e.number),
    droppedExchanges: dropped,
    usedEstTokens: used,
    questionEstTokens: estimateTokens(questionText),
  };

  return {
    prompt,
    sections,
    report: {
      ...base.report,
      totalEstTokens: estimateTokens(prompt),
      // The click-time always-include figure with its instruction swapped for this one.
      fixedEstTokens: base.report.fixedEstTokens - estimateTokens(SIMPLICITY_LEVELS[0]!.instruction) + estimateTokens(task),
      sections: sections.map((s) => ({ name: s.name, estTokens: estimateTokens(s.text) })),
      warnings,
      simplicityLevel: level,
      levelExtraTokens: estimateTokens(task) - estimateTokens(FOLLOW_UP_INSTRUCTIONS[0]!),
      thread,
    },
  };
}
