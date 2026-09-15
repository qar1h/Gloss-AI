import { registerExplainPortListener } from '@/background/handleExplain';
import { registerEmbedListener } from '@/background/handleEmbed';

export default defineBackground(() => {
  registerExplainPortListener();
  registerEmbedListener();
});
