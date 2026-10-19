// Wires together selection, the Explain button, the popup, the site adapter, retrieval and
// prompt assembly, and the Port connection to the background worker. A "Simpler" press (v9)
// re-sends the prompt prepared at click time with a simpler instruction: nothing is re-read
// from the page or the index, and the popup's context note is left as it is.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { onSelectionChange, type SelectionInfo } from './ui/selection';
import { createExplainButton } from './ui/explainButton';
import { createPopup } from './ui/popup';
import { readRawFocal, whyNotExplainable } from './readFocal';
import { initPromptDebug, printPrepared, recordPrepared } from './promptDebug';
import { getAdapter, requireAdapter } from '@/sites';
import { initIndexer } from '@/rag/indexer';
import { getSettings } from '@/options/storage';
import { finalizeFocal } from '@/context/focal';
import { prepareExplainPrompt } from '@/context/gather';
import { MAX_SIMPLICITY_LEVEL, SIMPLICITY_LEVELS } from '@/context/levels';
import { resolveRecentCount } from '@/context/limits';
import { describeCoveragePopup } from '@/context/report';
import { promptAtLevel } from '@/context/simplicity';
import { initialSimplerState, simplerButtonView, simplerReduce, type SimplerEvent, type SimplerSend } from './simplerState';
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
    if (!raw) {
      // Not inside a message we can read. Say why, if the site can: a click must not end in silence.
      const why = whyNotExplainable(selection.range);
      if (why) {
        popup.open(selection.rect, () => undefined);
        popup.showError(why);
      }
      return;
    }

    const state: { closed: boolean; port: Browser.runtime.Port | null } = { closed: false, port: null };
    // One Simpler state per popup; startRequest is set once the prompt is prepared.
    let simpler = initialSimplerState();
    let startRequest: ((send: SimplerSend) => void) | null = null;
    const dispatch = (event: SimplerEvent): void => {
      if (state.closed) return;
      const result = simplerReduce(simpler, event);
      simpler = result.state;
      popup.setSimplerButton(simplerButtonView(simpler));
      const send = result.send;
      if (!send || !startRequest) return;
      try {
        startRequest(send);
      } catch (error) {
        // e.g. the extension was reloaded under this tab: connect() throws, and the press must not hang.
        popup.failRegenerate(error instanceof Error ? error.message : String(error));
        dispatch({ type: 'error', request: send.request });
      }
    };

    popup.open(
      selection.rect,
      () => {
        state.closed = true;
        state.port?.disconnect();
      },
      () => dispatch({ type: 'press' }),
    );
    popup.setSimplerButton(simplerButtonView(simpler));

    try {
      const settings = await getSettings();
      const focal = finalizeFocal(raw, resolveRecentCount(settings.recentMessageCount));
      const prepared = await prepareExplainPrompt(requireAdapter().getConversationId(), focal, settings);
      if (state.closed) return; // popup was closed while retrieval ran — send nothing

      popup.setContextNote(describeCoveragePopup(prepared.assembled.report, prepared.coverage));

      startRequest = ({ level, request }) => {
        // Always built from the level-0 prompt of this click, never from the text on screen.
        const sent = { ...prepared, assembled: promptAtLevel(prepared.assembled, level) };
        recordPrepared(sent);
        if (settings.debugEnabled) {
          printPrepared(
            sent,
            level === 0 ? 'prompt sent to Gemini:' : `prompt sent to Gemini (Simpler, level ${level} of ${MAX_SIMPLICITY_LEVEL}):`,
          );
        }
        if (level > 0) popup.beginRegenerate(SIMPLICITY_LEVELS[level]!.label);

        state.port?.disconnect(); // the previous call has finished; nothing more may arrive from it
        const requestId = crypto.randomUUID();
        const port = browser.runtime.connect({ name: EXPLAIN_PORT_NAME });
        state.port = port;

        port.onMessage.addListener((rawMessage: unknown) => {
          const message = rawMessage as ExplainToContent;
          if (message.requestId !== requestId) return;

          if (message.type === 'explain-chunk') {
            popup.appendChunk(message.text);
          } else if (message.type === 'explain-done') {
            popup.markDone();
            dispatch({ type: 'done', request });
          } else if (message.type === 'explain-error') {
            if (level === 0) popup.showError(message.message);
            else popup.failRegenerate(message.message);
            dispatch({ type: 'error', request });
          }
        });

        const outgoing: ExplainToBackground = { type: 'explain-request', requestId, prompt: sent.assembled.prompt };
        port.postMessage(outgoing);
      };
      startRequest({ level: 0, request: 0 });
    } catch (error) {
      if (state.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      popup.showError(`Could not prepare the explanation: ${message}`);
      dispatch({ type: 'error', request: 0 });
    }
  }
}
