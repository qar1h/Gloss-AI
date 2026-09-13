// A minimal, hand-rolled promise wrapper around the native IndexedDB API — no
// dependency added. Two object stores: "messages" (one bookkeeping row per
// indexed message, keyed by "<conversationId>:<messageId>") and "chunks" (the
// chunk records, keyed by "<conversationId>:<messageId>:<chunkIndex>"). Both
// carry a conversationId field with a matching index, since every read in this
// file is scoped to one conversation. Conversation-sized result sets (at most a
// few thousand rows for a very long personal chat) are small enough to sort and
// filter in memory rather than building compound-key range queries.

import type { Chunk, MessageRecord } from './types';

const DB_NAME = 'highlight-explainer';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const CHUNKS_STORE = 'chunks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(MESSAGES_STORE, { keyPath: 'key' }).createIndex(
          'by_conversation',
          'conversationId',
        );
        db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' }).createIndex(
          'by_conversation',
          'conversationId',
        );
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getMessageRecord(key: string): Promise<MessageRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(MESSAGES_STORE, 'readonly');
  return promisifyRequest(tx.objectStore(MESSAGES_STORE).get(key));
}

export async function getAllMessageRecords(conversationId: string): Promise<MessageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(MESSAGES_STORE, 'readonly');
  return promisifyRequest(tx.objectStore(MESSAGES_STORE).index('by_conversation').getAll(conversationId));
}

export async function getAllChunks(conversationId: string): Promise<Chunk[]> {
  const db = await openDb();
  const tx = db.transaction(CHUNKS_STORE, 'readonly');
  const chunks = await promisifyRequest<Chunk[]>(
    tx.objectStore(CHUNKS_STORE).index('by_conversation').getAll(conversationId),
  );
  return chunks.sort((a, b) => a.order - b.order);
}

/**
 * Replace everything derived from one message: delete its previous chunks (if
 * any), write the new ones, and write its bookkeeping row — all in one
 * readwrite transaction spanning both stores, so a mid-write failure can't
 * leave chunks and bookkeeping out of sync.
 */
export async function replaceMessage(
  record: MessageRecord,
  chunks: Chunk[],
  previousChunkIds: string[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  for (const id of previousChunkIds) chunkStore.delete(id);
  for (const chunk of chunks) chunkStore.put(chunk);
  tx.objectStore(MESSAGES_STORE).put(record);
  await promisifyTx(tx);
}

/** Delete a message's bookkeeping row and all of its chunks (used for stale-tail cleanup). */
export async function deleteMessage(record: MessageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  for (const id of record.chunkIds) chunkStore.delete(id);
  tx.objectStore(MESSAGES_STORE).delete(record.key);
  await promisifyTx(tx);
}
