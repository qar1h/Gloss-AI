// Typed get/set for the API key, model id, debug toggle, and retrieval k in
// chrome.storage.local (via WXT's storage helper, which is auto-imported project-wide).

import { DEFAULT_MODEL_ID } from '@/llm/gemini';

export interface Settings {
  apiKey: string;
  modelId: string;
  debugEnabled: boolean;
  retrievalK?: number;
}

const apiKeyItem = storage.defineItem<string>('local:apiKey', { fallback: '' });
const modelIdItem = storage.defineItem<string>('local:modelId', { fallback: DEFAULT_MODEL_ID });
const debugEnabledItem = storage.defineItem<boolean>('local:debugEnabled', { fallback: false });
const retrievalKItem = storage.defineItem<number>('local:retrievalK', { fallback: 5 });

export async function getSettings(): Promise<Settings> {
  const [apiKey, modelId, debugEnabled, retrievalK] = await Promise.all([
    apiKeyItem.getValue(),
    modelIdItem.getValue(),
    debugEnabledItem.getValue(),
    retrievalKItem.getValue(),
  ]);
  return { apiKey, modelId, debugEnabled, retrievalK };
}

export async function setSettings(settings: Settings): Promise<void> {
  await Promise.all([
    apiKeyItem.setValue(settings.apiKey),
    modelIdItem.setValue(settings.modelId),
    debugEnabledItem.setValue(settings.debugEnabled),
    retrievalKItem.setValue(settings.retrievalK ?? 5),
  ]);
}
