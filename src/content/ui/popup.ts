// The Shadow DOM popup: renders the streamed explanation as markdown, shows loading
// and error states, and closes on Escape or an outside click. Never touches the main
// chat page. Markdown is always sanitized (DOMPurify) before it touches innerHTML.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

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
  .popup-body { padding: 12px; }
  .popup-body p:first-child { margin-top: 0; }
  .popup-body p:last-child { margin-bottom: 0; }
  .popup-loading { color: #666; }
  .popup-error { color: #b00020; }
`;

export interface PopupHandle {
  open(anchorRect: DOMRect, onClose: () => void): void;
  appendChunk(text: string): void;
  markDone(): void;
  showError(message: string): void;
  close(): void;
}

export async function createPopup(ctx: ContentScriptContext): Promise<PopupHandle> {
  let popupEl: HTMLDivElement | null = null;
  let bodyEl: HTMLDivElement | null = null;
  let hostEl: HTMLElement | null = null;

  let buffer = '';
  let activeOnClose: (() => void) | null = null;

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
      header.textContent = 'Explain';

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'popup-close';
      closeButton.setAttribute('aria-label', 'Close');
      closeButton.textContent = '×';
      closeButton.addEventListener('click', () => close());
      header.append(closeButton);

      const body = document.createElement('div');
      body.className = 'popup-body';

      popup.append(header, body);
      container.append(popup);

      popupEl = popup;
      bodyEl = body;
    },
  });
  ui.mount();

  return {
    open(anchorRect: DOMRect, onClose: () => void) {
      if (!popupEl || !bodyEl) return;

      buffer = '';
      activeOnClose = onClose;

      const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 40);
      const left = Math.min(anchorRect.left, window.innerWidth - 440);
      popupEl.style.top = `${Math.max(8, top)}px`;
      popupEl.style.left = `${Math.max(8, left)}px`;

      bodyEl.innerHTML = '<p class="popup-loading">Thinking…</p>';
      popupEl.classList.add('visible');
      attachGlobalListeners();
    },

    appendChunk(text: string) {
      buffer += text;
      render();
    },

    markDone() {
      if (buffer === '') {
        bodyEl && (bodyEl.innerHTML = '<p class="popup-loading">No explanation was returned.</p>');
      }
    },

    showError(message: string) {
      if (!bodyEl) return;
      bodyEl.innerHTML = `<p class="popup-error"></p>`;
      bodyEl.querySelector('p')!.textContent = message;
    },

    close,
  };
}
