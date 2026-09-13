// Handles one 'explain' Port connection: reads context, builds the prompt, calls
// Gemini, and streams chunks/done/error back over the port. `browser` and `Browser`
// are auto-imported project-wide by WXT.

import { EXPLAIN_PORT_NAME, type ExplainToBackground, type ExplainToContent } from '@/messaging/types';
import { buildPrompt } from '@/context/prompt';
import { createGeminiProvider, DEFAULT_MODEL_ID } from '@/llm/gemini';
import { getSettings } from '@/options/storage';

function send(port: Browser.runtime.Port, message: ExplainToContent): void {
  try {
    port.postMessage(message);
  } catch {
    // Port already disconnected (popup closed) — nothing to deliver to.
  }
}

async function handleRequest(port: Browser.runtime.Port, message: ExplainToBackground, signal: AbortSignal): Promise<void> {
  const { requestId, context } = message;

  const settings = await getSettings();
  if (!settings.apiKey) {
    send(port, {
      type: 'explain-error',
      requestId,
      message: 'No Gemini API key set. Add one on the extension options page.',
    });
    return;
  }

  const prompt = buildPrompt(context);

  if (settings.debugEnabled) {
    console.log('[highlight-explainer] prompt sent to Gemini:\n' + prompt);
    console.log('[highlight-explainer] approx tokens:', Math.ceil(prompt.length / 4));
  }

  const provider = createGeminiProvider(settings.apiKey, settings.modelId || DEFAULT_MODEL_ID);

  for await (const chunk of provider.streamExplain(prompt, signal)) {
    send(port, { type: 'explain-chunk', requestId, text: chunk });
  }

  send(port, { type: 'explain-done', requestId });
}

export function registerExplainPortListener(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== EXPLAIN_PORT_NAME) return;

    const controller = new AbortController();
    port.onDisconnect.addListener(() => controller.abort());

    port.onMessage.addListener((raw: unknown) => {
      const message = raw as ExplainToBackground;
      if (message.type !== 'explain-request') return;

      handleRequest(port, message, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) return; // popup closed; nothing to report
        const errorMessage = error instanceof Error ? error.message : 'Unknown error while calling Gemini.';
        send(port, { type: 'explain-error', requestId: message.requestId, message: errorMessage });
      });
    });
  });
}
