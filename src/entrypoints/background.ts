import { registerExplainPortListener } from '@/background/handleExplain';

export default defineBackground(() => {
  registerExplainPortListener();
});
