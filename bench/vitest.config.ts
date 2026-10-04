import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Used only by `npm run bench`. The root `npm test` has no config and its default include
// pattern (*.test.ts / *.spec.ts) never matches *.bench.ts.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: { include: ['bench/**/*.bench.ts'] },
});
