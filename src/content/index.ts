// Wires together selection, the Explain button, the popup, the site adapter, retrieval and
// prompt assembly, and the Port connection to the background worker.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { onSelectionChange, type SelectionInfo } from './ui/selection';
import { createExplainButton } from './ui/explainButton';
import { createPopup } from './ui/popup';
import { readRawFocal } from './readFocal';
import { initPromptDebug, printPrepared, recordPrepared } from './promptDebug';
import { getAdapter, requireAdapter } from '@/sites';
import { initIndexer } from '@/rag/indexer';
import { getSettings } from '@/options/storage';
import { finalizeFocal } from '@/context/focal';
import { prepareExplainPrompt } from '@/context/gather';
import { resolveRecentCount } from '@/context/limits';
import { describeCoveragePopup } from '@/context/report';
import {
  EXPLAIN_PORT_NAME,
  type ExplainToBackground,
  type ExplainToContent,
} from '@/messaging/types';

export async function initHighlightExplainer(ctx: ContentScriptContext): Promise<void> {
  if (!getAdapter()) return; // a page we have no adapter for: do nothing at all
  ctx.onInvalidated(initIndexer());
  initPromptDebug();

  const button = await createExplainButton(ctx, () => {
    handleExplainClick().catch((error: unknown) => {
      // Only reachable if reading the page itself throws, before the popup is open.
      console.warn('[highlight-explainer] could not start an explanation:', error);
    });
  });
  const popup = await createPopup(ctx);

  let lastSelection: SelectionInfo | null = null;

  onSelectionChange((info) => {
    lastSelection = info;
    if (info) button.show(info.rect);
    else button.hide();
  });

  async function handleExplainClick(): Promise<void> {
    const selection = lastSelection;
    if (!selection) return;
    button.hide();

    // Read the page first and synchronously, while the selection is still live.
    const raw = readRawFocal(selection.range, selection.text);
    if (!raw) return; // selection wasn't inside a recognized chat message

    const state: { closed: boolean; port: Browser.runtime.Port | null } = { closed: false, port: null };
    popup.open(selection.rect, () => {
      state.closed = true;
      state.port?.disconnect();
    });

    try {
      const settings = await getSettings();
      const focal = finalizeFocal(raw, resolveRecentCount(settings.recentMessageCount));
      const prepared = await prepareExplainPrompt(requireAdapter().getConversationId(), focal, settings);
      if (state.closed) return; // popup was closed while retrieval ran — send nothing

      recordPrepared(prepared);
      if (settings.debugEnabled) printPrepared(prepared, 'prompt sent to Gemini:');
      popup.setContextNote(describeCoveragePopup(prepared.assembled.report, prepared.coverage));

      const requestId = crypto.randomUUID();
      const port = browser.runtime.connect({ name: EXPLAIN_PORT_NAME });
      state.port = port;

      port.onMessage.addListener((rawMessage: unknown) => {
        const message = rawMessage as ExplainToContent;
        if (message.requestId !== requestId) return;

        if (message.type === 'explain-chunk') popup.appendChunk(message.text);
        else if (message.type === 'explain-done') popup.markDone();
        else if (message.type === 'explain-error') popup.showError(message.message);
      });

      const request: ExplainToBackground = { type: 'explain-request', requestId, prompt: prepared.assembled.prompt };
      port.postMessage(request);
    } catch (error) {
      if (state.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      popup.showError(`Could not prepare the explanation: ${message}`);
    }
  }
}
