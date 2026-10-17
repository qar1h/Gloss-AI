// The I/O half of v5: reads the chat index, decides full-chat vs retrieval, runs the query
// embedding and hybrid search only when needed, then hands plain data to the pure assembler.
// Never throws for a retrieval problem — every failure degrades to a smaller prompt and is
// named in the report. Verified live, like the other IndexedDB/embedder code.

import { embedTexts } from '@/rag/embedder';
import { RRF_DEPTH } from '@/rag/fusion';
import { excludeMessages, hybridSearch } from '@/rag/hybrid';
import { buildSearchQueryText } from '@/rag/query';
import { getAllChunks } from '@/rag/store';
import { getCoverage } from '@/rag/coverage';
import { ensureIndexGeneration } from '@/rag/generation';
import type { Chunk } from '@/rag/types';
import type { Settings } from '@/options/storage';
import { assemblePrompt, chooseMode } from './assemble';
import { EMBED_QUERY_TIMEOUT_MS, resolveAssemblyOptions } from './limits';
import type { AssembledPrompt, Candidate, Coverage, FocalInput, Mode } from './types';

export interface DebugOverride {
  mode?: Mode;
  budgetTokens?: number;
  thresholdTokens?: number;
  maxChunks?: number;
}

export interface PreparedExplain {
  assembled: AssembledPrompt;
  coverage: Coverage;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function prepareExplainPrompt(
  conversationId: string | null,
  focal: FocalInput,
  settings: Settings,
  override: DebugOverride = {},
): Promise<PreparedExplain> {
  const opts = resolveAssemblyOptions({
    budgetTokens: override.budgetTokens ?? settings.promptBudgetTokens,
    thresholdTokens: override.thresholdTokens ?? settings.fullChatThresholdTokens,
    maxChunks: override.maxChunks ?? settings.retrievalK,
  });

  // Messages already sent in full are never retrieved a second time.
  const excluded = new Set<string>([
    focal.source.id,
    ...(focal.question ? [focal.question.id] : []),
    ...focal.recent.map((m) => m.id),
  ]);

  // A site can say the ids on this page are not comparable with the indexed ones (a window that is
  // not connected to what was indexed). Then the index is not read at all: ranking it against ids
  // from another numbering would give a well-formed prompt with chunks in the wrong place.
  const retrievalDisabled = focal.orderStatus.retrieval === 'disabled';

  let retrievalNote: string | undefined;
  let allChunks: Chunk[] = [];
  if (retrievalDisabled) {
    retrievalNote = focal.orderStatus.note ?? 'message order is not trusted here, so the chat index was not searched';
  } else if (conversationId) {
    try {
      // Rows written under another numbering are wiped first (see rag/generationGate.ts).
      await ensureIndexGeneration(conversationId, focal.orderStatus.indexGeneration);
      allChunks = await getAllChunks(conversationId);
    } catch (error) {
      retrievalNote = `could not read the chat index (${describeError(error)})`;
    }
  } else {
    retrievalNote = 'no conversation id on this page';
  }

  const others = excludeMessages(allChunks, excluded).sort((a, b) => a.order - b.order);
  const excludedChunkCount = allChunks.length - others.length;
  const decision = chooseMode(focal, others, opts, override.mode);

  let ranked: Candidate[] | null = null;
  if (decision.mode === 'retrieval' && conversationId && !retrievalDisabled) {
    try {
      let queryVector: number[] | null = null;
      try {
        const [vector] = await withTimeout(
          embedTexts([buildSearchQueryText(focal.highlight, focal.paragraph)]),
          EMBED_QUERY_TIMEOUT_MS,
        );
        queryVector = vector ?? null;
      } catch (error) {
        retrievalNote = `query embedding unavailable (${describeError(error)}) — keyword search only`;
      }
      const ranking = await hybridSearch(conversationId, queryVector, focal.highlight, RRF_DEPTH, excluded);
      ranked = ranking.fused.map((f, index) => ({
        chunk: f.chunk,
        fusedRank: index + 1,
        embeddingRank: f.embeddingRank,
        bm25Rank: f.bm25Rank,
      }));
    } catch (error) {
      retrievalNote = `retrieval failed (${describeError(error)})`;
    }
  }

  const assembled = assemblePrompt(
    {
      focal,
      mode: decision.mode,
      modeReason: decision.reason,
      others,
      ranked,
      retrievalNote,
      excludedMessageIds: [...excluded],
      excludedChunkCount,
    },
    opts,
  );

  const coverage: Coverage = conversationId
    ? await getCoverage(conversationId).catch(() => ({ indexedMessages: 0, totalMessages: null }))
    : { indexedMessages: 0, totalMessages: null };

  return { assembled, coverage };
}
