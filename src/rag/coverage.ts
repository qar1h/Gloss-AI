// How much of the chat the index covers: the number of distinct indexed messages against the
// chat's true length, which is only known while the last row is mounted (claude.ai virtualizes
// long chats). I/O — verified live, like the console commands that print it.

import { claudeAdapter } from '@/sites/claude';
import type { Coverage } from '@/context/types';
import { getAllMessageRecords } from './store';

export async function getCoverage(conversationId: string): Promise<Coverage> {
  const lastPosition = claudeAdapter.getLastMessagePosition();
  const records = await getAllMessageRecords(conversationId);
  return {
    indexedMessages: new Set(records.map((r) => r.position)).size,
    totalMessages: lastPosition === null ? null : lastPosition + 1,
  };
}
