import DOMPurify, { type Config } from 'dompurify';
import { Marked, type Tokens } from 'marked';

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Raw HTML is never rendered: block and inline HTML tokens come out as escaped text. */
const markdown = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      const safe = escapeHtml(token.text);
      return token.block ? `<p>${safe}</p>` : safe;
    },
    image(token: Tokens.Image) {
      return escapeHtml(token.text || token.href);
    },
    checkbox(token: Tokens.Checkbox) {
      return token.checked ? '☑ ' : '☐ ';
    },
  },
});

const purifier = DOMPurify(window);
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input',
    'button', 'select', 'textarea', 'svg', 'math'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
  ALLOW_DATA_ATTR: false,
} satisfies Config;

export function renderMarkdown(source: string): string {
  return purifier.sanitize(markdown.parse(source, { async: false }), PURIFY_CONFIG);
}
