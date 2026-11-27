import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLoaded } from '../../../../src/features/agency/drawers/library/useLoaded.js';

describe('useLoaded', () => {
  it('shows loading for a new key, keeps the value through a version reload, and takes set()', async () => {
    let answer = 'a1';
    const { result, rerender } = renderHook(({ key, version }) => useLoaded(async () => answer, key, version), { initialProps: { key: 'a', version: 0 } });
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', value: 'a1' }));

    answer = 'a2';
    rerender({ key: 'a', version: 1 });
    expect(result.current.state).toEqual({ kind: 'ready', value: 'a1' });
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', value: 'a2' }));

    answer = 'b1';
    rerender({ key: 'b', version: 1 });
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', value: 'b1' }));

    act(() => result.current.set('b2'));
    expect(result.current.state).toEqual({ kind: 'ready', value: 'b2' });
  });

  it('drops an answer for an older key and reports a failure', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('old'), 30));
    const { result, rerender } = renderHook(({ key }) => useLoaded(async () => (key === 'old' ? slow : Promise.reject(new Error('no'))), key), { initialProps: { key: 'old' } });
    rerender({ key: 'new' });
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(result.current.state.kind).toBe('failed');
  });
});
