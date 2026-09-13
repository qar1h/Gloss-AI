// Shows/hides/positions the small floating "Explain" button near a selection.
// Lives in a Shadow DOM (via WXT's createShadowRootUi) so the host page's CSS can't
// distort it and it can never leak styles onto the host page either.

import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const STYLE = `
  .explain-button {
    position: fixed;
    display: none;
    z-index: 2147483647;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    padding: 6px 10px;
    border: none;
    border-radius: 999px;
    background: #1a1a1a;
    color: #fff;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .explain-button:hover {
    background: #333;
  }
  .explain-button.visible {
    display: block;
  }
`;

export interface ExplainButtonHandle {
  show(rect: DOMRect): void;
  hide(): void;
}

export async function createExplainButton(
  ctx: ContentScriptContext,
  onClick: () => void,
): Promise<ExplainButtonHandle> {
  let buttonEl: HTMLButtonElement | null = null;

  const ui = await createShadowRootUi(ctx, {
    name: 'highlight-explainer-button',
    position: 'inline',
    anchor: 'body',
    css: STYLE,
    onMount(container) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'explain-button';
      button.textContent = 'Explain';
      // Without this, the browser collapses the page's text selection on mousedown
      // (because the button sits outside the selected range), which would wipe the
      // selection before the click handler below ever runs.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
      container.append(button);
      buttonEl = button;
    },
  });
  ui.mount();

  return {
    show(rect: DOMRect) {
      if (!buttonEl) return;
      buttonEl.style.top = `${rect.bottom + 6}px`;
      buttonEl.style.left = `${rect.left}px`;
      buttonEl.classList.add('visible');
    },
    hide() {
      buttonEl?.classList.remove('visible');
    },
  };
}
