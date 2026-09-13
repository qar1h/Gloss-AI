import { initHighlightExplainer } from '@/content';

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    await initHighlightExplainer(ctx);
  },
});
