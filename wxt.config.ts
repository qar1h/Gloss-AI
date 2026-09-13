import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Highlight Explainer',
    description:
      'Highlight text in an AI chat answer and get a streamed plain-language explanation, right on the page.',
    permissions: ['storage'],
    host_permissions: ['https://claude.ai/*'],
  },
});
