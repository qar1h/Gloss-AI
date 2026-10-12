// Typed get/set for the API key, model id, debug toggle, and the retrieval/prompt settings in
// chrome.storage.local (via WXT's storage helper, which is auto-imported project-wide).

import { DEFAULT_MODEL_ID } from '@/llm/gemini';
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_RECENT_COUNT,
  DEFAULT_THRESHOLD_TOKENS,
} from '@/context/limits';

export interface Settings {
  apiKey: string;
  modelId: string;
  debugEnabled: boolean;
  /** Max excerpts added to an explain prompt; also the default k of __glossSearch / __glossHybrid. */
  retrievalK: number;
  /** Whole-prompt budget, in estimated tokens (characters / 4). */
  promptBudgetTokens: number;
  /** Chats whose whole indexed text fits this are sent in full, with no retrieval. */
  fullChatThresholdTokens: number;
  /** Messages immediately before the explained one that are always included (the question counts as one). */
  recentMessageCount: number;
}

const apiKeyItem = storage.defineItem<string>('local:apiKey', { fallback: '' });
const modelIdItem = storage.defineItem<string>('local:modelId', { fallback: DEFAULT_MODEL_ID });
const debugEnabledItem = storage.defineItem<boolean>('local:debugEnabled', { fallback: false });
const retrievalKItem = storage.defineItem<number>('local:retrievalK', { fallback: DEFAULT_MAX_CHUNKS });
const promptBudgetItem = storage.defineItem<number>('local:promptBudgetTokens', { fallback: DEFAULT_BUDGET_TOKENS });
const thresholdItem = storage.defineItem<number>('local:fullChatThresholdTokens', {
  fallback: DEFAULT_THRESHOLD_TOKENS,
});
const recentCountItem = storage.defineItem<number>('local:recentMessageCount', { fallback: DEFAULT_RECENT_COUNT });

export async function getSettings(): Promise<Settings> {
  const [apiKey, modelId, debugEnabled, retrievalK, promptBudgetTokens, fullChatThresholdTokens, recentMessageCount] =
    await Promise.all([
      apiKeyItem.getValue(),
      modelIdItem.getValue(),
      debugEnabledItem.getValue(),
      retrievalKItem.getValue(),
      promptBudgetItem.getValue(),
      thresholdItem.getValue(),
      recentCountItem.getValue(),
    ]);
  return {
    apiKey,
    modelId,
    debugEnabled,
    retrievalK,
    promptBudgetTokens,
    fullChatThresholdTokens,
    recentMessageCount,
  };
}

export async function setSettings(settings: Settings): Promise<void> {
  await Promise.all([
    apiKeyItem.setValue(settings.apiKey),
    modelIdItem.setValue(settings.modelId),
    debugEnabledItem.setValue(settings.debugEnabled),
    retrievalKItem.setValue(settings.retrievalK),
    promptBudgetItem.setValue(settings.promptBudgetTokens),
    thresholdItem.setValue(settings.fullChatThresholdTokens),
    recentCountItem.setValue(settings.recentMessageCount),
  ]);
}
