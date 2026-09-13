// Pure function: ExplainContext -> the final prompt string sent to Gemini.
// No DOM access here, so this can run in the background worker (and later grow into
// the RAG-aware prompt builder from v5 without moving).

import type { ExplainContext } from '@/messaging/types';

function formatMessage(message: { role: 'user' | 'assistant'; text: string }): string {
  const speaker = message.role === 'user' ? 'User' : 'Assistant';
  return `${speaker}: ${message.text}`;
}

export function buildPrompt(context: ExplainContext): string {
  const sections: string[] = [];

  sections.push(
    'You are helping someone understand part of an AI chat conversation they are reading.',
  );

  if (context.recentMessages.length > 0) {
    sections.push(
      [
        'Recent conversation, for context only:',
        ...context.recentMessages.map(formatMessage),
      ].join('\n'),
    );
  }

  sections.push(
    [
      `The message being explained (spoken by the ${context.message.role === 'user' ? 'user' : 'assistant'}):`,
      '"""',
      context.message.text,
      '"""',
    ].join('\n'),
  );

  if (context.userQuestion) {
    sections.push(
      ['The user originally asked:', '"""', context.userQuestion, '"""'].join('\n'),
    );
  }

  sections.push(
    ['Within that message, this specific part was highlighted:', '"""', context.highlight, '"""'].join(
      '\n',
    ),
  );

  if (context.paragraph && context.paragraph !== context.highlight) {
    sections.push(
      ['It appears in this paragraph:', '"""', context.paragraph, '"""'].join('\n'),
    );
  }

  sections.push(
    'Explain the highlighted part in simple, plain language. Use the surrounding conversation only where it actually helps understanding — do not just repeat it back. Keep the explanation focused on the highlighted part itself.',
  );

  return sections.join('\n\n');
}
