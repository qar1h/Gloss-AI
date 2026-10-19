// Turns a PromptReport into the lines and tables the console and popup show. Pure.

import { MAX_SIMPLICITY_LEVEL, SIMPLICITY_LEVELS } from './levels';
import type { Coverage, PromptReport } from './types';

function levelLine(report: PromptReport): string {
  const level = report.simplicityLevel;
  const head = `simplicity level: ${level} of ${MAX_SIMPLICITY_LEVEL} (${SIMPLICITY_LEVELS[level]?.label ?? 'unknown'})`;
  if (level === 0) return head;
  const extra = report.levelExtraTokens;
  return `${head} — instruction ≈${extra >= 0 ? '+' : ''}${extra} est. tokens vs level 0; excerpts are the level-0 selection, the budget is not re-applied`;
}

/** What a follow-up carried of the thread (v10); nothing for Explain or Simpler on the explanation. */
function threadLines(report: PromptReport): string[] {
  const t = report.thread;
  if (!t) return [];
  const earlier = t.includedExchanges.length > 0 ? `earlier follow-ups ${t.includedExchanges.join(', ')}` : 'no earlier follow-ups';
  const lines = [
    `thread: follow-up ${t.followUpNumber}; ≈${t.usedEstTokens} of ${t.budgetTokens} thread-budget est. tokens used (explanation ≈${t.explanationEstTokens}; ${earlier}); new question ≈${t.questionEstTokens}`,
  ];
  if (t.droppedExchanges.length > 0) {
    const list = t.droppedExchanges.map((d) => `follow-up ${d.number} (≈${d.estTokens})`).join(', ');
    lines.push(`left out of the thread to fit its budget (oldest first): ${list}`);
  }
  return lines;
}

export function summaryLines(report: PromptReport): string[] {
  const lines: string[] = [
    `mode: ${report.mode} — ${report.modeReason}`,
    `prompt: ≈${report.totalEstTokens} est. tokens of ${report.budgetTokens} budget (always-include ≈${report.fixedEstTokens}); ${
      report.mode === 'full'
        ? `excerpts ${report.excerptCount} (full-chat mode sends all of them; the max of ${report.maxChunks} applies to retrieval only)`
        : `excerpts ${report.excerptCount} of max ${report.maxChunks}`
    }${report.thread ? `; the thread is on top of this budget (it has its own: ${report.thread.budgetTokens})` : ''}`,
    levelLine(report),
    ...threadLines(report),
  ];
  if (report.excludedMessageIds.length > 0) {
    lines.push(
      `excluded before ranking (already sent in full): ${report.excludedChunkCount} chunks from messages ${report.excludedMessageIds.join(', ')}`,
    );
  }
  if (report.demotedRecent.length > 0) {
    const list = report.demotedRecent.map((m) => `${m.id} (≈${m.estTokens} est. tokens)`).join(', ');
    lines.push(`recent messages too big to always include, left to retrieval instead: ${list}`);
  }
  if (report.retrievalNote) lines.push(`retrieval note: ${report.retrievalNote}`);
  for (const warning of report.warnings) lines.push(`WARNING: ${warning}`);
  return lines;
}

export function candidateTable(report: PromptReport): Record<string, string | number>[] {
  return report.candidates.map((row) => ({
    '#': row.fusedRank ?? '–',
    chunk: row.chunk,
    role: row.role,
    'est. tokens': row.estTokens,
    emb: row.embeddingRank ?? '–',
    bm25: row.bm25Rank ?? '–',
    decision: row.decision,
    detail: row.detail,
    // Priced chunk by chunk for the budget check, so it can sit a little above the final
    // total (merging adjacent chunks into one excerpt saves their headers).
    'running (upper bound)': row.runningTokens,
    preview: row.preview,
  }));
}

export function sectionTable(report: PromptReport): Record<string, string | number>[] {
  return report.sections.map((s) => ({ section: s.name, 'est. tokens': s.estTokens }));
}

/** The single muted line under the answer in the popup. */
export function describeCoveragePopup(report: PromptReport, coverage: Coverage): string {
  const parts: string[] = [];

  // A failure is named first, in either mode: an unreadable index leaves nothing to retrieve,
  // which would otherwise look like a healthy "whole chat included".
  if (report.retrievalNote && report.excerptCount === 0) {
    parts.push('retrieval unavailable, nearby messages only');
  } else if (report.mode === 'full') {
    parts.push('whole indexed chat included');
  } else if (report.excerptCount === 0) {
    parts.push('no extra excerpts');
  } else {
    const noun = report.excerptCount === 1 ? 'excerpt' : 'excerpts';
    parts.push(`${report.excerptCount} ${noun} from elsewhere in the chat${report.retrievalNote ? ' (limited search)' : ''}`);
  }

  // Two different reasons a question can be missing, worded differently on purpose.
  if (report.questionState === 'not-loaded') parts.push("the question that produced this message isn't loaded");
  else if (report.questionState === 'empty') parts.push('the question message has no readable text');
  if (report.recentShortfall) {
    parts.push(`only ${report.recentShortfall.found} of ${report.recentShortfall.wanted} nearby messages loaded`);
  }

  if (coverage.totalMessages !== null) {
    parts.push(`${coverage.indexedMessages} of ~${coverage.totalMessages} messages indexed`);
    // The messages sent in full (source, question, recent) may simply not be indexed yet, e.g.
    // in a brand-new chat; only a bigger gap than that means older messages aren't loaded.
    const missing = coverage.totalMessages - coverage.indexedMessages;
    if (missing > report.excludedMessageIds.length) parts.push('older messages not loaded');
  } else {
    parts.push(`${coverage.indexedMessages} messages indexed`);
  }

  // A site's caveat about what the page gave us (message order, code only partly on the page) goes first: it is the one thing the user must not miss.
  if (report.orderNote) parts.unshift(report.orderNote);

  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The v3/v4 console wording, unchanged. */
export function describeCoverageForConsole(coverage: Coverage): string {
  if (coverage.totalMessages !== null) {
    return `indexed ${coverage.indexedMessages} of ~${coverage.totalMessages} messages in this chat — scroll through more of it to include it in search.`;
  }
  return `indexed ${coverage.indexedMessages} messages in this chat (true chat length unknown — the last message isn't currently rendered).`;
}
