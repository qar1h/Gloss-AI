import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Lets tests import modules that use the extension's `@/` alias (the I/O layers: context/gather.ts,
// rag/indexer.ts), with their storage, embedder and site dependencies mocked. Pure modules use
// relative imports and never needed this. `npm run bench` has its own config in bench/.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
