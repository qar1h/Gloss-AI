// Applies the `recentMessageCount` setting to what the DOM gave us. Pure.

import { RECENT_ALWAYS_MAX_TOKENS } from './limits';
import { estimateTokens } from './tokens';
import type { FocalInput, OrderStatus, PromptMessage, RawFocal } from './types';

/** The order status of a site whose message order is fully known (Claude): nothing to say, nothing disabled. */
export const ORDER_OK: OrderStatus = { retrieval: 'ok', note: null, indexGeneration: null };

/**
 * "Recent" = the nearest `recentCount` messages immediately before the source message. The
 * question message is usually one of them; it has its own slot in the prompt, so it is
 * removed here rather than sent twice. A count of 0 means none (the question is still sent).
 *
 * A recent message bigger than RECENT_ALWAYS_MAX_TOKENS is demoted: it is left out of `recent`
 * (so it is not sent whole) and, because gather.ts only excludes what is in `recent`, its
 * chunks stay in the retrieval pool and compete on merit. The question is never demoted.
 */
export function finalizeFocal(raw: RawFocal, recentCount: number): FocalInput {
  const count = Math.max(0, Math.floor(recentCount));
  const nearest = count === 0 ? [] : raw.preceding.slice(Math.max(0, raw.preceding.length - count));

  const recent: PromptMessage[] = [];
  const demotedRecent: { id: string; estTokens: number }[] = [];
  for (const message of nearest) {
    if (message.id === raw.question?.id) continue;
    const estTokens = estimateTokens(message.text);
    if (estTokens > RECENT_ALWAYS_MAX_TOKENS) demotedRecent.push({ id: message.id, estTokens });
    else recent.push(message);
  }

  // Only a shortfall caused by a gap in the page is reported: a chat that simply starts there
  // has no more messages to find, and asking for more than exist is not a problem.
  const recentShortfall =
    raw.precedingEndsAtGap && raw.preceding.length < count ? { wanted: count, found: raw.preceding.length } : null;

  return {
    highlight: raw.highlight,
    paragraph: raw.paragraph,
    source: raw.source,
    question: raw.question,
    questionStatus: raw.questionStatus,
    recent,
    demotedRecent,
    recentShortfall,
    orderStatus: raw.orderStatus ?? ORDER_OK,
  };
}
