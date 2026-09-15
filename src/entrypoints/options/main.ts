// Options form: API key, model id, debug toggle, retrieval k. Reads/writes chrome.storage.local
// directly through src/options/storage.ts — no messaging involved.

import { getSettings, setSettings } from '@/options/storage';
import { DEFAULT_MODEL_ID } from '@/llm/gemini';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const apiKeyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const modelIdInput = document.querySelector<HTMLInputElement>('#model-id')!;
const debugEnabledInput = document.querySelector<HTMLInputElement>('#debug-enabled')!;
const retrievalKInput = document.querySelector<HTMLInputElement>('#retrieval-k')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  modelIdInput.value = settings.modelId || DEFAULT_MODEL_ID;
  debugEnabledInput.checked = settings.debugEnabled;
  retrievalKInput.value = String(settings.retrievalK || 5);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const parsedK = Math.round(Number(retrievalKInput.value));

  await setSettings({
    apiKey: apiKeyInput.value.trim(),
    modelId: modelIdInput.value.trim() || DEFAULT_MODEL_ID,
    debugEnabled: debugEnabledInput.checked,
    retrievalK: Number.isFinite(parsedK) && parsedK > 0 ? parsedK : 5,
  });

  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

void loadSettings();
