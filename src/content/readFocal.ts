// DOM -> RawFocal, through the site adapter (no selectors here). Shared by the real Explain
// click and the __glossPrompt dry run, so both see exactly the same thing.

import { requireAdapter } from '@/sites';
import type { SiteMessage } from '@/sites/types';
import type { RawFocal } from '@/context/types';
import { MAX_RECENT_COUNT } from '@/context/limits';
import { firstNonPositionId } from '@/rag/positionId';

/**
 * Null when the page gave us a message id that is not a position (see rag/positionId.ts): the
 * prompt's message numbers and before/after labels are computed from ids, so a bad one would
 * produce a well-formed prompt with the wrong order in it. Refusing is the safe answer.
 */
export function rawFocalForMessage(message: SiteMessage, highlight: string, paragraph: string): RawFocal | null {
  const lookup = message.role === 'assistant' ? requireAdapter().getUserQuestionFor(message.id) : null;
  const recent = requireAdapter().getRecentMessages(message.id, MAX_RECENT_COUNT);

  const bad = firstNonPositionId([
    message.id,
    ...(lookup?.message ? [lookup.message.id] : []),
    ...recent.messages.map((m) => m.id),
  ]);
  if (bad !== null) {
    console.warn(`[highlight-explainer] not explaining: a message id from this page is not a position: ${JSON.stringify(bad)}`);
    return null;
  }

  const orderStatus = requireAdapter().getOrderStatus?.(message.id);
  return {
    highlight,
    paragraph,
    ...(orderStatus ? { orderStatus } : {}),
    source: { id: message.id, role: message.role, text: requireAdapter().getMessageContent(message.element) },
    question: lookup?.message ?? null,
    questionStatus: lookup ? lookup.status : 'not-applicable',
    preceding: recent.messages,
    precedingEndsAtGap: recent.endsAtGap,
  };
}

/**
 * Why a selection could not be explained, in a sentence for the popup, or null when the site has
 * nothing to say (the click then does nothing, as it always did on claude.ai). The message having
 * been found but refused is the id guard above; anything else is the adapter's to explain.
 */
export function whyNotExplainable(range: Range): string | null {
  const adapter = requireAdapter();
  if (adapter.getMessageForNode(range.startContainer)) {
    return 'I found this message, but its position on the page looks wrong, so I did not use it. The console has details.';
  }
  return adapter.explainBlockedReason?.(range.startContainer) ?? null;
}

export function readRawFocal(range: Range, highlight: string): RawFocal | null {
  const message = requireAdapter().getMessageForNode(range.startContainer);
  if (!message) return null;
  return rawFocalForMessage(message, highlight, requireAdapter().getParagraphAround(range));
}
