// The real wipe behind the generation gate (see generationGate.ts). I/O — verified live.

import { createGenerationGate } from './generationGate';
import { namespacePrefix } from './namespace';
import { deleteMessage, getAllMessageRecords, getMessageRecordsByPrefix } from './store';

const gate = createGenerationGate(async (conversationId) => {
  // deleteMessage removes a message's chunks and their embeddings with it.
  for (const record of await getAllMessageRecords(conversationId)) await deleteMessage(record);

  // A page-load namespace (`<chat>~<token>`): earlier loads of the same chat left rows of their
  // own. They are stale at best, and a tab still showing the chat would only re-index what it shows.
  const prefix = namespacePrefix(conversationId);
  if (prefix) {
    for (const record of await getMessageRecordsByPrefix(prefix)) {
      if (record.conversationId !== conversationId) await deleteMessage(record);
    }
  }
});

/** Call before reading or writing a chat's index. A no-op for sites that report no generation. */
export const ensureIndexGeneration = gate.ensure;

/** Lets in-memory caches that describe a chat's rows (the indexer's embedding statuses) drop them on a wipe. */
export const onIndexWiped = gate.onWiped;
