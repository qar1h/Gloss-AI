// The decision logic of v5: what is always included, whether to send the whole chat or
// retrieve, and which retrieved chunks fit. Pure over already-fetched data — no DOM, no
// IndexedDB, no network — so every rule here is unit-tested. gather.ts does the fetching.

import type { Chunk } from '../rag/types';
import {
  PARAGRAPH_CEILING_TOKENS,
  QUESTION_CEILING_TOKENS,
  SOURCE_MESSAGE_CEILING_TOKENS,
  type AssemblyOptions,
} from './limits';
import {
  buildSections,
  EXCERPTS_WRAPPER_TOKENS,
  excerptCost,
  groupExcerpts,
  joinSections,
} from './render';
import { estimateTokens, trimMiddle, windowAround } from './tokens';
import type {
  AssembledPrompt,
  Candidate,
  CandidateRow,
  Decision,
  FocalInput,
  Mode,
  PromptReport,
  QuestionState,
} from './types';

/**
 * Applies the per-item ceilings. The highlight is never touched. The paragraph is only windowed
 * around the highlight when it is over PARAGRAPH_CEILING_TOKENS (in practice: a code block).
 */
export function prepareFocal(focal: FocalInput): { focal: FocalInput; trimmed: string[] } {
  const trimmed: string[] = [];

  const source = windowAround(
    focal.source.text,
    focal.paragraph || focal.highlight,
    SOURCE_MESSAGE_CEILING_TOKENS,
  );
  if (source.trimmed) trimmed.push('message_being_explained');

  // The source message above was windowed around the ORIGINAL paragraph (which is a substring
  // of it); only now is the paragraph itself windowed around the highlight. A selection that
  // spans a line break won't appear verbatim in a block's text, so fall back to its
  // whitespace-collapsed form before windowAround gives up and trims head + tail.
  const anchor = focal.paragraph.includes(focal.highlight)
    ? focal.highlight
    : focal.highlight.replace(/\s+/g, ' ').trim();
  const paragraph = windowAround(focal.paragraph, anchor, PARAGRAPH_CEILING_TOKENS);
  if (paragraph.trimmed) trimmed.push('paragraph');

  let question = focal.question;
  if (question) {
    const result = trimMiddle(question.text, QUESTION_CEILING_TOKENS);
    if (result.trimmed) {
      trimmed.push('user_question');
      question = { ...question, text: result.text };
    }
  }

  // Recent messages need no ceiling here: finalizeFocal already demoted any over the limit.
  return {
    focal: { ...focal, paragraph: paragraph.text, source: { ...focal.source, text: source.text }, question },
    trimmed,
  };
}

export interface ModeDecision {
  mode: Mode;
  reason: string;
  /** Instructions + always-include sections, no excerpts. */
  fixedTokens: number;
  /** Fixed part + every chunk in `others`. */
  allTokens: number;
}

/**
 * The length switch. `others` is every indexed chunk that is not from an excluded message, in
 * chat order. If the fixed part plus all of them fits the threshold, there is nothing to
 * select, so retrieval (and its query embedding) is skipped.
 */
export function chooseMode(
  focal: FocalInput,
  others: Chunk[],
  opts: AssemblyOptions,
  forced?: Mode,
): ModeDecision {
  const { focal: prepared } = prepareFocal(focal);
  const fixedTokens = estimateTokens(joinSections(buildSections(prepared, [])));
  const sourceId = prepared.source.id;
  const excerptTokens =
    others.length === 0
      ? 0
      : EXCERPTS_WRAPPER_TOKENS + others.reduce((sum, chunk) => sum + excerptCost(chunk, sourceId), 0);
  const allTokens = fixedTokens + excerptTokens;

  if (forced) {
    return { mode: forced, reason: `forced to ${forced} (debug override)`, fixedTokens, allTokens };
  }
  if (others.length === 0) {
    return { mode: 'full', reason: 'nothing else is indexed to retrieve', fixedTokens, allTokens };
  }
  if (allTokens <= opts.thresholdTokens) {
    return {
      mode: 'full',
      reason: `the whole indexed chat (≈${allTokens} est. tokens) fits the threshold (${opts.thresholdTokens})`,
      fixedTokens,
      allTokens,
    };
  }
  return {
    mode: 'retrieval',
    reason: `the whole indexed chat (≈${allTokens} est. tokens) is over the threshold (${opts.thresholdTokens})`,
    fixedTokens,
    allTokens,
  };
}

export interface AssemblyInput {
  focal: FocalInput;
  mode: Mode;
  modeReason: string;
  /** Every non-excluded indexed chunk, chat order. Used by full mode. */
  others: Chunk[];
  /** The fused ranking, best first. Used by retrieval mode; null = retrieval did not run. */
  ranked: Candidate[] | null;
  retrievalNote?: string;
  excludedMessageIds: string[];
  excludedChunkCount: number;
}

function rowFor(
  chunk: Chunk,
  candidate: Candidate | null,
  tokens: number,
  decision: Decision,
  detail: string,
  runningTokens: number,
): CandidateRow {
  return {
    fusedRank: candidate ? candidate.fusedRank : null,
    chunk: `${chunk.messageId}:${chunk.chunkIndex}`,
    role: chunk.role,
    estTokens: tokens,
    embeddingRank: candidate ? candidate.embeddingRank : null,
    bm25Rank: candidate ? candidate.bm25Rank : null,
    decision,
    detail,
    runningTokens,
    preview: chunk.text.slice(0, 80),
  };
}

export function assemblePrompt(input: AssemblyInput, opts: AssemblyOptions): AssembledPrompt {
  const { focal, trimmed } = prepareFocal(input.focal);
  const sourceId = focal.source.id;
  const fixedTokens = estimateTokens(joinSections(buildSections(focal, [])));

  const included: Chunk[] = [];
  const rows: CandidateRow[] = [];
  const warnings: string[] = [];

  if (input.mode === 'full') {
    let running = fixedTokens + (input.others.length > 0 ? EXCERPTS_WRAPPER_TOKENS : 0);
    for (const chunk of input.others) {
      const cost = excerptCost(chunk, sourceId);
      running += cost;
      included.push(chunk);
      rows.push(rowFor(chunk, null, cost, 'included', 'full-chat mode: everything is sent', running));
    }
  } else {
    let running = fixedTokens;
    const seenHashes = new Set<string>();
    for (const candidate of input.ranked ?? []) {
      const chunk = candidate.chunk;
      const cost = excerptCost(chunk, sourceId);
      const wrapper = included.length === 0 ? EXCERPTS_WRAPPER_TOKENS : 0;

      if (fixedTokens >= opts.budgetTokens) {
        rows.push(rowFor(chunk, candidate, cost, 'no-room', 'the always-include part already uses the whole budget', running));
      } else if (seenHashes.has(chunk.textHash)) {
        rows.push(rowFor(chunk, candidate, cost, 'duplicate', 'same text as an included chunk', running));
      } else if (included.length >= opts.maxChunks) {
        rows.push(rowFor(chunk, candidate, cost, 'cap', `already ${opts.maxChunks} excerpts`, running));
      } else if (running + wrapper + cost > opts.budgetTokens) {
        rows.push(
          rowFor(
            chunk,
            candidate,
            cost,
            'too-big',
            `needs ${cost + wrapper}, only ${Math.max(0, opts.budgetTokens - running)} left`,
            running,
          ),
        );
      } else {
        running += wrapper + cost;
        seenHashes.add(chunk.textHash);
        included.push(chunk);
        rows.push(rowFor(chunk, candidate, cost, 'included', '', running));
      }
    }

    if (fixedTokens >= opts.budgetTokens) {
      warnings.push(
        `the always-include part alone (≈${fixedTokens} est. tokens) is at or over the budget (${opts.budgetTokens}); no excerpts were added`,
      );
    }
    if (input.ranked !== null && input.ranked.length === 0 && !input.retrievalNote) {
      warnings.push('retrieval returned no candidates');
    }
  }

  included.sort((a, b) => a.order - b.order);
  const sections = buildSections(focal, groupExcerpts(included));
  const prompt = joinSections(sections);
  const totalEstTokens = estimateTokens(prompt);

  if (input.mode === 'full' && totalEstTokens > opts.thresholdTokens) {
    warnings.push(`the full-chat prompt (≈${totalEstTokens} est. tokens) is over the threshold (${opts.thresholdTokens})`);
  }
  for (const name of trimmed) warnings.push(`${name} hit its size ceiling and was trimmed`);
  const questionState: QuestionState = focal.question
    ? focal.question.text.trim()
      ? 'found'
      : 'empty'
    : focal.questionStatus;
  if (questionState === 'empty') {
    warnings.push(
      `the user question (message ${focal.question!.id}) has no readable text — attachment-only, or text the adapter does not read; it was left out of the prompt`,
    );
  } else if (questionState === 'not-loaded') {
    warnings.push(
      `the question that produced this message isn't loaded: the page has a gap right before message ${focal.source.id}, so no question was sent (the nearest mounted user message is not it)`,
    );
  }
  if (focal.orderStatus.note) warnings.push(`page note: ${focal.orderStatus.note}`);
  if (focal.recentShortfall) {
    warnings.push(
      `recent messages: wanted ${focal.recentShortfall.wanted}, found ${focal.recentShortfall.found} — the page has a gap before message ${focal.source.id}, so fewer were sent`,
    );
  }

  const report: PromptReport = {
    mode: input.mode,
    modeReason: input.modeReason,
    budgetTokens: opts.budgetTokens,
    thresholdTokens: opts.thresholdTokens,
    maxChunks: opts.maxChunks,
    totalEstTokens,
    fixedEstTokens: fixedTokens,
    excerptCount: included.length,
    includedChunkIds: included.map((c) => c.id),
    candidates: rows,
    sections: sections.map((s) => ({ name: s.name, estTokens: estimateTokens(s.text) })),
    trimmed,
    warnings,
    retrievalNote: input.retrievalNote ?? null,
    excludedMessageIds: input.excludedMessageIds,
    excludedChunkCount: input.excludedChunkCount,
    demotedRecent: focal.demotedRecent,
    questionState,
    recentShortfall: focal.recentShortfall,
    orderNote: focal.orderStatus.note,
    simplicityLevel: 0,
    levelExtraTokens: 0,
    thread: null,
  };

  return { prompt, report, sections };
}
