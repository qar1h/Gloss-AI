// The ChatGPT adapter, checked against the real conversation fixture and against small
// hand-built windows that slide, jump, conflict and stream. The windows mimic what the live
// probes showed (3-12 consecutive turns mounted at a time).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SiteAdapter } from './types';

let adapter: SiteAdapter;
let chatCounter = 0;
const nextChat = () => `test-chat-${++chatCounter}`;

function loadDom(bodyHtml: string, pathname: string): Document {
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = document;
  g.location = { pathname };
  return document as unknown as Document;
}

beforeAll(async () => {
  loadDom('<div></div>', '/');
  adapter = (await import('./chatgpt')).chatgptAdapter;
});

interface TurnOptions {
  state?: string;
  user?: string | null;
  assistant?: string | null;
  assistantRenderers?: number;
}

function turn(id: string, o: TurnOptions = {}): string {
  const user =
    o.user === null
      ? ''
      : `<div data-user-message-bubble="true"><div class="whitespace-pre-wrap">${o.user ?? `question ${id}`}</div></div>`;
  const renderers = o.assistant === null ? 0 : (o.assistantRenderers ?? 1);
  const assistant = Array.from({ length: renderers }, (_, i) => `<div data-dil-message-id="m-${id}-${i}"><p>${o.assistant ?? `answer ${id}`}</p></div>`).join('');
  return `<div class="wrapper"><div data-turn-key="${id}"><div data-content-search-turn-key="fallback-turn-0"><div data-talvt-turn-state="${o.state ?? 'complete'}">${user}${assistant}</div></div></div></div>`;
}

/** Shows `turns` as the mounted window of chat `chat` (what the page does as you scroll). */
function show(chat: string, turns: string[]): Document {
  return loadDom(`<div data-thread-find-target="conversation">${turns.join('')}</div>`, `/c/${chat}`);
}

const ids = (messages: { id: string }[]) => messages.map((m) => m.id);
const P = (slot: number, role: 'user' | 'assistant') => String(slot * 2 + (role === 'assistant' ? 1 : 0));

describe('chatgptAdapter.getConversationId', () => {
  it('reads /c/<id>, also under a GPT or project path, and is null elsewhere', () => {
    const cases: [string, string | null][] = [
      ['/c/abc-123', 'abc-123'],
      ['/g/g-p-123-name/c/abc-123', 'abc-123'],
      ['/c/abc-123/', 'abc-123'],
      ['/', null],
      ['/share/abc-123', null],
      ['/gpts', null],
    ];
    for (const [path, expected] of cases) {
      loadDom('', path);
      const id = adapter.getConversationId();
      if (expected === null) expect(id, path).toBeNull();
      else expect(id, path).toMatch(new RegExp(`^${expected}~[a-z0-9]+$`)); // namespaced by page load
    }
  });

  it('gives the same id for the whole page load, so the index of this load is one set of rows', () => {
    loadDom('', '/c/abc-123');
    const first = adapter.getConversationId();
    loadDom('', '/c/abc-123');
    expect(adapter.getConversationId()).toBe(first);
  });
});

describe('chatgptAdapter on the real conversation fixture (3 turns)', () => {
  const html = readFileSync(resolve(__dirname, '../../fixtures/chatgpt-conversation.html'), 'utf8');
  const chat = '6acf73f9-4a00-83e8-9c29-2b25edf40e55'; // the id the fixture itself carries

  it('numbers the messages from the base slot, user then assistant, in chat order', () => {
    loadDom(html, `/c/${chat}`);
    const messages = adapter.getAllMessages();
    expect(ids(messages)).toEqual([10000, 10001, 10002, 10003, 10004, 10005].map(String));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[0]!.element.matches('[data-user-message-bubble]')).toBe(true);
    expect(messages[1]!.element.matches('[data-dil-message-id]')).toBe(true);
  });

  it('returns the same ids when asked again (stable within the session)', () => {
    loadDom(html, `/c/${chat}`);
    expect(ids(adapter.getAllMessages())).toEqual(ids(adapter.getAllMessages()));
  });

  it('reads message content as the blocks the chunker will index', () => {
    loadDom(html, `/c/${chat}`);
    const [user0, assistant0] = adapter.getAllMessages();
    expect(adapter.getMessageContent(user0!.element)).toBe('Explain palindrome number');
    const content = adapter.getMessageContent(assistant0!.element);
    expect(content).toContain('A palindrome number is a number that reads the same');
    const blocks = adapter.getMessageBlocks(assistant0!.element);
    // The code block is read once (the prose mentions "num = 121" too, which is not a duplicate).
    expect(blocks.filter((b) => b.type === 'code' && b.text.includes('num = 121'))).toHaveLength(1);
    expect(content).toContain(blocks.find((b) => b.type === 'code')!.text);
    expect(adapter.getMessageText(assistant0!.element)).not.toMatch(/\s{2}|\n/); // flattened: a change-detection key
  });

  it('finds the question of an answer: the user message of the same turn', () => {
    loadDom(html, `/c/${chat}`);
    const q = adapter.getUserQuestionFor('10003');
    expect(q.status).toBe('found');
    expect(q.message?.id).toBe('10002');
    expect(q.message?.text.startsWith('Tell which language is')).toBe(true);
  });

  it('lists the messages just before one, oldest first, and says when the walk ran out of page', () => {
    loadDom(html, `/c/${chat}`);
    const enough = adapter.getRecentMessages('10005', 2);
    expect(ids(enough.messages)).toEqual(['10003', '10004']);
    expect(enough.endsAtGap).toBe(false);
    const short = adapter.getRecentMessages('10001', 3);
    expect(ids(short.messages)).toEqual(['10000']);
    expect(short.endsAtGap).toBe(true); // we cannot know the chat starts here, so say "not loaded"
  });

  it('maps a node inside a message to that message, and a node in the action bar to nothing', () => {
    const doc = loadDom(html, `/c/${chat}`);
    const answer = doc.querySelectorAll('[data-dil-message-id]')[1]!;
    expect(adapter.getMessageForNode(answer.querySelector('p')!.firstChild!)?.id).toBe('10003');
    expect(adapter.getMessageForNode(doc.querySelectorAll('[data-user-message-bubble]')[2]!)?.id).toBe('10004');
    expect(adapter.getMessageForNode(doc.querySelector('button[aria-label="Copy"]')!)).toBeNull();
  });

  it('gives the block around a selection as the paragraph, and the plain text for a user message', () => {
    const doc = loadDom(html, `/c/${chat}`);
    const p = doc.querySelectorAll('[data-dil-message-id]')[0]!.querySelector('p')!;
    const fake = (el: Element, text: string) => ({ commonAncestorContainer: el, toString: () => text }) as unknown as Range;
    expect(adapter.getParagraphAround(fake(p, 'palindrome'))).toBe((p.textContent ?? '').replace(/\s+/g, ' ').trim());
    const bubble = doc.querySelectorAll('[data-user-message-bubble]')[0]!;
    expect(adapter.getParagraphAround(fake(bubble, 'palindrome'))).toBe('Explain palindrome number');
  });

  it('reads the transcript root and the attributes worth watching', () => {
    const doc = loadDom(html, `/c/${chat}`);
    expect(adapter.getTranscriptRoot()).toBe(doc.querySelector('[data-thread-find-target="conversation"]'));
    expect(adapter.observedAttributes).toContain('data-talvt-turn-state');
    expect(adapter.getLastMessagePosition()).toBeNull();
  });

  it('refuses to read while the URL and the page disagree about which chat this is (mid-navigation)', () => {
    loadDom(html, '/c/some-other-chat');
    expect(adapter.getAllMessages()).toEqual([]);
    expect(adapter.getIndexGeneration?.()).toBeNull();
  });
});

describe('chatgptAdapter: a window that slides keeps its numbers', () => {
  it('numbers a turn the same wherever it is in the window', () => {
    const chat = nextChat();
    show(chat, ['a', 'b', 'c'].map((i) => turn(i)));
    expect(ids(adapter.getAllMessages())).toEqual([P(5000, 'user'), P(5000, 'assistant'), P(5001, 'user'), P(5001, 'assistant'), P(5002, 'user'), P(5002, 'assistant')]);
    show(chat, ['b', 'c', 'd', 'e'].map((i) => turn(i)));
    const after = adapter.getAllMessages();
    expect(ids(after.slice(0, 2))).toEqual([P(5001, 'user'), P(5001, 'assistant')]);
    expect(ids(after.slice(-2))).toEqual([P(5004, 'user'), P(5004, 'assistant')]);
  });

  it('numbers turns discovered above the first window with lower numbers', () => {
    const chat = nextChat();
    show(chat, ['c', 'd'].map((i) => turn(i)));
    adapter.getAllMessages(); // every window is looked at when it appears (the adapter's own tracker does this live)
    show(chat, ['a', 'b', 'c'].map((i) => turn(i)));
    expect(ids(adapter.getAllMessages()).slice(0, 2)).toEqual([P(4998, 'user'), P(4998, 'assistant')]);
  });

  it('keeps the generation while it only slides', () => {
    const chat = nextChat();
    show(chat, ['a', 'b'].map((i) => turn(i)));
    const first = adapter.getIndexGeneration?.();
    show(chat, ['b', 'c'].map((i) => turn(i)));
    expect(adapter.getIndexGeneration?.()).toBe(first);
    expect(first).toMatch(new RegExp(`:${chat}:0$`));
  });

  it('keeps every chat on its own frame', () => {
    const one = nextChat();
    const two = nextChat();
    show(one, ['a', 'b'].map((i) => turn(i)));
    adapter.getAllMessages();
    show(two, ['x', 'y'].map((i) => turn(i)));
    expect(ids(adapter.getAllMessages())[0]).toBe(P(5000, 'user'));
    show(one, ['b', 'c'].map((i) => turn(i)));
    expect(ids(adapter.getAllMessages())[0]).toBe(P(5001, 'user')); // chat one remembered b
  });
});

describe('chatgptAdapter: a window that is not connected (a jump)', () => {
  /** Establishes a frame on a, b, c, then jumps to x, y, z, which touch nothing known. */
  function jump() {
    const chat = nextChat();
    show(chat, ['a', 'b', 'c'].map((i) => turn(i)));
    adapter.getAllMessages();
    const generation = adapter.getIndexGeneration?.();
    show(chat, ['x', 'y', 'z'].map((i) => turn(i)));
    return { chat, generation };
  }

  it('indexes nothing from it', () => {
    jump();
    expect(adapter.getAllMessages()).toEqual([]);
  });

  it('leaves the generation alone: a jump is not a conflict', () => {
    const { generation } = jump();
    expect(adapter.getIndexGeneration?.()).toBe(generation);
  });

  it('still lets Explain work there, in a window-local numbering, with retrieval switched off and a note', () => {
    jump();
    const hit = adapter.getMessageForNode(document.querySelectorAll('[data-dil-message-id]')[1]!); // y's answer
    expect(hit).not.toBeNull();
    expect(Number(hit!.id)).toBeGreaterThanOrEqual(200_000); // far from the indexed frame's 10000s: no collision
    const status = adapter.getOrderStatus!(hit!.id);
    expect(status.retrieval).toBe('disabled');
    expect(status.note).toMatch(/isn't connected/);
    expect(adapter.getUserQuestionFor(hit!.id).message?.id).toBe(String(Number(hit!.id) - 1)); // y's own question
    expect(ids(adapter.getRecentMessages(hit!.id, 2).messages)).toEqual([String(Number(hit!.id) - 2), String(Number(hit!.id) - 1)]);
  });

  it('places the window as soon as it touches a turn that was indexed', () => {
    const { chat } = jump();
    show(chat, ['c', 'x', 'y'].map((i) => turn(i))); // c is known (slot 5002); x and y sit right after it
    expect(ids(adapter.getAllMessages())[0]).toBe(P(5002, 'user'));
    expect(ids(adapter.getAllMessages()).slice(-2)).toEqual([P(5004, 'user'), P(5004, 'assistant')]);
  });

  it('numbers a reconnecting window from the turn it shares, including turns above it', () => {
    const chat = nextChat();
    show(chat, ['d', 'e', 'f'].map((i) => turn(i))); // d=5000, e=5001, f=5002
    adapter.getAllMessages();
    show(chat, ['a', 'b', 'c'].map((i) => turn(i))); // jumped: detached
    expect(adapter.getAllMessages()).toEqual([]);
    show(chat, ['b', 'c', 'd'].map((i) => turn(i))); // shares d: b=4998, c=4999
    expect(ids(adapter.getAllMessages())).toEqual([P(4998, 'user'), P(4998, 'assistant'), P(4999, 'user'), P(4999, 'assistant'), P(5000, 'user'), P(5000, 'assistant')]);
  });
});

describe('chatgptAdapter: a conflict is detected, rebuilt from, and stays visible', () => {
  it('restarts the frame when an earlier message was edited, and says so on every later explanation', () => {
    const chat = nextChat();
    show(chat, ['a', 'b', 'c', 'd'].map((i) => turn(i)));
    adapter.getAllMessages();
    const before = adapter.getIndexGeneration?.();
    expect(adapter.getOrderStatus!(P(5001, 'assistant')).note).toBeNull();

    show(chat, ['a', 'b', 'X'].map((i) => turn(i))); // c was edited into X
    const after = adapter.getIndexGeneration?.();
    expect(after).not.toBe(before);
    const messages = adapter.getAllMessages();
    expect(ids(messages)[0]).toBe(P(5000, 'user')); // renumbered from the base

    const status = adapter.getOrderStatus!(messages[1]!.id);
    expect(status.retrieval).toBe('ok');
    expect(status.note).toMatch(/changed earlier on this page/);
    expect(status.indexGeneration).toBe(after);

    show(chat, ['b', 'X', 'Y'].map((i) => turn(i))); // later, a normal slide
    expect(adapter.getOrderStatus!(P(5001, 'assistant')).note).toMatch(/changed earlier on this page/); // sticky
    expect(adapter.getIndexGeneration?.()).toBe(after); // but no further rebuild
  });
});

describe('chatgptAdapter: a message that is still being written', () => {
  it('is left out until it is complete, and takes the next number then', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b'), turn('c', { state: 'in_progress' })]);
    expect(ids(adapter.getAllMessages())).toEqual([P(5000, 'user'), P(5000, 'assistant'), P(5001, 'user'), P(5001, 'assistant')]);
    expect(adapter.isStreaming(document.querySelectorAll<HTMLElement>('[data-dil-message-id]')[2]!)).toBe(true);
    expect(adapter.getMessageForNode(document.querySelectorAll('[data-dil-message-id]')[2]!)).toBeNull();
    show(chat, [turn('a'), turn('b'), turn('c')]);
    expect(ids(adapter.getAllMessages()).slice(-2)).toEqual([P(5002, 'user'), P(5002, 'assistant')]);
  });

  it('does not start a conflict if the key changes when the turn finishes', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b'), turn('temp-key', { state: 'in_progress' })]);
    adapter.getAllMessages();
    const generation = adapter.getIndexGeneration?.();
    show(chat, [turn('a'), turn('b'), turn('real-key')]);
    adapter.getAllMessages();
    expect(adapter.getIndexGeneration?.()).toBe(generation);
    expect(adapter.getOrderStatus!(P(5002, 'assistant')).note).toBeNull();
  });

  it('treats a turn after a streaming one as not placed either (it is not consecutive with anything we trust)', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b', { state: 'in_progress' }), turn('c')]);
    expect(ids(adapter.getAllMessages())).toEqual([P(5000, 'user'), P(5000, 'assistant')]);
  });
});

describe('chatgptAdapter: turns that are not the usual user + assistant pair', () => {
  it('numbers a user-only turn and gives it no assistant message, without disturbing its neighbours', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b', { assistant: null }), turn('c')]);
    expect(ids(adapter.getAllMessages())).toEqual([
      P(5000, 'user'), P(5000, 'assistant'), P(5001, 'user'), P(5002, 'user'), P(5002, 'assistant'),
    ]);
  });

  it('walks back past the missing answer of a user-only turn', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b', { assistant: null }), turn('c')]);
    // before c's answer: c's question, then b's question, then a's answer (b has no answer to skip to)
    expect(ids(adapter.getRecentMessages(P(5002, 'assistant'), 3).messages)).toEqual([
      P(5000, 'assistant'), P(5001, 'user'), P(5002, 'user'),
    ]);
  });

  it('has no question for an answer whose turn has no user message', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b', { user: null })]);
    expect(adapter.getUserQuestionFor(P(5001, 'assistant')).status).toBe('none');
  });

  it('reports a turn with two answer bodies instead of guessing which is the answer, and keeps its slot', () => {
    const chat = nextChat();
    show(chat, [turn('a'), turn('b', { assistantRenderers: 2 }), turn('c')]);
    expect(ids(adapter.getAllMessages())).toEqual([P(5000, 'user'), P(5000, 'assistant'), P(5002, 'user'), P(5002, 'assistant')]);
    expect(adapter.getUnrecognizedRowIds().join(' ')).toMatch(/\bb\b/);
    expect(adapter.getMessageForNode(document.querySelectorAll('[data-dil-message-id]')[1]!)).toBeNull();
  });
});

describe('chatgptAdapter.isMessageCurrent (F5)', () => {
  it('is true for a message whose element is still that message', () => {
    show(nextChat(), ['a', 'b'].map((i) => turn(i)));
    for (const m of adapter.getAllMessages()) expect(adapter.isMessageCurrent!(m)).toBe(true);
  });

  it('is false once the page has replaced the element, even though the turn key is the same', () => {
    const chat = nextChat();
    show(chat, ['a', 'b'].map((i) => turn(i)));
    const before = adapter.getAllMessages();
    show(chat, ['a', 'b'].map((i) => turn(i))); // same turns, new DOM nodes (a recycled row)
    for (const m of before) expect(adapter.isMessageCurrent!(m)).toBe(false);
    for (const m of adapter.getAllMessages()) expect(adapter.isMessageCurrent!(m)).toBe(true);
  });

  it('is false once the message has been scrolled out of the window', () => {
    const chat = nextChat();
    show(chat, ['a', 'b', 'c'].map((i) => turn(i)));
    const first = adapter.getAllMessages()[0]!;
    show(chat, ['c', 'd', 'e'].map((i) => turn(i)));
    expect(adapter.isMessageCurrent!(first)).toBe(false);
  });

  it('is false when the id now belongs to a different element (a recycled row showing another turn)', () => {
    const chat = nextChat();
    show(chat, ['a', 'b'].map((i) => turn(i)));
    adapter.getAllMessages();
    const doc = show(chat, ['a', 'b'].map((i) => turn(i)));
    const stale = { id: String(5000 * 2), role: 'user' as const, element: doc.createElement('div') };
    expect(adapter.isMessageCurrent!(stale)).toBe(false);
  });
});

describe('chatgptAdapter: the page must agree with the URL about the chat on every turn (F7)', () => {
  it('refuses to read a mixed render in which a later turn already belongs to another chat', () => {
    const chat = nextChat();
    const own = `<div data-chatgpt-selection-conversation-id="${chat}"></div>`;
    const other = '<div data-chatgpt-selection-conversation-id="some-other-chat"></div>';
    const html = [turn('a'), turn('b')].map((t, i) => t.replace('<p>', (i === 0 ? own : other) + '<p>')).join('');
    loadDom(`<div data-thread-find-target="conversation">${html}</div>`, `/c/${chat}`);
    expect(adapter.getAllMessages()).toEqual([]);
  });

  it('reads normally when every turn agrees', () => {
    const chat = nextChat();
    const own = `<div data-chatgpt-selection-conversation-id="${chat}"></div>`;
    const html = [turn('a'), turn('b')].map((t) => t.replace('<p>', own + '<p>')).join('');
    loadDom(`<div data-thread-find-target="conversation">${html}</div>`, `/c/${chat}`);
    expect(adapter.getAllMessages()).toHaveLength(4);
  });
});

describe('chatgptAdapter: ids always satisfy the position contract', () => {
  it('only ever produces decimal-integer ids', () => {
    const chat = nextChat();
    show(chat, ['a', 'b', 'c'].map((i) => turn(i)));
    for (const m of adapter.getAllMessages()) expect(m.id).toMatch(/^\d{1,9}$/);
    show(chat, ['x', 'y'].map((i) => turn(i)));
    const hit = adapter.getMessageForNode(document.querySelector('[data-dil-message-id]')!);
    expect(hit!.id).toMatch(/^\d{1,9}$/);
  });
});
