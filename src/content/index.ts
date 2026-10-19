// Wires together selection, the Explain button, the popup, the site adapter, retrieval and
// prompt assembly, and the calls to the background worker (one Port per call, explainCall.ts:
// every call ends, even if the background drops the connection). A "Simpler" press (v9)
// re-sends the prompt prepared at click time with a simpler instruction, and a follow-up question
// (v10) sends that same prompt plus the thread (context/thread.ts): nothing is re-read from the
// page or the index, retrieval does not re-run, and the popup's context note keeps its click-time
// text (plus a count when a follow-up's prompt had to leave earlier follow-ups out).
// What the thread holds, and which answer Simpler rewrites, is decided by threadState.ts.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { isInsideHosts, onSelectionChange, type SelectionInfo } from './ui/selection';
import { createExplainButton } from './ui/explainButton';
import { createPopup } from './ui/popup';
import { readRawFocal, whyNotExplainable } from './readFocal';
import { initPromptDebug, printPrepared, recordPrepared } from './promptDebug';
import { getAdapter, requireAdapter } from '@/sites';
import { initIndexer } from '@/rag/indexer';
import { getSettings } from '@/options/storage';
import { finalizeFocal } from '@/context/focal';
import { prepareExplainPrompt } from '@/context/gather';
import { SIMPLICITY_LEVELS } from '@/context/levels';
import { resolveRecentCount } from '@/context/limits';
import { describeCoveragePopup, describeThreadPopup } from '@/context/report';
import { promptAtLevel } from '@/context/simplicity';
import { followUpPrompt } from '@/context/thread';
import {
  composerView,
  describeSend,
  initialThreadState,
  simplerButtonView,
  threadReduce,
  type ThreadEvent,
  type ThreadSend,
} from './threadState';
import { EXPLAIN_PORT_NAME } from '@/messaging/types';
import { startExplainCall, type CallPort, type ExplainCall } from './explainCall';

/** A Port to the background for one call; logs why it closed, if Chrome says. */
function connectExplainPort(): CallPort {
  const port = browser.runtime.connect({ name: EXPLAIN_PORT_NAME });
  port.onDisconnect.addListener(() => {
    const error = browser.runtime.lastError;
    if (error) console.warn('[highlight-explainer] explain connection closed:', error.message);
  });
  return port;
}

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
  // Our own popup and button: a selection touching them never brings up Explain.
  const ownHosts = (): HTMLElement[] =>
    [popup.hostElement(), button.hostElement()].filter((host): host is HTMLElement => host !== null);

  onSelectionChange((info) => {
    lastSelection = info;
    if (info) button.show(info.rect);
    else button.hide();
  }, ownHosts);

  async function handleExplainClick(): Promise<void> {
    const selection = lastSelection;
    if (!selection) return;
    button.hide();
    // Belt and braces: the selection may have changed between showing the button and this click.
    const { startContainer, endContainer } = selection.range;
    if (isInsideHosts(startContainer, ownHosts()) || isInsideHosts(endContainer, ownHosts())) return;

    // Read the page first and synchronously, while the selection is still live.
    const raw = readRawFocal(selection.range, selection.text);
    if (!raw) {
      // Not inside a message we can read. Say why, if the site can: a click must not end in silence.
      const why = whyNotExplainable(selection.range);
      if (why) {
        popup.open(selection.rect, { onClose: () => undefined });
        popup.showError(why);
      }
      return;
    }

    const state: { closed: boolean; call: ExplainCall | null } = { closed: false, call: null };
    // One thread state per popup; startRequest is set once the prompt is prepared.
    let thread = initialThreadState();
    let startRequest: ((send: ThreadSend) => void) | null = null;
    // How a failed call shows itself depends on what it was.
    const showFailure = (send: ThreadSend, message: string): void => {
      if (send.kind === 'follow-up' && !send.regenerate) popup.failFollowUp(message, send.input.question);
      else if (send.kind === 'explanation' && send.level === 0) popup.showError(message);
      else popup.failRegenerate(message);
    };
    const dispatch = (event: ThreadEvent): void => {
      if (state.closed) return;
      const result = threadReduce(thread, event);
      thread = result.state;
      popup.setSimplerButton(simplerButtonView(thread));
      popup.setComposer(composerView(thread));
      const send = result.send;
      if (!send || !startRequest) return;
      try {
        startRequest(send);
      } catch (error) {
        // e.g. the extension was reloaded under this tab: connect() throws, and the press must not hang.
        showFailure(send, error instanceof Error ? error.message : String(error));
        dispatch({ type: 'error', request: send.request });
      }
    };

    popup.open(selection.rect, {
      onClose: () => {
        state.closed = true;
        state.call?.cancel();
      },
      onSimpler: () => dispatch({ type: 'press' }),
      onAsk: (question) => dispatch({ type: 'ask', question }),
    });
    popup.setSimplerButton(simplerButtonView(thread));
    popup.setComposer(composerView(thread));

    try {
      const settings = await getSettings();
      const focal = finalizeFocal(raw, resolveRecentCount(settings.recentMessageCount));
      const prepared = await prepareExplainPrompt(requireAdapter().getConversationId(), focal, settings);
      if (state.closed) return; // popup was closed while retrieval ran — send nothing

      const clickNote = describeCoveragePopup(prepared.assembled.report, prepared.coverage);
      popup.setContextNote(clickNote);

      startRequest = (send) => {
        // Always built from the level-0 prompt of this click, never from the page or the index again.
        const assembled =
          send.kind === 'explanation'
            ? promptAtLevel(prepared.assembled, send.level)
            : followUpPrompt(prepared.assembled, send.input, send.level);
        const sent = { ...prepared, assembled };
        recordPrepared(sent);
        if (settings.debugEnabled) printPrepared(sent, `prompt sent to Gemini${describeSend(send)}:`);

        if (send.kind === 'follow-up' && !send.regenerate) popup.beginFollowUp(send.input.question);
        else if (send.level > 0) popup.beginRegenerate(SIMPLICITY_LEVELS[send.level]!.label);

        state.call?.cancel(); // the previous call has finished; nothing more may arrive from it
        state.call = startExplainCall(connectExplainPort, assembled.prompt, {
          onChunk: (text) => popup.appendChunk(text),
          onDone: (text) => {
            popup.markDone();
            // The note describes the answer now at the bottom: its prompt may have left follow-ups out.
            popup.setContextNote(describeThreadPopup(clickNote, assembled.report.thread));
            dispatch({ type: 'done', request: send.request, text });
          },
          onError: (message) => {
            showFailure(send, message);
            dispatch({ type: 'error', request: send.request });
          },
        });
      };
      startRequest({ kind: 'explanation', level: 0, request: 0 });
    } catch (error) {
      if (state.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      popup.showError(`Could not prepare the explanation: ${message}`);
      dispatch({ type: 'error', request: 0 });
    }
  }
}
