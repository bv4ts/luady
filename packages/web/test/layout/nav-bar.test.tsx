import { managerName, setManagerName } from '@luady/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { NavBar } from '../../src/layout/NavBar.js';

const DEFAULT_NAME = managerName();

afterEach(() => {
  setManagerName(DEFAULT_NAME);
});

describe('NavBar', () => {
  it('names the manager by the display name the settings set, not the one at start', () => {
    setManagerName('Ada');
    render(<MemoryRouter><NavBar pending={0} connection="open" /></MemoryRouter>);
    expect(screen.getByTestId('nav-manager').textContent).toBe('Ada');
  });
});
