// Options form: API key, model id, debug toggle. Reads/writes chrome.storage.local
// directly through src/options/storage.ts — no messaging involved.

import { getSettings, setSettings } from '@/options/storage';
import { DEFAULT_MODEL_ID } from '@/llm/gemini';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const apiKeyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const modelIdInput = document.querySelector<HTMLInputElement>('#model-id')!;
const debugEnabledInput = document.querySelector<HTMLInputElement>('#debug-enabled')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  modelIdInput.value = settings.modelId || DEFAULT_MODEL_ID;
  debugEnabledInput.checked = settings.debugEnabled;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  await setSettings({
    apiKey: apiKeyInput.value.trim(),
    modelId: modelIdInput.value.trim() || DEFAULT_MODEL_ID,
    debugEnabled: debugEnabledInput.checked,
  });

  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
});

void loadSettings();
