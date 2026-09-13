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
