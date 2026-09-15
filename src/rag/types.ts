// Shared types for chunking and storage. No DOM access anywhere in this file.

export type BlockType = 'heading' | 'paragraph' | 'list-item' | 'blockquote' | 'code';

export interface Block {
  type: BlockType;
  text: string;
}

export interface Chunk {
  id: string; // `${conversationId}:${messageId}:${chunkIndex}`
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  chunkIndex: number;
  order: number; // Number(messageId) * 1000 + chunkIndex — cheap chat-order sort key
  text: string;
  textHash: string;
  wordCount: number;
  hasCode: boolean;
  createdAt: number;
}

export interface MessageRecord {
  key: string; // `${conversationId}:${messageId}`
  conversationId: string;
  messageId: string;
  position: number; // Number(messageId)
  role: 'user' | 'assistant';
  textHash: string;
  chunkerVersion: number;
  chunkIds: string[];
  lastIndexedAt: number;
}

export interface EmbeddingRecord {
  chunkId: string; // matches Chunk.id
  conversationId: string;
  vector: number[];
  embeddingVersion: number;
  chunkTextHash: string; // the chunk's own textHash at the time this vector was computed
  status: 'done' | 'failed';
  /** How many times embedding this exact chunkTextHash/embeddingVersion has failed in a
   * row. The indexer stops retrying past a small cap, so a chunk that fails for a
   * permanent reason doesn't re-run real inference on every indexing pass forever. Reset
   * to 0 on success, and a changed hash or embedding version starts a fresh count. */
  failureCount: number;
  embeddedAt: number;
}
