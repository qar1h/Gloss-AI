// The Shadow DOM popup: renders the streamed explanation as markdown, shows loading
// and error states, and closes on Escape or an outside click. Never touches the main
// chat page. Markdown is always sanitized (DOMPurify) before it touches innerHTML.
// The "Simpler" button (v9) lives in the header; what it shows is decided by simplerState.ts.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { SimplerButtonView } from '../simplerState';

const STYLE = `
  .popup {
    position: fixed;
    display: none;
    z-index: 2147483647;
    width: min(420px, calc(100vw - 32px));
    max-height: min(420px, calc(100vh - 32px));
    overflow-y: auto;
    background: #fff;
    color: #1a1a1a;
    border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
    font-family: system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .popup.visible { display: block; }
  .popup-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid #eee;
    font-weight: 600;
    position: sticky;
    top: 0;
    background: #fff;
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
  .popup-simpler {
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
  .popup-simpler:hover:not(:disabled) { background: #f3f3f3; }
  .popup-simpler:disabled { color: #999; border-color: #e3e3e3; cursor: default; }
  .popup-simpler[hidden] { display: none; }
  .popup-body.stale { opacity: 0.45; }
  .popup-body { padding: 12px; }
  .popup-body p:first-child { margin-top: 0; }
  .popup-body p:last-child { margin-bottom: 0; }
  .popup-note {
    display: none;
    position: sticky;
    bottom: 0;
    padding: 6px 12px;
    border-top: 1px solid #eee;
    background: #fff;
    color: #777;
    font-size: 12px;
  }
  .popup-note.visible { display: block; }
  .popup-loading { color: #666; }
  .popup-error { color: #b00020; }
`;

export interface PopupHandle {
  /** With no `onSimpler` the Simpler button is hidden (nothing to regenerate, e.g. an unreadable selection). */
  open(anchorRect: DOMRect, onClose: () => void, onSimpler?: () => void): void;
  appendChunk(text: string): void;
  markDone(): void;
  showError(message: string): void;
  setSimplerButton(view: SimplerButtonView): void;
  /**
   * A simpler level is on its way: the explanation on screen stays, greyed, until the first chunk
   * of the new one replaces it and the header becomes `title`.
   */
  beginRegenerate(title: string): void;
  /** The regenerate failed: the previous explanation and header come back, with the error line above them. */
  failRegenerate(message: string): void;
  /** The muted line under the answer saying what the explanation was based on. Empty text hides it. */
  setContextNote(text: string): void;
  close(): void;
}

export async function createPopup(ctx: ContentScriptContext): Promise<PopupHandle> {
  let popupEl: HTMLDivElement | null = null;
  let bodyEl: HTMLDivElement | null = null;
  let noteEl: HTMLDivElement | null = null;
  let titleEl: HTMLSpanElement | null = null;
  let simplerEl: HTMLButtonElement | null = null;
  let hostEl: HTMLElement | null = null;

  let buffer = '';
  let activeOnClose: (() => void) | null = null;
  let activeOnSimpler: (() => void) | null = null;
  // While a simpler level is in flight: what to restore if it fails, and the header for its first chunk.
  let previous: { buffer: string; title: string } | null = null;
  let pendingTitle: string | null = null;

  function setTitle(text: string): void {
    if (titleEl) titleEl.textContent = text;
  }

  function clearRegenerate(): void {
    previous = null;
    pendingTitle = null;
    bodyEl?.classList.remove('stale');
  }

  function render(): void {
    if (!bodyEl) return;
    const html = marked.parse(buffer, { async: false }) as string;
    bodyEl.innerHTML = DOMPurify.sanitize(html);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  function onPointerDown(event: PointerEvent): void {
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
    const callback = activeOnClose;
    activeOnClose = null;
    activeOnSimpler = null;
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
        if (!simpler.disabled) activeOnSimpler?.();
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

      const body = document.createElement('div');
      body.className = 'popup-body';

      const note = document.createElement('div');
      note.className = 'popup-note';

      popup.append(header, body, note);
      container.append(popup);

      popupEl = popup;
      bodyEl = body;
      noteEl = note;
      titleEl = title;
      simplerEl = simpler;
    },
  });
  ui.mount();

  return {
    open(anchorRect: DOMRect, onClose: () => void, onSimpler?: () => void) {
      if (!popupEl || !bodyEl) return;

      // A popup that is still open belongs to an earlier request (e.g. the Explain button was
      // activated from the keyboard, which never triggers the outside-click close). Close it
      // properly first so its onClose runs and its port disconnects.
      if (popupEl.classList.contains('visible')) close();

      buffer = '';
      activeOnClose = onClose;
      activeOnSimpler = onSimpler ?? null;
      clearRegenerate();
      setTitle('Explain');
      if (simplerEl) {
        simplerEl.hidden = true;
        simplerEl.disabled = true;
      }

      const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 40);
      const left = Math.min(anchorRect.left, window.innerWidth - 440);
      popupEl.style.top = `${Math.max(8, top)}px`;
      popupEl.style.left = `${Math.max(8, left)}px`;

      bodyEl.innerHTML = '<p class="popup-loading">Thinking…</p>';
      noteEl?.classList.remove('visible');
      popupEl.classList.add('visible');
      attachGlobalListeners();
    },

    appendChunk(text: string) {
      if (pendingTitle !== null) {
        // First chunk of a simpler level: it replaces the greyed explanation.
        buffer = '';
        setTitle(pendingTitle);
        pendingTitle = null;
        bodyEl?.classList.remove('stale');
      }
      buffer += text;
      render();
    },

    markDone() {
      clearRegenerate();
      if (buffer === '') {
        bodyEl && (bodyEl.innerHTML = '<p class="popup-loading">No explanation was returned.</p>');
      }
    },

    showError(message: string) {
      if (!bodyEl) return;
      bodyEl.innerHTML = `<p class="popup-error"></p>`;
      bodyEl.querySelector('p')!.textContent = message;
    },

    setSimplerButton(view: SimplerButtonView) {
      if (!simplerEl) return;
      simplerEl.hidden = !view.visible || !activeOnSimpler;
      simplerEl.disabled = !view.enabled;
      simplerEl.textContent = view.label;
      if (view.title) simplerEl.title = view.title;
      else simplerEl.removeAttribute('title');
    },

    beginRegenerate(title: string) {
      if (!bodyEl) return;
      previous = { buffer, title: titleEl?.textContent ?? 'Explain' };
      pendingTitle = title;
      render(); // drops the error line of an earlier failed attempt
      bodyEl.classList.add('stale');
    },

    failRegenerate(message: string) {
      if (!bodyEl) return;
      if (previous) {
        buffer = previous.buffer;
        setTitle(previous.title);
      }
      clearRegenerate();
      render();
      const line = document.createElement('p');
      line.className = 'popup-error';
      line.textContent = `Couldn't simplify: ${message}`;
      // First, and scrolled into view: at the end of a long explanation it would sit off screen and
      // the press would look like it did nothing. Scroll the popup itself, never the page.
      bodyEl.prepend(line);
      if (popupEl) popupEl.scrollTop = 0;
    },

    setContextNote(text: string) {
      if (!noteEl) return;
      noteEl.textContent = text;
      noteEl.classList.toggle('visible', text.length > 0);
    },

    close,
  };
}
