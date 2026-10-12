// Turns a PromptReport into the lines and tables the console and popup show. Pure.

import type { Coverage, PromptReport } from './types';

export function summaryLines(report: PromptReport): string[] {
  const lines: string[] = [
    `mode: ${report.mode} — ${report.modeReason}`,
    `prompt: ≈${report.totalEstTokens} est. tokens of ${report.budgetTokens} budget (always-include ≈${report.fixedEstTokens}); excerpts ${report.excerptCount} of max ${report.maxChunks}`,
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
