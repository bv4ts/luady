import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/markdown/Markdown.js';

describe('Markdown', () => {
  it('renders sanitized HTML inside a prose block with automatic text direction', () => {
    const { container } = render(<Markdown source={'مرحبا **Alex** <img src=x onerror=alert(1)>'} />);
    const block = container.querySelector('.prose');
    expect(block?.getAttribute('dir')).toBe('auto');
    expect(block?.querySelector('strong')?.textContent).toBe('Alex');
    expect(block?.querySelector('img')).toBeNull();
    expect(block?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
