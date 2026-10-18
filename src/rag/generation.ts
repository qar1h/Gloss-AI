// The real wipe behind the generation gate (see generationGate.ts). I/O — verified live.

import { createGenerationGate } from './generationGate';
import { namespacePrefix } from './namespace';
import { deleteMessage, getAllMessageRecords, getMessageRecordsByPrefix } from './store';

/** Chats whose earlier page loads this load has already cleaned up (a prefix is `<chat>~`). */
const purgedEarlierLoads = new Set<string>();

const gate = createGenerationGate(async (conversationId) => {
  // deleteMessage removes a message's chunks and their embeddings with it.
  for (const record of await getAllMessageRecords(conversationId)) await deleteMessage(record);

  // A page-load namespace (`<chat>~<token>`): earlier loads of the same chat left rows of their
  // own, which are stale. This is done ONCE per load, when it first uses the index, never on a later
  // wipe: a reset in this tab must not delete the rows another tab has written since, or that tab
  // would be left believing chunks were still embedded (the first version of this did exactly that).
  const prefix = namespacePrefix(conversationId);
  if (prefix && !purgedEarlierLoads.has(prefix)) {
    for (const record of await getMessageRecordsByPrefix(prefix)) {
      if (record.conversationId !== conversationId) await deleteMessage(record);
    }
    purgedEarlierLoads.add(prefix);
  }
});

/** Call before reading or writing a chat's index. A no-op for sites that report no generation. */
export const ensureIndexGeneration = gate.ensure;

/** Lets in-memory caches that describe a chat's rows (the indexer's embedding statuses) drop them on a wipe. */
export const onIndexWiped = gate.onWiped;
