// The chatgpt.com SiteAdapter. All ChatGPT-specific selectors live in this file and in
// chatgptBlocks.ts (message content) — each read off the captured fixtures in fixtures/chatgpt-*.html
// and checked against live probes, never guessed.
//
// Known shape of the page:
//   - The conversation is a virtualized list: a box with the whole chat's height, and inside it
//     only the turns near the viewport (3-12 of them, a contiguous run). `[data-turn-key]` is one
//     turn; its UUID is its only stable identity.
//   - A turn holds `[data-user-message-bubble]` (the question) and `[data-markdown-text-style="assistant-message"]` (the
//     answer body); `[data-talvt-turn-state]` is "complete" or "in_progress".
//   - There is NO absolute index in the DOM. `fallback-turn-N` renumbers as the window moves and
//     is deliberately not used. Positions come from sites/turnSequence.ts, and ids stay positional
//     numbers (user = even, the turn's answer = the next odd) so everything downstream is unchanged.
//
// Because positions are session-scoped here, the adapter reports a `generation` (the index is
// wiped when it changes) and an `OrderStatus` (so the popup can say when a window is not
// connected to what was indexed, or when the chat's order changed unexpectedly).

import type { QuestionLookup, RecentLookup, SiteAdapter, SiteMessage, SiteTextMessage } from './types';
import type { Block } from '../rag/types';
import type { OrderStatus } from '../context/types';
import { blocksToText } from '../rag/chunker'; // relative on purpose: loadable under vitest, which has no `@/` alias
import { NAMESPACE_SEPARATOR } from '../rag/namespace';
import { assistantBlocks, blockElementFor, blockElementText, hasUnreadCode, userBlocks } from './chatgptBlocks';
import { TurnSequence, isLocalPosition, positionOf, type Role } from './turnSequence';

const TURN = '[data-turn-key]';
const USER = '[data-user-message-bubble]';
// The answer element. It wraps the [data-dil-message-id] renderer in one layout and holds the blocks
// directly in another (fixtures/chatgpt-other-answer.html), so the renderer is not the anchor.
const ASSISTANT = '[data-markdown-text-style="assistant-message"]';
const TURN_STATE = '[data-talvt-turn-state]';
const CONVERSATION_ROOT = '[data-thread-find-target="conversation"]';
const DOM_CONVERSATION_ID = '[data-chatgpt-selection-conversation-id]';

/** Per page load: positions only mean something within it (see the generation). */
const LOADED = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const sequences = new Map<string, TurnSequence>();

interface TurnView {
  key: string;
  slot: number;
  user: HTMLElement | null;
  assistant: HTMLElement | null;
  /** False when the turn has more than one question or answer body: we cannot say which is which. */
  recognized: boolean;
}

interface Entry {
  turn: TurnView;
  role: Role;
  element: HTMLElement;
}

interface Snapshot {
  conversationId: string;
  sequence: TurnSequence;
  turns: TurnView[];
  /** True when the window touches nothing that was indexed: its ids are window-local. */
  detached: boolean;
  byId: Map<string, Entry>;
  byElement: Map<Element, string>;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isWriting(turn: Element): boolean {
  return turn.querySelector<HTMLElement>(TURN_STATE)?.dataset.talvtTurnState === 'in_progress';
}

function conversationIdFromUrl(): string | null {
  return location.pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null;
}

/**
 * Which conversation tree on the page is the one the URL is showing.
 *
 * After a sidebar switch the previous chat's tree can stay mounted (hidden) next to the new one, and
 * stale markers can sit elsewhere in the page. So the chat marker is judged PER TREE, and only the
 * tree that belongs to the URL's chat is read; whatever else the page still holds is ignored. (A
 * version that required every marker in the whole document to agree refused to read for as long as
 * one leftover element existed, which was until the page was reloaded.) A tree is:
 *   'yes'     it has markers and all of them are this chat's;
 *   'no'      one of its markers is another chat's, or it mixes chats (a half-finished render);
 *   'unknown' it has no markers (a chat with no answer yet).
 * Nothing here is remembered between calls: it is a pure function of the page as it is now.
 */
interface RootChoice {
  root: Element | null;
  /** The distinct chat ids found on the page, per tree, for the diagnostic log only. */
  seen: string[][];
}

function chooseRoot(conversationId: string): RootChoice {
  const found = Array.from(document.querySelectorAll(CONVERSATION_ROOT));
  const candidates: Element[] = found.length > 0 ? found : document.body ? [document.body] : [];
  const verdict = (root: Element): 'yes' | 'no' | 'unknown' => {
    const ids = Array.from(root.querySelectorAll<HTMLElement>(DOM_CONVERSATION_ID))
      .map((el) => el.dataset.chatgptSelectionConversationId)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return 'unknown';
    return ids.every((id) => id === conversationId) ? 'yes' : 'no';
  };
  const verdicts = candidates.map((root) => ({ root, verdict: verdict(root) }));
  const seen = candidates.map((root) =>
    Array.from(new Set(Array.from(root.querySelectorAll<HTMLElement>(DOM_CONVERSATION_ID)).map((el) => short(el.dataset.chatgptSelectionConversationId ?? '')))),
  );
  const yes = verdicts.find((v) => v.verdict === 'yes');
  if (yes) return { root: yes.root, seen };
  const unknown = verdicts.filter((v) => v.verdict === 'unknown');
  if (unknown.length === 1) return { root: unknown[0]!.root, seen };
  return { root: null, seen };
}

let waitingLogged = '';

let trackedRoot: Element | null = null;
let trackerObserver: MutationObserver | null = null;
let trackerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Looks at the window every time the list changes, not only when the indexer or a click happens
 * to ask. The frame is built from windows that overlap; the indexer is debounced by 800 ms, so
 * fast scrolling would skip windows and lose overlaps that the live probes (sampling every
 * 150 ms) did see. Throttled, and it never touches the page.
 */
function track(root: Element | null): void {
  if (typeof MutationObserver !== 'function') return;
  if (!root || root === trackedRoot) return;
  trackerObserver?.disconnect();
  trackerObserver = new MutationObserver(() => {
    if (trackerTimer) return;
    trackerTimer = setTimeout(() => {
      trackerTimer = null;
      readSnapshot();
    }, 100);
  });
  trackerObserver.observe(root, { childList: true, subtree: true });
  trackedRoot = root;
}

/** Reads the mounted turns and places them in this chat's frame. Cheap, and idempotent for an unchanged window. */
function readSnapshot(): Snapshot | null {
  const conversationId = conversationIdFromUrl();
  if (!conversationId) return null;

  // Mid-navigation the URL and the page can briefly disagree about which chat this is. Feeding
  // one chat's turns into another's frame would be a well-formed but wrong index, so wait: read
  // only the tree that belongs to the URL's chat (see chooseRoot), and nothing if there is none yet.
  const choice = chooseRoot(conversationId);
  track(choice.root);
  if (!choice.root) {
    const signature = JSON.stringify([conversationId, choice.seen]);
    if (signature !== waitingLogged) {
      // Diagnostic only (never read back to decide anything): which chats the page still shows.
      waitingLogged = signature;
      console.info('[highlight-explainer] waiting for the page to show chat ' + short(conversationId) + '; chats still on the page, per tree:', choice.seen);
    }
    return null;
  }
  waitingLogged = '';

  // The window handed to the frame stops at the first turn still being written: its key may change
  // when it finishes, and what follows it is not consecutive with anything we trust.
  const all = Array.from(choice.root.querySelectorAll<HTMLElement>(TURN));
  const writing = all.findIndex(isWriting);
  const mounted = writing === -1 ? all : all.slice(0, writing);

  let sequence = sequences.get(conversationId);
  if (!sequence) {
    sequence = new TurnSequence();
    sequences.set(conversationId, sequence);
  }
  const observation = sequence.observe(mounted.map((t) => t.dataset.turnKey ?? ''));
  if (observation.reset) {
    console.warn(
      `[highlight-explainer] the order of this ChatGPT chat changed (${observation.conflict}). The index of this chat was rebuilt from the messages on screen.`,
    );
  }

  const turns: TurnView[] = [];
  const byId = new Map<string, Entry>();
  const byElement = new Map<Element, string>();
  mounted.forEach((el, i) => {
    const users = el.querySelectorAll<HTMLElement>(USER);
    const assistants = el.querySelectorAll<HTMLElement>(ASSISTANT);
    const view: TurnView = {
      key: el.dataset.turnKey ?? '',
      slot: observation.slots[i]!,
      user: users[0] ?? null,
      assistant: assistants[0] ?? null,
      recognized: users.length <= 1 && assistants.length <= 1,
    };
    turns.push(view);
    if (!view.recognized) return;
    for (const [role, element] of [['user', view.user], ['assistant', view.assistant]] as const) {
      if (!element) continue;
      const id = String(positionOf(view.slot, role));
      byId.set(id, { turn: view, role, element });
      byElement.set(element, id);
    }
  });

  return { conversationId, sequence, turns, detached: observation.detached, byId, byElement };
}

function roleOf(el: Element): Role | null {
  if (el.matches(USER)) return 'user';
  if (el.matches(ASSISTANT)) return 'assistant';
  return null;
}

function blocksOf(el: Element): Block[] {
  const role = roleOf(el);
  if (role === 'user') return userBlocks(el);
  if (role === 'assistant') return assistantBlocks(el);
  return [];
}

/** A message's text for the prompt: the blocks the chunker indexes, rendered by the same function. */
function contentOf(el: Element): string {
  return blocksToText(blocksOf(el));
}

function generationOf(snapshot: Snapshot): string {
  return `${LOADED}:${snapshot.conversationId}:${snapshot.sequence.generation}`;
}

/** Attributes whose VALUE is an identifier, not chat text, so it may be logged. */
const SAFE_VALUES = new Set([
  'role',
  'data-testid',
  'data-message-author-role',
  'data-d-component',
  'data-conversation-role',
  'data-markdown-text-style',
  'data-talvt-turn-state',
]);

/**
 * The chain of elements from where a selection starts up to its turn, innermost first, as tags and
 * attribute names (with the value only for identifier-like attributes). Never text. It is what a new
 * layout needs to be taught from a single click.
 */
function pathFrom(start: Element | null, turn: Element): string[] {
  const path: string[] = [];
  for (let el: Element | null = start; el && path.length < 16; el = el.parentElement) {
    const attrs = Array.from(el.attributes)
      .filter((a) => a.name.startsWith('data-') || a.name === 'role')
      .map((a) => (SAFE_VALUES.has(a.name) && a.value.length <= 40 ? `${a.name}=${a.value}` : a.name))
      .sort();
    path.push(el.tagName.toLowerCase() + (attrs.length > 0 ? `[${attrs.join(' ')}]` : ''));
    if (el === turn) break;
  }
  return path;
}

function short(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…` : key;
}

export const chatgptAdapter: SiteAdapter = {
  getMessageForNode(node: Node): SiteMessage | null {
    const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const element = start?.closest<HTMLElement>(`${USER}, ${ASSISTANT}`);
    if (!element) return null;
    const snapshot = readSnapshot();
    const id = snapshot?.byElement.get(element);
    const role = roleOf(element);
    // Not placed: a turn still being written, or one we cannot read unambiguously.
    if (!snapshot || id === undefined || !role) return null;
    return { id, role, element };
  },

  isMessageCurrent(message: SiteMessage): boolean {
    // A virtualized list can recycle a row for another turn. The message is current only if the page
    // still maps its id to this very element.
    return readSnapshot()?.byId.get(message.id)?.element === message.element;
  },

  getMessageText(el: HTMLElement): string {
    return collapse(contentOf(el));
  },

  getMessageContent(el: HTMLElement): string {
    return contentOf(el);
  },

  getParagraphAround(range: Range): string {
    const anchor = range.commonAncestorContainer;
    const block = blockElementFor(anchor);
    if (block?.closest(ASSISTANT)) return blockElementText(block, range.startContainer);
    const start = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    const bubble = start?.closest(USER);
    if (bubble) {
      const selected = collapse(range.toString());
      const hit = userBlocks(bubble).find((b) => collapse(b.text).includes(selected));
      if (hit) return hit.text;
    }
    return collapse(range.toString());
  },

  getUserQuestionFor(assistantMessageId: string): QuestionLookup {
    const entry = readSnapshot()?.byId.get(assistantMessageId);
    if (!entry || entry.role !== 'assistant') return { message: null, status: 'not-loaded' };
    // The question of an answer is the user message of its own turn: no walking, no gap to cross.
    if (!entry.turn.user) return { message: null, status: 'none' };
    return {
      message: { id: String(positionOf(entry.turn.slot, 'user')), role: 'user', text: contentOf(entry.turn.user) },
      status: 'found',
    };
  },

  getRecentMessages(beforeId: string, count: number): RecentLookup {
    const snapshot = readSnapshot();
    if (!snapshot || !snapshot.byId.has(beforeId)) return { messages: [], endsAtGap: true };
    const before = Number(beforeId);
    // The mounted window is consecutive turns, so what is above `before` in it really precedes it.
    // A turn we cannot read is skipped, as Claude's unrecognised rows are.
    const nearestFirst = [...snapshot.byId.entries()]
      .map(([id, entry]) => ({ id, position: Number(id), entry }))
      .filter((m) => m.position < before)
      .sort((a, b) => b.position - a.position)
      .slice(0, count);
    const messages: SiteTextMessage[] = nearestFirst
      .map((m) => ({ id: m.id, role: m.entry.role, text: contentOf(m.entry.element) }))
      .reverse();
    // Whether the chat starts at the top of the window is not knowable here, so a short list is
    // always reported as "the page has a gap" (the safe direction).
    return { messages, endsAtGap: nearestFirst.length < count };
  },

  watchForStreamingUpdate(el: HTMLElement, onUpdate: () => void): () => void {
    const observer = new MutationObserver(() => onUpdate());
    observer.observe(el.closest(TURN) ?? el, {
      attributes: true,
      attributeFilter: ['data-talvt-turn-state'],
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  },

  getConversationId(): string | null {
    // Namespaced by page load: positions are only valid for one load, and IndexedDB is shared by
    // every tab of the site, so two tabs of the same chat must not write the same rows (see
    // rag/namespace.ts). Earlier loads' rows are purged when this load first uses the index.
    const chat = conversationIdFromUrl();
    return chat ? `${chat}${NAMESPACE_SEPARATOR}${LOADED}` : null;
  },

  getTranscriptRoot(): HTMLElement | null {
    // The tree the URL is showing, not simply the first one: after a sidebar switch a stale tree can
    // come first, and an observer on it would miss every change in the live chat. The indexer asks
    // this every second, which also re-points the adapter's own tracker.
    const conversationId = conversationIdFromUrl();
    const root = conversationId ? chooseRoot(conversationId).root : null;
    track(root);
    return (root as HTMLElement | null) ?? document.querySelector<HTMLElement>(CONVERSATION_ROOT);
  },

  observedAttributes: ['data-talvt-turn-state'],

  getAllMessages(): SiteMessage[] {
    const snapshot = readSnapshot();
    // A detached window is not indexed: we cannot say where it sits relative to what is.
    if (!snapshot || snapshot.detached) return [];
    const messages: SiteMessage[] = [];
    for (const turn of snapshot.turns) {
      if (!turn.recognized) continue;
      for (const [role, element] of [['user', turn.user], ['assistant', turn.assistant]] as const) {
        if (element) messages.push({ id: String(positionOf(turn.slot, role)), role, element });
      }
    }
    return messages;
  },

  isStreaming(el: HTMLElement): boolean {
    const state = el.closest<HTMLElement>(TURN_STATE)?.dataset.talvtTurnState;
    return state === 'in_progress';
  },

  getLastMessagePosition(): number | null {
    return null; // ChatGPT's page has no marker for the last message (accepted, see CLAUDE.md)
  },

  getMessageBlocks(el: HTMLElement): Block[] {
    return blocksOf(el);
  },

  getIndexGeneration(): string | null {
    const snapshot = readSnapshot();
    return snapshot ? generationOf(snapshot) : null;
  },

  getOrderStatus(messageId: string): OrderStatus {
    const snapshot = readSnapshot();
    if (!snapshot) {
      return { retrieval: 'disabled', note: "couldn't read the order of this chat on the page", indexGeneration: null };
    }
    const notes: string[] = [];
    if (snapshot.sequence.conflictCount > 0) {
      notes.push("this chat changed earlier on this page (for example an edit, or the page reordered it), so the index was rebuilt from what is on screen");
    }
    const detached = isLocalPosition(Number(messageId));
    if (detached) {
      notes.push("this part of the chat isn't connected to the part indexed so far (you jumped here), so only nearby messages were used");
    }
    // CodeMirror renders only the lines near the viewport; the rest of a long block is a gap. Such code
    // is not read (see chatgptBlocks.ts), and the user is told, because the answer will not have seen it.
    const entry = snapshot.byId.get(messageId);
    if (entry && hasUnreadCode(entry.element)) {
      notes.push('code in this message is only partly on the page (or not drawn yet), so only the part you can see was read');
    }
    return {
      retrieval: detached ? 'disabled' : 'ok',
      note: notes.length > 0 ? notes.join('; ') : null,
      indexGeneration: generationOf(snapshot),
    };
  },

  explainBlockedReason(node: Node): string | null {
    if (!conversationIdFromUrl()) return 'Open a saved chat to use Explain: this page has no chat yet.';
    const snapshot = readSnapshot();
    if (!snapshot) return "I can't tell which chat this page is showing yet (the page may be changing). Try again in a moment.";

    const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const turnEl = start?.closest<HTMLElement>(TURN) ?? null;
    if (!turnEl) return 'This text is not part of a chat message, so there is nothing to explain.';

    const messageEl = start?.closest(`${USER}, ${ASSISTANT}`);
    if (messageEl && snapshot.byElement.has(messageEl)) return null; // readable: nothing to explain away

    const view = snapshot.turns.find((t) => t.key === turnEl.dataset.turnKey);
    let why: string;
    if (isWriting(turnEl)) why = 'This message is still being written. Try again when it has finished.';
    else if (!view) why = "The messages above this one are still being written, so it can't be placed yet. Try again when they have finished.";
    else if (!view.recognized) why = "I can't read this message: it has more than one answer body, a layout I don't understand yet.";
    else why = "I can't read this part of the chat (an unfamiliar message layout). It may be an answer in a layout I haven't seen yet.";

    // Structure only, never text: enough to capture the layout as a fixture and teach the adapter.
    const bubble = turnEl.querySelector(USER);
    const outside = Array.from(turnEl.querySelectorAll('*')).filter((e) => !bubble || (!bubble.contains(e) && !e.contains(bubble)));
    const names = new Set<string>();
    for (const e of outside) for (const a of Array.from(e.attributes)) if (a.name.startsWith('data-') || a.name === 'role') names.add(a.name);
    console.info('[highlight-explainer] cannot explain the selected part of the chat:', {
      why,
      turn: short(turnEl.dataset.turnKey ?? ''),
      state: turnEl.querySelector<HTMLElement>(TURN_STATE)?.dataset.talvtTurnState,
      questions: turnEl.querySelectorAll(USER).length,
      answers: turnEl.querySelectorAll(ASSISTANT).length,
      attributesOutsideTheQuestion: Array.from(names).sort(),
      selectedPath: pathFrom(start, turnEl),
    });
    return why;
  },

  getUnrecognizedRowIds(): string[] {
    const snapshot = readSnapshot();
    if (!snapshot) return [];
    const rows = snapshot.turns
      .filter((t) => !t.recognized)
      .map((t) => `turn ${short(t.key)} (more than one question or answer body)`);
    if (snapshot.detached) rows.push(`${snapshot.turns.length} mounted turns not connected to the indexed part of the chat`);
    return rows;
  },
};
