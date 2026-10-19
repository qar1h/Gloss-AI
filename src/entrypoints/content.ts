import { initHighlightExplainer } from '@/content';

export default defineContentScript({
  matches: ['https://claude.ai/*', 'https://chatgpt.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    await initHighlightExplainer(ctx);
  },
});
