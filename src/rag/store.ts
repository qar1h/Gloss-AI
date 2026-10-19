// A minimal, hand-rolled promise wrapper around the native IndexedDB API — no
// dependency added. Three object stores: "messages" (one bookkeeping row per
// indexed message, keyed by "<conversationId>:<messageId>"), "chunks" (the
// chunk records, keyed by "<conversationId>:<messageId>:<chunkIndex>"), and
// "embeddings" (one vector per chunk, keyed by that same chunk id). All three
// carry a conversationId field with a matching index, since every read in this
// file is scoped to one conversation. Conversation-sized result sets (at most a
// few thousand rows for a very long personal chat) are small enough to sort and
// filter in memory rather than building compound-key range queries.

import type { Chunk, EmbeddingRecord, MessageRecord } from './types';
import { prefixRangeEnd } from './namespace';

const DB_NAME = 'highlight-explainer';
const DB_VERSION = 2;
const MESSAGES_STORE = 'messages';
const CHUNKS_STORE = 'chunks';
const EMBEDDINGS_STORE = 'embeddings';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion;

        if (oldVersion < 1) {
          db.createObjectStore(MESSAGES_STORE, { keyPath: 'key' }).createIndex(
            'by_conversation',
            'conversationId',
          );
          db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' }).createIndex(
            'by_conversation',
            'conversationId',
          );
        }

        if (oldVersion < 2) {
          db.createObjectStore(EMBEDDINGS_STORE, { keyPath: 'chunkId' }).createIndex(
            'by_conversation',
            'conversationId',
          );
        }
      };
      // Another tab holding an open connection at the old version blocks this upgrade.
      // Without this handler the open request would simply never settle, hanging this
      // tab's indexer forever with no error anywhere.
      request.onblocked = () => {
        dbPromise = null; // let a later call try again once the other tab is gone
        reject(
          new Error(
            'IndexedDB upgrade blocked by another open tab — close other tabs of this chat site and reload.',
          ),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        // If a newer version of this extension wants to upgrade the database while this
        // tab is still open, yield instead of blocking it (the mirror image of the
        // onblocked case above).
        db.onversionchange = () => {
          db.close();
          dbPromise = null; // force the next openDb() in this tab to reopen fresh
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
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

/** Message records of every conversation whose id starts with `prefix` (see namespace.ts). */
export async function getMessageRecordsByPrefix(prefix: string): Promise<MessageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(MESSAGES_STORE, 'readonly');
  const range = IDBKeyRange.bound(prefix, prefixRangeEnd(prefix), false, true);
  return promisifyRequest(tx.objectStore(MESSAGES_STORE).index('by_conversation').getAll(range));
}

export async function getAllChunks(conversationId: string): Promise<Chunk[]> {
  const db = await openDb();
  const tx = db.transaction(CHUNKS_STORE, 'readonly');
  const chunks = await promisifyRequest<Chunk[]>(
    tx.objectStore(CHUNKS_STORE).index('by_conversation').getAll(conversationId),
  );
  return chunks.sort((a, b) => a.order - b.order);
}

export async function getEmbeddingRecord(chunkId: string): Promise<EmbeddingRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readonly');
  return promisifyRequest(tx.objectStore(EMBEDDINGS_STORE).get(chunkId));
}

export async function getAllEmbeddings(conversationId: string): Promise<EmbeddingRecord[]> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readonly');
  return promisifyRequest(
    tx.objectStore(EMBEDDINGS_STORE).index('by_conversation').getAll(conversationId),
  );
}

export async function putEmbedding(record: EmbeddingRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readwrite');
  tx.objectStore(EMBEDDINGS_STORE).put(record);
  await promisifyTx(tx);
}

/** Delete a single chunk's embedding row (used by the __glossResetFailedEmbeddings debug command). */
export async function deleteEmbedding(chunkId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS_STORE, 'readwrite');
  tx.objectStore(EMBEDDINGS_STORE).delete(chunkId);
  await promisifyTx(tx);
}

/**
 * Replace everything derived from one message: delete its previous chunks (if any),
 * write the new ones, and write its bookkeeping row — all in one readwrite transaction
 * spanning all three stores, so a mid-write failure can't leave chunks, embeddings, and
 * bookkeeping out of sync. Any previous chunk id that isn't in the new chunk set (the
 * message got shorter, or its blocks were regrouped differently) also has its embedding
 * row deleted, so vectors for chunks that no longer exist don't silently pile up.
 */
export async function replaceMessage(
  record: MessageRecord,
  chunks: Chunk[],
  previousChunkIds: string[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE, EMBEDDINGS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  const embeddingStore = tx.objectStore(EMBEDDINGS_STORE);
  const newChunkIds = new Set(chunks.map((c) => c.id));

  for (const id of previousChunkIds) {
    chunkStore.delete(id);
    if (!newChunkIds.has(id)) embeddingStore.delete(id);
  }
  for (const chunk of chunks) chunkStore.put(chunk);
  tx.objectStore(MESSAGES_STORE).put(record);
  await promisifyTx(tx);
}

/** Delete a message's bookkeeping row and all of its chunks and their embeddings (used for stale-tail cleanup). */
export async function deleteMessage(record: MessageRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MESSAGES_STORE, CHUNKS_STORE, EMBEDDINGS_STORE], 'readwrite');
  const chunkStore = tx.objectStore(CHUNKS_STORE);
  const embeddingStore = tx.objectStore(EMBEDDINGS_STORE);
  for (const id of record.chunkIds) {
    chunkStore.delete(id);
    embeddingStore.delete(id);
  }
  tx.objectStore(MESSAGES_STORE).delete(record.key);
  await promisifyTx(tx);
}
