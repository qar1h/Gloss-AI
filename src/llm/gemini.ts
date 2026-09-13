// LLMProvider implementation for the Gemini streamGenerateContent REST endpoint (SSE),
// per CLAUDE.md's tech stack choice. Retries on HTTP 429 with exponential backoff + jitter,
// per Gemini's own troubleshooting guidance (retry only transient errors: 429, 408, 5xx).
//
// The SSE `data:` payload shape has changed over time; this parser accepts either the
// classic `{ candidates: [{ content: { parts: [{ text }] } }] }` shape or the newer
// content-event shape `{ delta: { type: 'text', text } }` (skipping non-text deltas like
// `thought_summary`), so it keeps working across that change.

import type { LLMProvider } from './provider';

/** Single place to change the model id. Verify current free-tier Flash model ids in Google AI Studio. */
export const DEFAULT_MODEL_ID = 'gemini-3.5-flash-lite';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.random() * BASE_DELAY_MS;
  return exponential + jitter;
}

function extractTextFromSseData(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const delta = obj.delta as Record<string, unknown> | undefined;
  if (delta && delta.type === 'text' && typeof delta.text === 'string') {
    return delta.text;
  }

  const candidates = obj.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (parts && parts.length > 0) {
    const text = parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
    return text || null;
  }

  return null;
}

const BENIGN_FINISH_REASONS = new Set(['STOP', 'MAX_TOKENS']);

/** If Gemini blocked or cut off generation, describe why — so a failure is diagnosable instead of silent. */
function extractBlockReason(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const promptFeedback = obj.promptFeedback as Record<string, unknown> | undefined;
  if (typeof promptFeedback?.blockReason === 'string') {
    return `Gemini blocked the request before answering (${promptFeedback.blockReason}).`;
  }

  const candidates = obj.candidates as Array<Record<string, unknown>> | undefined;
  const finishReason = candidates?.[0]?.finishReason;
  if (typeof finishReason === 'string' && !BENIGN_FINISH_REASONS.has(finishReason)) {
    return `Gemini stopped without a full answer (${finishReason}).`;
  }

  return null;
}

function splitCompleteSseEvents(buffer: string): { events: string[]; rest: string } {
  const events = buffer.split('\n\n');
  const rest = events.pop() ?? '';
  return { events, rest };
}

function dataLinesFrom(event: string): string[] {
  return event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
}

async function openStream(
  prompt: string,
  apiKey: string,
  modelId: string,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API_BASE}/${modelId}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal,
    });

    if (response.ok) return response;

    if (response.status === 429 && attempt < MAX_RETRIES) {
      await sleep(backoffDelay(attempt));
      continue;
    }

    const errorBody = await response.text().catch(() => '');
    throw new Error(`Gemini request failed (${response.status}): ${errorBody || response.statusText}`);
  }
}

export function createGeminiProvider(apiKey: string, modelId: string): LLMProvider {
  return {
    async *streamExplain(prompt: string, signal: AbortSignal): AsyncGenerator<string> {
      const response = await openStream(prompt, apiKey, modelId, signal);
      const body = response.body;
      if (!body) throw new Error('Gemini response had no readable body.');

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let yieldedAny = false;
      let blockReason: string | null = null;

      function* processEvents(events: string[]): Generator<string> {
        for (const event of events) {
          for (const dataLine of dataLinesFrom(event)) {
            if (!dataLine || dataLine === '[DONE]') continue;

            let payload: unknown;
            try {
              payload = JSON.parse(dataLine);
            } catch {
              console.warn('[highlight-explainer] could not parse Gemini SSE data line:', dataLine);
              continue;
            }

            const text = extractTextFromSseData(payload);
            if (text) {
              yieldedAny = true;
              yield text;
              continue;
            }

            const reason = extractBlockReason(payload);
            if (reason) {
              blockReason = reason;
            } else {
              console.warn('[highlight-explainer] Gemini SSE payload had no recognized text or block reason:', payload);
            }
          }
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush whatever's left in the buffer — the final event isn't guaranteed
            // to be followed by a trailing blank line before the connection closes.
            if (buffer.trim()) yield* processEvents([buffer]);
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = splitCompleteSseEvents(buffer);
          buffer = rest;
          yield* processEvents(events);
        }
      } finally {
        reader.releaseLock();
      }

      if (!yieldedAny) {
        throw new Error(
          blockReason ?? 'Gemini returned no text. Turn on debug mode and check the background console for details.',
        );
      }
    },
  };
}
