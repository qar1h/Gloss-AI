// The Shadow DOM popup: renders the streamed explanation as markdown, shows loading
// and error states, and closes on Escape or an outside click. Never touches the main
// chat page. Markdown is always sanitized (DOMPurify) before it touches innerHTML.
// The "Simpler" button (v9) lives in the header; what it shows is decided by threadState.ts.
//
// v10: the popup holds a thread. Header (title, Simpler, ×) / a scrolling thread (the explanation,
// then each follow-up's question and answer) / a footer (the context note, the text box). Answers
// are only ever streamed into the LATEST answer element. Once the user has typed in the box or
// asked a follow-up, an outside click no longer closes the popup (losing a thread to a stray click
// is the worst failure v10 could have), nor does an Escape meant for the page; × and an Escape in
// the popup always do. Keys, input, clipboard and drop events in the box stop there, so the chat
// page's own shortcuts, paste handler and drop zone never see them.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { FOLLOW_UP_MAX_CHARS } from '@/context/limits';
import type { ComposerView, SimplerButtonView } from '../threadState';
import { placePopup } from './placement';

const STYLE = `
  .popup {
    position: fixed;
    display: none;
    flex-direction: column;
    overflow: hidden;
    z-index: 2147483647;
    background: #fff;
    color: #1a1a1a;
    border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
    font-family: system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .popup.visible { display: flex; }
  .popup-header {
    flex: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid #eee;
    font-weight: 600;
  }
  .popup-close {
    border: none;
    background: transparent;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    color: #666;
    padding: 2px 6px;
  }
  .popup-close:hover { color: #1a1a1a; }
  .popup-actions { display: flex; align-items: center; gap: 6px; }
  .popup-simpler, .popup-send {
    border: 1px solid #ccc;
    border-radius: 999px;
    background: #fff;
    color: #1a1a1a;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 2px 10px;
    cursor: pointer;
  }
  .popup-simpler:hover:not(:disabled), .popup-send:hover:not(:disabled) { background: #f3f3f3; }
  .popup-simpler:disabled, .popup-send:disabled { color: #999; border-color: #e3e3e3; cursor: default; }
  .popup-simpler[hidden], .popup-composer[hidden] { display: none; }
  .popup-thread {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    position: relative;
    padding: 12px;
  }
  .popup-answer.stale { opacity: 0.45; }
  .popup-answer > :first-child { margin-top: 0; }
  .popup-answer > :last-child { margin-bottom: 0; }
  .popup-question {
    margin: 14px 0 8px auto;
    max-width: 85%;
    width: fit-content;
    padding: 6px 10px;
    border-radius: 10px;
    background: #f1f1f1;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .popup-footer { flex: none; border-top: 1px solid #eee; }
  .popup-note {
    display: none;
    padding: 6px 12px;
    color: #777;
    font-size: 12px;
  }
  .popup-note.visible { display: block; }
  .popup-composer {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px 12px 10px;
  }
  .popup-input {
    flex: 1;
    resize: none;
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    border: 1px solid #ccc;
    border-radius: 8px;
    max-height: 120px;
  }
  .popup-loading { color: #666; }
  .popup-error { color: #b00020; margin: 0 0 8px; }
`;

const THINKING = '<p class="popup-loading">Thinking…</p>';

/** Events in the text box that the chat page must never see (its shortcuts, its paste handler, its drop zone). */
const ISOLATED_INPUT_EVENTS = [
  'keyup',
  'keypress',
  'beforeinput',
  'input',
  'paste',
  'copy',
  'cut',
  'dragenter',
  'dragover',
  'dragleave',
  'drop',
] as const;

export interface PopupHandlers {
  onClose(): void;
  /** Without it the Simpler button is hidden (nothing to regenerate, e.g. an unreadable selection). */
  onSimpler?(): void;
  /** Without it the text box is hidden. */
  onAsk?(question: string): void;
}

export interface PopupHandle {
  open(anchorRect: DOMRect, handlers: PopupHandlers): void;
  /** Into the latest answer. */
  appendChunk(text: string): void;
  markDone(): void;
  /** The first explanation failed. */
  showError(message: string): void;
  setSimplerButton(view: SimplerButtonView): void;
  setComposer(view: ComposerView): void;
  /**
   * Simpler is rewriting the latest answer: it stays, greyed, until the first chunk of the new one
   * replaces it and the header becomes `title`.
   */
  beginRegenerate(title: string): void;
  /** The rewrite failed: the latest answer and header come back, with the error line right above. */
  failRegenerate(message: string): void;
  /** A follow-up was sent: clears the box, appends the question and an answer showing "Thinking…". */
  beginFollowUp(question: string): void;
  /** It failed: the turn is removed, an error line ends the thread, the question goes back in an empty box. */
  failFollowUp(message: string, question: string): void;
  /** The muted line under the thread saying what the explanation was based on. Empty text hides it. */
  setContextNote(text: string): void;
  /** The shadow host, so selections inside our own UI can be ignored. */
  hostElement(): HTMLElement | null;
  close(): void;
}

export async function createPopup(ctx: ContentScriptContext): Promise<PopupHandle> {
  let popupEl: HTMLDivElement | null = null;
  let threadEl: HTMLDivElement | null = null;
  let noteEl: HTMLDivElement | null = null;
  let titleEl: HTMLSpanElement | null = null;
  let simplerEl: HTMLButtonElement | null = null;
  let composerEl: HTMLDivElement | null = null;
  let inputEl: HTMLTextAreaElement | null = null;
  let sendEl: HTMLButtonElement | null = null;
  let hostEl: HTMLElement | null = null;

  /** The latest answer: the only element chunks are streamed into, and the one Simpler rewrites. */
  let answerEl: HTMLDivElement | null = null;
  let buffer = '';
  let handlers: PopupHandlers | null = null;
  let canSend = false;
  /** Once true, an outside click no longer closes the popup. */
  let sticky = false;
  let errorLine: HTMLParagraphElement | null = null;
  // While Simpler is in flight: what to restore if it fails, and the header for its first chunk.
  let previous: { buffer: string; title: string } | null = null;
  let pendingTitle: string | null = null;
  // While a follow-up is in flight: its elements, and the latest answer to go back to if it fails.
  let pendingTurn: { questionEl: HTMLElement; answerEl: HTMLDivElement; prevAnswerEl: HTMLDivElement | null; prevBuffer: string } | null =
    null;

  function setTitle(text: string): void {
    if (titleEl) titleEl.textContent = text;
  }

  function clearRegenerate(): void {
    previous = null;
    pendingTitle = null;
    answerEl?.classList.remove('stale');
  }

  function removeErrorLine(): void {
    errorLine?.remove();
    errorLine = null;
  }

  function makeErrorLine(text: string): HTMLParagraphElement {
    removeErrorLine();
    const line = document.createElement('p');
    line.className = 'popup-error';
    line.textContent = text;
    errorLine = line;
    return line;
  }

  /** Scroll the thread itself, never the page (scrollIntoView could scroll the chat). */
  function scrollThreadTo(el: HTMLElement): void {
    if (threadEl) threadEl.scrollTop = Number.isFinite(el.offsetTop) ? el.offsetTop : 0;
  }

  function newAnswerElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'popup-answer';
    el.innerHTML = THINKING;
    return el;
  }

  function render(): void {
    if (!answerEl) return;
    const html = marked.parse(buffer, { async: false }) as string;
    answerEl.innerHTML = DOMPurify.sanitize(html);
  }

  function submit(): void {
    if (!canSend || !inputEl || !handlers?.onAsk) return;
    handlers.onAsk(inputEl.value);
  }

  /**
   * Once sticky, the user works on the page with the popup open, so an Escape there (cancelling a
   * message edit, closing a site menu) is not for us: it closes the popup only when it comes from
   * inside the popup, or from no particular element and unused by the page.
   */
  function escapeIsForPopup(event: KeyboardEvent): boolean {
    const target = event.target as Node | null;
    if (hostEl && target && hostEl.contains(target)) return true;
    if (event.defaultPrevented) return false;
    return target === document.body || target === document.documentElement || target === document;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (sticky && !escapeIsForPopup(event)) return;
    close();
  }

  function onPointerDown(event: PointerEvent): void {
    if (sticky) return;
    if (hostEl && !hostEl.contains(event.target as Node)) close();
  }

  function attachGlobalListeners(): void {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
  }

  function detachGlobalListeners(): void {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onPointerDown, true);
  }

  function close(): void {
    if (!popupEl?.classList.contains('visible')) return;
    popupEl.classList.remove('visible');
    detachGlobalListeners();
    const callback = handlers?.onClose;
    handlers = null;
    callback?.();
  }

  const ui = await createShadowRootUi(ctx, {
    name: 'highlight-explainer-popup',
    position: 'inline',
    anchor: 'body',
    css: STYLE,
    onMount(container, shadow) {
      hostEl = shadow.host as HTMLElement;

      const popup = document.createElement('div');
      popup.className = 'popup';

      const header = document.createElement('div');
      header.className = 'popup-header';

      const title = document.createElement('span');
      title.textContent = 'Explain';

      const simpler = document.createElement('button');
      simpler.type = 'button';
      simpler.className = 'popup-simpler';
      simpler.textContent = 'Simpler';
      simpler.hidden = true;
      simpler.addEventListener('click', () => {
        if (!simpler.disabled) handlers?.onSimpler?.();
      });

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'popup-close';
      closeButton.setAttribute('aria-label', 'Close');
      closeButton.textContent = '×';
      closeButton.addEventListener('click', () => close());

      const actions = document.createElement('div');
      actions.className = 'popup-actions';
      actions.append(simpler, closeButton);
      header.append(title, actions);

      const threadBox = document.createElement('div');
      threadBox.className = 'popup-thread';

      const footer = document.createElement('div');
      footer.className = 'popup-footer';

      const note = document.createElement('div');
      note.className = 'popup-note';

      const composer = document.createElement('div');
      composer.className = 'popup-composer';
      composer.hidden = true;

      const input = document.createElement('textarea');
      input.className = 'popup-input';
      input.rows = 2;
      input.maxLength = FOLLOW_UP_MAX_CHARS;
      input.placeholder = 'Ask a follow-up question…';
      input.setAttribute('aria-label', 'Ask a follow-up question');
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          close();
        } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          submit();
        }
        event.stopPropagation();
      });
      input.addEventListener('input', () => {
        sticky = true;
      });
      for (const type of ISOLATED_INPUT_EVENTS) input.addEventListener(type, (event) => event.stopPropagation());

      const sendButton = document.createElement('button');
      sendButton.type = 'button';
      sendButton.className = 'popup-send';
      sendButton.textContent = 'Send';
      sendButton.disabled = true;
      sendButton.addEventListener('click', () => submit());

      composer.append(input, sendButton);
      footer.append(note, composer);
      popup.append(header, threadBox, footer);
      container.append(popup);

      popupEl = popup;
      threadEl = threadBox;
      noteEl = note;
      titleEl = title;
      simplerEl = simpler;
      composerEl = composer;
      inputEl = input;
      sendEl = sendButton;
    },
  });
  ui.mount();

  return {
    open(anchorRect: DOMRect, next: PopupHandlers) {
      if (!popupEl || !threadEl) return;

      // A popup that is still open belongs to an earlier request (e.g. the Explain button was
      // activated from the keyboard, which never triggers the outside-click close). Close it
      // properly first so its onClose runs and its call is cancelled.
      if (popupEl.classList.contains('visible')) close();

      handlers = next;
      buffer = '';
      sticky = false;
      canSend = false;
      pendingTurn = null;
      errorLine = null;
      clearRegenerate();
      setTitle('Explain');
      if (simplerEl) {
        simplerEl.hidden = true;
        simplerEl.disabled = true;
      }
      if (composerEl && inputEl && sendEl) {
        composerEl.hidden = true;
        inputEl.value = '';
        sendEl.disabled = true;
      }

      const place = placePopup(anchorRect, { width: window.innerWidth, height: window.innerHeight });
      popupEl.style.left = `${place.left}px`;
      popupEl.style.width = `${place.width}px`;
      popupEl.style.maxHeight = `${place.maxHeight}px`;
      popupEl.style.top = place.top === null ? '' : `${place.top}px`;
      popupEl.style.bottom = place.bottom === null ? '' : `${place.bottom}px`;

      threadEl.replaceChildren();
      answerEl = newAnswerElement();
      threadEl.append(answerEl);
      threadEl.scrollTop = 0;
      noteEl?.classList.remove('visible');
      popupEl.classList.add('visible');
      attachGlobalListeners();
    },

    appendChunk(text: string) {
      if (pendingTitle !== null) {
        // First chunk of a simpler level: it replaces the greyed answer.
        buffer = '';
        setTitle(pendingTitle);
        pendingTitle = null;
        answerEl?.classList.remove('stale');
      }
      buffer += text;
      render();
    },

    markDone() {
      clearRegenerate();
      pendingTurn = null;
      if (buffer === '' && answerEl) {
        answerEl.innerHTML = '<p class="popup-loading">No explanation was returned.</p>';
      }
    },

    showError(message: string) {
      if (!answerEl) return;
      answerEl.innerHTML = `<p class="popup-error"></p>`;
      answerEl.querySelector('p')!.textContent = message;
    },

    setSimplerButton(view: SimplerButtonView) {
      if (!simplerEl) return;
      simplerEl.hidden = !view.visible || !handlers?.onSimpler;
      simplerEl.disabled = !view.enabled;
      simplerEl.textContent = view.label;
      if (view.title) simplerEl.title = view.title;
      else simplerEl.removeAttribute('title');
    },

    setComposer(view: ComposerView) {
      if (!composerEl || !sendEl) return;
      composerEl.hidden = !view.visible || !handlers?.onAsk;
      canSend = view.canSend;
      sendEl.disabled = !view.canSend;
    },

    beginRegenerate(title: string) {
      if (!answerEl) return;
      removeErrorLine();
      previous = { buffer, title: titleEl?.textContent ?? 'Explain' };
      pendingTitle = title;
      render();
      answerEl.classList.add('stale');
    },

    failRegenerate(message: string) {
      if (!answerEl) return;
      if (previous) {
        buffer = previous.buffer;
        setTitle(previous.title);
      }
      clearRegenerate();
      render();
      // Right above the answer it is about, and scrolled to: below a long answer it would sit off
      // screen and the press would look like it did nothing.
      const line = makeErrorLine(`Couldn't simplify: ${message}`);
      answerEl.before(line);
      scrollThreadTo(line);
    },

    beginFollowUp(question: string) {
      if (!threadEl) return;
      removeErrorLine();
      sticky = true;
      if (inputEl) inputEl.value = '';
      const questionEl = document.createElement('div');
      questionEl.className = 'popup-question';
      questionEl.textContent = question;
      const nextAnswer = newAnswerElement();
      pendingTurn = { questionEl, answerEl: nextAnswer, prevAnswerEl: answerEl, prevBuffer: buffer };
      threadEl.append(questionEl, nextAnswer);
      answerEl = nextAnswer;
      buffer = '';
      scrollThreadTo(questionEl);
    },

    failFollowUp(message: string, question: string) {
      if (!threadEl) return;
      if (pendingTurn) {
        pendingTurn.questionEl.remove();
        pendingTurn.answerEl.remove();
        answerEl = pendingTurn.prevAnswerEl;
        buffer = pendingTurn.prevBuffer;
        pendingTurn = null;
      }
      const line = makeErrorLine(`Couldn't answer: ${message}`);
      threadEl.append(line);
      scrollThreadTo(line);
      if (inputEl && inputEl.value === '') inputEl.value = question;
    },

    setContextNote(text: string) {
      if (!noteEl) return;
      noteEl.textContent = text;
      noteEl.classList.toggle('visible', text.length > 0);
    },

    hostElement: () => hostEl,

    close,
  };
}
