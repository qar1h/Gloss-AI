import type { Block, Chunk } from './types';
import { hashText } from './hash';

// Bump this whenever the chunking rules below change, so the indexer can force
// a clean re-chunk of every message even when its content hash hasn't changed.
export const CHUNKER_VERSION = 1;

const MAX_CHUNK_WORDS = 180;
const MERGE_THRESHOLD_WORDS = 20;

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

interface Group {
  blocks: Block[];
  words: number;
}

export function groupBlocks(blocks: Block[]): { text: string; hasCode: boolean }[] {
  const groups: Group[] = [];
  let current: Group = { blocks: [], words: 0 };

  const flush = () => {
    if (current.blocks.length > 0) {
      groups.push(current);
      current = { blocks: [], words: 0 };
    }
  };

  for (const block of blocks) {
    const words = wordCount(block.text);

    if (block.type === 'code') {
      // Code is always its own chunk, and never merged with prose either side.
      flush();
      groups.push({ blocks: [block], words });
      continue;
    }

    if (block.type === 'heading' && current.blocks.length > 0) {
      flush();
    }

    if (current.words > 0 && current.words + words > MAX_CHUNK_WORDS) {
      flush();
    }

    current.blocks.push(block);
    current.words += words;
  }
  flush();

  // Fold a small trailing leftover into the previous group — but never a group
  // that starts with a heading (that's a deliberate new section, not an orphan)
  // and never onto/from a code group (code never merges with prose).
  for (let i = groups.length - 1; i > 0; i--) {
    const group = groups[i]!;
    const prev = groups[i - 1]!;
    const isCode = (g: Group) => g.blocks.length === 1 && g.blocks[0]?.type === 'code';
    const startsWithHeading = group.blocks[0]?.type === 'heading';
    if (group.words < MERGE_THRESHOLD_WORDS && !isCode(group) && !isCode(prev) && !startsWithHeading) {
      prev.blocks.push(...group.blocks);
      prev.words += group.words;
      groups.splice(i, 1);
    }
  }

  return groups.map((g) => ({
    text: g.blocks.map((b) => b.text).join('\n\n'),
    hasCode: g.blocks.some((b) => b.type === 'code'),
  }));
}

export async function chunkMessage(
  conversationId: string,
  messageId: string,
  role: 'user' | 'assistant',
  blocks: Block[],
): Promise<Chunk[]> {
  const groups = groupBlocks(blocks);
  const position = Number(messageId);
  const now = Date.now();

  return Promise.all(
    groups.map(async (group, chunkIndex) => ({
      id: `${conversationId}:${messageId}:${chunkIndex}`,
      conversationId,
      messageId,
      role,
      chunkIndex,
      order: position * 1000 + chunkIndex,
      text: group.text,
      textHash: await hashText(group.text),
      wordCount: wordCount(group.text),
      hasCode: group.hasCode,
      createdAt: now,
    })),
  );
}
