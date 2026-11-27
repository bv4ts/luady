import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../../src/markdown/render.js';

function toDom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

function dangerousAttributes(root: Element): string[] {
  return [...root.querySelectorAll('*')]
    .flatMap((element) => [...element.attributes].map((attr) => `${attr.name}=${attr.value}`))
    .filter((entry) => /^on/i.test(entry) || /(javascript|data|vbscript):/i.test(entry));
}

describe('renderMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const dom = toDom(renderMarkdown('**Done.** Ran `npm test`\n\n- one\n- two'));
    expect(dom.querySelector('strong')?.textContent).toBe('Done.');
    expect(dom.querySelector('code')?.textContent).toBe('npm test');
    expect(dom.querySelectorAll('li')).toHaveLength(2);
  });

  it('escapes raw HTML into visible text instead of rendering it', () => {
    const dom = toDom(renderMarkdown('Hello <b>bold</b>\n\n<div onclick="steal()">block</div>'));
    expect(dom.querySelector('b')).toBeNull();
    expect(dom.querySelector('div')).toBeNull();
    expect(dom.textContent).toContain('<b>bold</b>');
    expect(dom.textContent).toContain('<div onclick="steal()">block</div>');
  });

  it('strips script tags, event handlers and javascript: URLs', () => {
    const payload = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(2)>',
      '[click me](javascript:alert(3))',
      '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCg0KTwvc2NyaXB0Pg==)',
      '![tracker](https://evil.example/pixel.png)',
      '<a href="javascript:alert(5)">raw link</a>',
    ].join('\n\n');
    const dom = toDom(renderMarkdown(payload));
    expect(dom.querySelector('script, img, iframe, object, embed, form, svg')).toBeNull();
    expect(dangerousAttributes(dom)).toEqual([]);
    expect(dom.textContent).toContain('<script>alert(1)</script>');
    expect(dom.textContent).toContain('click me');
    expect(dom.textContent).toContain('tracker');
  });

  it('opens safe links in a new tab without a referrer', () => {
    const link = toDom(renderMarkdown('[docs](https://example.com/docs)')).querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('keeps code blocks as escaped text and drops class attributes', () => {
    const dom = toDom(renderMarkdown('```html\n<script>x()</script>\n```'));
    const code = dom.querySelector('pre code');
    expect(code?.textContent).toContain('<script>x()</script>');
    expect(code?.hasAttribute('class')).toBe(false);
    expect(dom.querySelector('script')).toBeNull();
  });

  it('renders task lists as text glyphs', () => {
    const dom = toDom(renderMarkdown('- [x] tests pass\n- [ ] deploy'));
    expect(dom.textContent).toContain('☑ tests pass');
    expect(dom.textContent).toContain('☐ deploy');
    expect(dom.querySelector('input')).toBeNull();
  });

  it('escapeHtml escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
