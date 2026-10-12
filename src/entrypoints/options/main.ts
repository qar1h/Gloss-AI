// Options form: API key, model id, debug toggle, and the retrieval/prompt numbers. Reads/writes
// chrome.storage.local directly through src/options/storage.ts — no messaging involved.

import { getSettings, setSettings } from '@/options/storage';
import { DEFAULT_MODEL_ID } from '@/llm/gemini';
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_RECENT_COUNT,
  DEFAULT_THRESHOLD_TOKENS,
  resolveAssemblyOptions,
  resolveRecentCount,
} from '@/context/limits';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const apiKeyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const modelIdInput = document.querySelector<HTMLInputElement>('#model-id')!;
const debugEnabledInput = document.querySelector<HTMLInputElement>('#debug-enabled')!;
const retrievalKInput = document.querySelector<HTMLInputElement>('#retrieval-k')!;
const promptBudgetInput = document.querySelector<HTMLInputElement>('#prompt-budget')!;
const thresholdInput = document.querySelector<HTMLInputElement>('#full-chat-threshold')!;
const recentCountInput = document.querySelector<HTMLInputElement>('#recent-count')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  modelIdInput.value = settings.modelId || DEFAULT_MODEL_ID;
  debugEnabledInput.checked = settings.debugEnabled;
  retrievalKInput.value = String(settings.retrievalK || DEFAULT_MAX_CHUNKS);
  promptBudgetInput.value = String(settings.promptBudgetTokens || DEFAULT_BUDGET_TOKENS);
  thresholdInput.value = String(settings.fullChatThresholdTokens || DEFAULT_THRESHOLD_TOKENS);
  recentCountInput.value = String(settings.recentMessageCount ?? DEFAULT_RECENT_COUNT);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const numbers = resolveAssemblyOptions({
    budgetTokens: Number(promptBudgetInput.value),
    thresholdTokens: Number(thresholdInput.value),
    maxChunks: Number(retrievalKInput.value),
  });

  await setSettings({
    apiKey: apiKeyInput.value.trim(),
    modelId: modelIdInput.value.trim() || DEFAULT_MODEL_ID,
    debugEnabled: debugEnabledInput.checked,
    retrievalK: numbers.maxChunks,
    promptBudgetTokens: numbers.budgetTokens,
    fullChatThresholdTokens: numbers.thresholdTokens,
    // An empty field is "not set" (the default), not 0 — Number('') would be 0.
    recentMessageCount: resolveRecentCount(recentCountInput.value.trim() === '' ? undefined : Number(recentCountInput.value)),
  });

  await loadSettings(); // show the values that were actually stored (bad input is clamped)
  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

void loadSettings();
