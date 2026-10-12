// DOM -> RawFocal, through the site adapter (no selectors here). Shared by the real Explain
// click and the __glossPrompt dry run, so both see exactly the same thing.

import { claudeAdapter } from '@/sites/claude';
import type { SiteMessage } from '@/sites/types';
import type { RawFocal } from '@/context/types';
import { MAX_RECENT_COUNT } from '@/context/limits';

export function rawFocalForMessage(message: SiteMessage, highlight: string, paragraph: string): RawFocal {
  const lookup = message.role === 'assistant' ? claudeAdapter.getUserQuestionFor(message.id) : null;
  const recent = claudeAdapter.getRecentMessages(message.id, MAX_RECENT_COUNT);
  return {
    highlight,
    paragraph,
    source: { id: message.id, role: message.role, text: claudeAdapter.getMessageContent(message.element) },
    question: lookup?.message ?? null,
    questionStatus: lookup ? lookup.status : 'not-applicable',
    preceding: recent.messages,
    precedingEndsAtGap: recent.endsAtGap,
  };
}

export function readRawFocal(range: Range, highlight: string): RawFocal | null {
  const message = claudeAdapter.getMessageForNode(range.startContainer);
  if (!message) return null;
  return rawFocalForMessage(message, highlight, claudeAdapter.getParagraphAround(range));
}
