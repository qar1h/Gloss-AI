// Shared shapes for prompt assembly. Type-only, no runtime code.

import type { Chunk } from '../rag/types';

export type Role = 'user' | 'assistant';

export interface PromptMessage {
  /** The message's position as a decimal integer string (Claude's `data-index`, or a ChatGPT frame position; see SiteMessage.id). */
  id: string;
  role: Role;
  text: string;
}

/**
 * Why there is (or isn't) a question:
 *   found          — the user message that produced the answer was read.
 *   not-applicable — the highlighted message is itself a user message.
 *   not-loaded     — the page has a gap right before the message (claude.ai virtualization), so
 *                    the question isn't mounted; the nearest mounted user row is NOT it.
 *   none           — the walk reached the start of the chat without finding a user message.
 * (A question whose text is empty is a separate case, detected at assembly time.)
 */
export type QuestionStatus = 'found' | 'not-applicable' | 'not-loaded' | 'none';

/** QuestionStatus plus the assembly-time case of a question message with no readable text. */
export type QuestionState = QuestionStatus | 'empty';

/**
 * How far the message order on this page can be trusted, set by site adapters whose order is only
 * partly known (ChatGPT). Sites with a real index (Claude) never set it.
 */
export interface OrderStatus {
  /**
   * 'disabled': the ids on this page are not comparable with the indexed ones (the window is
   * detached from what was indexed), so the index must not be searched. The always-include
   * material is still sent.
   */
  retrieval: 'ok' | 'disabled';
  /** A plain sentence for the popup and the debug report, or null. A caveat about what the page gave us: the message order, or content that was only partly on the page. */
  note: string | null;
  /** The numbering the ids were assigned under; the stored index is wiped if it was written under another. */
  indexGeneration: string | null;
}

/** What the DOM gives us for one highlight, before the recent-message setting is applied. */
export interface RawFocal {
  highlight: string;
  paragraph: string;
  source: PromptMessage;
  question: PromptMessage | null;
  questionStatus: QuestionStatus;
  /** Up to MAX_RECENT_COUNT messages immediately before the source, contiguous, chat order (oldest first). */
  preceding: PromptMessage[];
  /** The walk back stopped at a gap in the page, not at the start of the chat, with fewer than MAX_RECENT_COUNT found. */
  precedingEndsAtGap: boolean;
  /** Absent on sites whose order is fully known. */
  orderStatus?: OrderStatus;
}

/** The always-include material for one explain request. */
export interface FocalInput {
  highlight: string;
  paragraph: string;
  source: PromptMessage;
  question: PromptMessage | null;
  questionStatus: QuestionStatus;
  /** Messages just before the source, chat order, with the question message removed (it has its own slot). */
  recent: PromptMessage[];
  /** Recent messages too big to always include (see RECENT_ALWAYS_MAX_TOKENS); not in `recent`, and not excluded from retrieval. */
  demotedRecent: { id: string; estTokens: number }[];
  /** Set only when the page has a gap and fewer nearby messages were found than asked for. */
  recentShortfall: { wanted: number; found: number } | null;
  orderStatus: OrderStatus;
}

/** One entry of the fused retrieval ranking. */
export interface Candidate {
  chunk: Chunk;
  fusedRank: number;
  embeddingRank: number | null;
  bm25Rank: number | null;
}

export type Mode = 'full' | 'retrieval';

export type Decision = 'included' | 'duplicate' | 'cap' | 'too-big' | 'no-room';

export interface CandidateRow {
  /** null in full mode, where there is no ranking. */
  fusedRank: number | null;
  /** `${messageId}:${chunkIndex}` */
  chunk: string;
  role: Role;
  estTokens: number;
  embeddingRank: number | null;
  bm25Rank: number | null;
  decision: Decision;
  detail: string;
  /** Running prompt total (est. tokens) after this decision. */
  runningTokens: number;
  preview: string;
}

export interface SectionSize {
  name: string;
  estTokens: number;
}

/** One named piece of the prompt, in order. The last one is always `task`, the instruction. */
export interface Section {
  name: string;
  text: string;
}

export interface PromptReport {
  mode: Mode;
  modeReason: string;
  budgetTokens: number;
  thresholdTokens: number;
  maxChunks: number;
  totalEstTokens: number;
  /** Instructions + always-include sections, before any excerpt. */
  fixedEstTokens: number;
  excerptCount: number;
  includedChunkIds: string[];
  candidates: CandidateRow[];
  sections: SectionSize[];
  /** Names of items that hit a per-item ceiling and were trimmed. */
  trimmed: string[];
  warnings: string[];
  /** Why retrieval was degraded or skipped, if it was (embedding failure, unreadable index…). */
  retrievalNote: string | null;
  excludedMessageIds: string[];
  excludedChunkCount: number;
  /** Recent messages left to retrieval because they were too big to always include. */
  demotedRecent: { id: string; estTokens: number }[];
  questionState: QuestionState;
  recentShortfall: { wanted: number; found: number } | null;
  /** A site-supplied caveat (see OrderStatus: message order, or content only partly on the page), shown first in the popup. */
  orderNote: string | null;
  /** Which "Simpler" level this prompt is for; 0 = the original instruction (see levels.ts). */
  simplicityLevel: number;
  /** Est. tokens this prompt has over its level-0 version (the instruction is longer); 0 at level 0. */
  levelExtraTokens: number;
}

export interface AssembledPrompt {
  prompt: string;
  report: PromptReport;
  /** The prompt's pieces, so a "Simpler" press can swap the instruction and keep everything else. */
  sections: Section[];
}

/** How much of the chat the index covers. */
export interface Coverage {
  indexedMessages: number;
  /** The chat's true length, only known while its last row is mounted. */
  totalMessages: number | null;
}
