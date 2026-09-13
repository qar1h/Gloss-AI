// Wires together selection, the Explain button, the popup, the site adapter, and the
// Port connection to the background worker.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { onSelectionChange, type SelectionInfo } from './ui/selection';
import { createExplainButton } from './ui/explainButton';
import { createPopup } from './ui/popup';
import { claudeAdapter } from '@/sites/claude';
import { initIndexer } from '@/rag/indexer';
import {
  EXPLAIN_PORT_NAME,
  type ExplainContext,
  type ExplainToBackground,
  type ExplainToContent,
} from '@/messaging/types';

const RECENT_MESSAGE_COUNT = 6;

export async function initHighlightExplainer(ctx: ContentScriptContext): Promise<void> {
  ctx.onInvalidated(initIndexer());

  const button = await createExplainButton(ctx, () => void handleExplainClick());
  const popup = await createPopup(ctx);

  let lastSelection: SelectionInfo | null = null;

  onSelectionChange((info) => {
    lastSelection = info;
    if (info) button.show(info.rect);
    else button.hide();
  });

  function buildContext(selection: SelectionInfo): ExplainContext | null {
    const siteMessage = claudeAdapter.getMessageForNode(selection.range.startContainer);
    if (!siteMessage) return null;

    const paragraph = claudeAdapter.getParagraphAround(selection.range);
    const messageText = claudeAdapter.getMessageText(siteMessage.element);
    const userQuestion =
      siteMessage.role === 'assistant' ? claudeAdapter.getUserQuestionFor(siteMessage.id) ?? '' : '';
    const recentMessages = claudeAdapter.getRecentMessages(siteMessage.id, RECENT_MESSAGE_COUNT);

    return {
      highlight: selection.text,
      paragraph,
      message: { role: siteMessage.role, text: messageText },
      userQuestion,
      recentMessages,
    };
  }

  async function handleExplainClick(): Promise<void> {
    const selection = lastSelection;
    if (!selection) return;
    button.hide();

    const context = buildContext(selection);
    if (!context) return; // selection wasn't inside a recognized chat message

    const requestId = crypto.randomUUID();
    const port = browser.runtime.connect({ name: EXPLAIN_PORT_NAME });

    popup.open(selection.rect, () => port.disconnect());

    port.onMessage.addListener((raw: unknown) => {
      const message = raw as ExplainToContent;
      if (message.requestId !== requestId) return;

      if (message.type === 'explain-chunk') popup.appendChunk(message.text);
      else if (message.type === 'explain-done') popup.markDone();
      else if (message.type === 'explain-error') popup.showError(message.message);
    });

    const request: ExplainToBackground = { type: 'explain-request', requestId, context };
    port.postMessage(request);
  }
}
