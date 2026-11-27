'use client';

import { useEffect } from 'react';

async function copyText(text: string, fallbackFrom: Element): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // An insecure address or a refused permission: select the text so the visitor can copy it by hand.
    const range = document.createRange();
    range.selectNodeContents(fallbackFrom);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return false;
  }
}

/**
 * Turns on the Copy buttons of the code blocks on the page. They are in the HTML but hidden, so without JavaScript
 * there is no button that does nothing. A copied block's button says so for a moment.
 */
export function CopyButtons() {
  useEffect(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.codeblock__copy')];
    const timers = new Map<HTMLButtonElement, number>();
    const onClick = async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const code = button.parentElement?.querySelector('pre code') ?? button.parentElement?.querySelector('pre');
      if (code === null || code === undefined) return;
      const copied = await copyText((code.textContent ?? '').replace(/\n+$/, ''), code);
      button.textContent = copied ? 'Copied' : 'Selected';
      window.clearTimeout(timers.get(button));
      timers.set(button, window.setTimeout(() => { button.textContent = 'Copy'; }, 1600));
    };
    for (const button of buttons) {
      button.hidden = false;
      button.addEventListener('click', onClick);
    }
    return () => {
      for (const button of buttons) button.removeEventListener('click', onClick);
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);
  return null;
}
