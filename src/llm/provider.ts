// The interface every LLM backend implements. Gemini (src/llm/gemini.ts) is the only
// implementation for now; this seam exists so a local model can be added later
// without touching anything outside src/llm/.

export interface LLMProvider {
  streamExplain(prompt: string, signal: AbortSignal): AsyncGenerator<string>;
}
