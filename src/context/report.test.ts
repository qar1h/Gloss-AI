import { describe, expect, it } from 'vitest';
import { candidateTable, describeCoverageForConsole, describeCoveragePopup, sectionTable, summaryLines } from './report';
import type { PromptReport } from './types';

function makeReport(overrides: Partial<PromptReport> = {}): PromptReport {
  return {
    mode: 'retrieval',
    modeReason: 'the whole indexed chat (≈9000 est. tokens) is over the threshold (6000)',
    budgetTokens: 6000,
    thresholdTokens: 6000,
    maxChunks: 8,
    totalEstTokens: 4200,
    fixedEstTokens: 1500,
    excerptCount: 3,
    includedChunkIds: ['a', 'b', 'c'],
    candidates: [
      {
        fusedRank: 1,
        chunk: '243:2',
        role: 'assistant',
        estTokens: 120,
        embeddingRank: 37,
        bm25Rank: 4,
        decision: 'included',
        detail: '',
        runningTokens: 1700,
        preview: 'explains create_engine',
      },
    ],
    sections: [{ name: 'instructions', estTokens: 60 }],
    trimmed: [],
    warnings: [],
    retrievalNote: null,
    excludedMessageIds: ['12', '11', '10'],
    excludedChunkCount: 9,
    demotedRecent: [],
    questionState: 'found',
    recentShortfall: null,
    orderNote: null,
    simplicityLevel: 0,
    levelExtraTokens: 0,
    ...overrides,
  };
}

describe('summaryLines', () => {
  it('states the mode and why, the size against the budget, and the exclusions', () => {
    const lines = summaryLines(makeReport()).join('\n');
    expect(lines).toContain('retrieval');
    expect(lines).toContain('over the threshold');
    expect(lines).toContain('4200');
    expect(lines).toContain('6000');
    expect(lines).toContain('3 of max 8');
    expect(lines).toContain('9 chunks');
    expect(lines).toContain('12, 11, 10');
  });

  it('does not show the retrieval cap as a limit in full-chat mode, where everything is sent', () => {
    const lines = summaryLines(makeReport({ mode: 'full', modeReason: 'the whole indexed chat fits', excerptCount: 10, maxChunks: 8 })).join('\n');
    expect(lines).not.toContain('of max'); // "10 of max 8" read like a bug; the cap only applies to retrieval
    expect(lines).toContain('excerpts 10');
    expect(lines).toContain('full-chat mode');
    expect(lines).toContain('applies to retrieval only');
  });

  it('says which recent messages were too big to always include and were left to retrieval', () => {
    const lines = summaryLines(makeReport({ demotedRecent: [{ id: '255', estTokens: 1670 }] })).join('\n');
    expect(lines).toContain('255');
    expect(lines).toContain('1670');
    expect(lines).toContain('retrieval');
  });

  it('names the level in the summary', () => {
    expect(summaryLines(makeReport())).toContain('simplicity level: 0 of 3 (Explain)');
    expect(summaryLines(makeReport({ simplicityLevel: 2, levelExtraTokens: 41 }))).toContain(
      'simplicity level: 2 of 3 (Explain · even simpler) — instruction ≈+41 est. tokens vs level 0; excerpts are the level-0 selection, the budget is not re-applied',
    );
  });

  it('prints warnings and the retrieval note loudly', () => {
    const lines = summaryLines(makeReport({ warnings: ['too long'], retrievalNote: 'embedding timed out' }));
    expect(lines.some((l) => l.startsWith('WARNING') && l.includes('too long'))).toBe(true);
    expect(lines.some((l) => l.includes('embedding timed out'))).toBe(true);
  });
});

describe('candidateTable', () => {
  it('shows both ranks next to the decision, so retrieval and assembly can be told apart', () => {
    const [row] = candidateTable(makeReport());
    expect(row).toMatchObject({ '#': 1, chunk: '243:2', emb: 37, bm25: 4, decision: 'included' });
  });

  it('shows a dash for a missing rank', () => {
    const report = makeReport();
    report.candidates[0]!.embeddingRank = null;
    expect(candidateTable(report)[0]!.emb).toBe('–');
  });
});

describe('sectionTable', () => {
  it('lists each section with its est. tokens', () => {
    expect(sectionTable(makeReport())).toEqual([{ section: 'instructions', 'est. tokens': 60 }]);
  });
});

describe('describeCoveragePopup', () => {
  it('says how many excerpts and how much of the chat is indexed, flagging a partial index', () => {
    const text = describeCoveragePopup(makeReport(), { indexedMessages: 50, totalMessages: 406 });
    expect(text).toBe('3 excerpts from elsewhere in the chat · 50 of ~406 messages indexed · older messages not loaded');
  });

  it('does not flag a complete index', () => {
    expect(describeCoveragePopup(makeReport({ excerptCount: 1 }), { indexedMessages: 20, totalMessages: 20 })).toBe(
      '1 excerpt from elsewhere in the chat · 20 of ~20 messages indexed',
    );
  });

  it('tells the two causes of a missing question apart in the popup line', () => {
    const coverage = { indexedMessages: 20, totalMessages: 20 };
    expect(describeCoveragePopup(makeReport({ questionState: 'not-loaded' }), coverage)).toBe(
      "3 excerpts from elsewhere in the chat · the question that produced this message isn't loaded · 20 of ~20 messages indexed",
    );
    expect(describeCoveragePopup(makeReport({ questionState: 'empty' }), coverage)).toBe(
      '3 excerpts from elsewhere in the chat · the question message has no readable text · 20 of ~20 messages indexed',
    );
    // normal states say nothing extra
    for (const state of ['found', 'none', 'not-applicable'] as const) {
      expect(describeCoveragePopup(makeReport({ questionState: state }), coverage)).not.toContain('question');
    }
  });

  it('says how many nearby messages were actually loaded when the page has a gap', () => {
    const text = describeCoveragePopup(
      makeReport({ recentShortfall: { wanted: 2, found: 1 } }),
      { indexedMessages: 20, totalMessages: 20 },
    );
    expect(text).toBe('3 excerpts from elsewhere in the chat · only 1 of 2 nearby messages loaded · 20 of ~20 messages indexed');
  });

  it('says so when the whole indexed chat was sent', () => {
    expect(describeCoveragePopup(makeReport({ mode: 'full' }), { indexedMessages: 3, totalMessages: null })).toBe(
      'Whole indexed chat included · 3 messages indexed',
    );
  });

  it('names a failed index read even in full mode, instead of claiming the chat was included', () => {
    const text = describeCoveragePopup(
      makeReport({ mode: 'full', excerptCount: 0, retrievalNote: 'could not read the chat index (boom)' }),
      { indexedMessages: 0, totalMessages: null },
    );
    expect(text).toBe('Retrieval unavailable, nearby messages only · 0 messages indexed');
  });

  it('does not claim older messages are missing when the gap is only the messages sent directly', () => {
    // 2-message chat, nothing indexed yet; messages 0 and 1 are the source/question sent in full.
    const report = makeReport({ mode: 'full', excerptCount: 0, excludedMessageIds: ['1', '0'] });
    expect(describeCoveragePopup(report, { indexedMessages: 0, totalMessages: 2 })).toBe(
      'Whole indexed chat included · 0 of ~2 messages indexed',
    );
  });

  it('puts a site order note first, so it cannot be missed', () => {
    const text = describeCoveragePopup(
      makeReport({ orderNote: 'chat order changed unexpectedly earlier on this page, so the index was rebuilt' }),
      { indexedMessages: 6, totalMessages: null },
    );
    expect(text).toBe(
      'Chat order changed unexpectedly earlier on this page, so the index was rebuilt · 3 excerpts from elsewhere in the chat · 6 messages indexed',
    );
  });

  it('keeps the order note alongside a retrieval-unavailable message', () => {
    const text = describeCoveragePopup(
      makeReport({ excerptCount: 0, retrievalNote: 'jumped here', orderNote: "this part of the chat isn't connected to the indexed part" }),
      { indexedMessages: 6, totalMessages: null },
    );
    expect(text).toBe(
      "This part of the chat isn't connected to the indexed part · retrieval unavailable, nearby messages only · 6 messages indexed",
    );
  });

  it('says retrieval was unavailable when it failed and nothing was added', () => {
    const text = describeCoveragePopup(
      makeReport({ excerptCount: 0, retrievalNote: 'index unreadable' }),
      { indexedMessages: 0, totalMessages: null },
    );
    expect(text).toBe('Retrieval unavailable, nearby messages only · 0 messages indexed');
  });
});

describe('describeCoverageForConsole', () => {
  it('matches the v3/v4 console wording exactly', () => {
    expect(describeCoverageForConsole({ indexedMessages: 50, totalMessages: 406 })).toBe(
      'indexed 50 of ~406 messages in this chat — scroll through more of it to include it in search.',
    );
    expect(describeCoverageForConsole({ indexedMessages: 3, totalMessages: null })).toBe(
      "indexed 3 messages in this chat (true chat length unknown — the last message isn't currently rendered).",
    );
  });
});
