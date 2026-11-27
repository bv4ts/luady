import { render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { OpenModal } from '../../../src/features/agency/OpenModal.js';
import { INITIAL_UI, reduceAgencyUi } from '../../../src/features/agency/model/ui-state.js';

// A pop-up whose code cannot load: after a deploy an open tab asks for a chunk the server no longer has.
vi.mock('../../../src/features/agency/drawers/help/HelpModal.js', () => ({
  HelpModal: () => {
    throw new TypeError('Failed to fetch dynamically imported module: /assets/HelpModal-old.js');
  },
}));

function Harness() {
  const [ui, dispatch] = useReducer(reduceAgencyUi, { ...INITIAL_UI, modal: { kind: 'help' } });
  return (
    <div>
      <p data-testid="office">The office</p>
      <OpenModal ui={ui} dispatch={dispatch} />
    </div>
  );
}

describe('a pop-up that cannot open', () => {
  it('says so inside its own frame and offers a reload; the office around it keeps working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Harness />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not open/);
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(screen.getByTestId('office').textContent).toBe('The office');
    expect(screen.getByRole('dialog', { name: 'Help' })).toBeTruthy();
  });
});
