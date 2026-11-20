import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEditableElement, useKeyboardShortcuts } from './useKeyboardShortcuts';

describe('isEditableElement', () => {
  it('returns true for input elements', () => {
    const input = document.createElement('input');
    expect(isEditableElement(input)).toBe(true);
  });

  it('returns true for textarea elements', () => {
    const textarea = document.createElement('textarea');
    expect(isEditableElement(textarea)).toBe(true);
  });

  it('returns true for select elements', () => {
    const select = document.createElement('select');
    expect(isEditableElement(select)).toBe(true);
  });

  it('returns true for contentEditable elements', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isEditableElement(div)).toBe(true);
  });

  it('returns false for standard non-editable elements', () => {
    const div = document.createElement('div');
    const button = document.createElement('button');
    expect(isEditableElement(div)).toBe(false);
    expect(isEditableElement(button)).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens shortcuts modal when pressing ? key outside editable inputs', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useKeyboardShortcuts({ onOpen }));

    expect(result.current.isOpen).toBe(false);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '?', bubbles: true })
      );
    });

    expect(result.current.isOpen).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens shortcuts modal when pressing Shift+/ outside editable inputs', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useKeyboardShortcuts({ onOpen }));

    expect(result.current.isOpen).toBe(false);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', shiftKey: true, bubbles: true })
      );
    });

    expect(result.current.isOpen).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does NOT open modal when typing ? inside an active <input> field', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useKeyboardShortcuts({ onOpen }));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '?',
          bubbles: true,
        })
      );
    });

    expect(result.current.isOpen).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('does NOT open modal when typing ? inside an active <textarea> field', () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useKeyboardShortcuts({ onOpen }));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '?',
          bubbles: true,
        })
      );
    });

    expect(result.current.isOpen).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  it('closes modal when pressing Escape while modal is open', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useKeyboardShortcuts({ onClose }));

    // Open first
    act(() => {
      result.current.open();
    });
    expect(result.current.isOpen).toBe(true);

    // Press Escape
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });

    expect(result.current.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('triggers onNavigate when pressing g sequence shortcuts', () => {
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    // Press 'g' then 'd'
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', bubbles: true })
      );
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', bubbles: true })
      );
    });

    expect(onNavigate).toHaveBeenCalledWith('/dashboard');
  });

  it('triggers onOpenSearch when pressing / without shift', () => {
    const onOpenSearch = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onOpenSearch }));

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', shiftKey: false, bubbles: true })
      );
    });

    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });
});
