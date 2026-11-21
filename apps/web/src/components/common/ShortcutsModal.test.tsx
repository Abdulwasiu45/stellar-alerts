import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutsModal } from './ShortcutsModal';

describe('ShortcutsModal', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('is closed by default and opens on ? keydown listener', () => {
    render(<ShortcutsModal />);

    expect(screen.queryByTestId('shortcuts-modal')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: '?' });

    expect(screen.getByTestId('shortcuts-modal')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeInTheDocument();
  });

  it('opens on Shift+/ keydown listener', () => {
    render(<ShortcutsModal />);

    expect(screen.queryByTestId('shortcuts-modal')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: '/', shiftKey: true });

    expect(screen.getByTestId('shortcuts-modal')).toBeInTheDocument();
  });

  it('does NOT open when typing ? inside an active <input> field', () => {
    render(
      <div>
        <input data-testid="search-input" />
        <ShortcutsModal />
      </div>
    );

    const input = screen.getByTestId('search-input');
    input.focus();

    fireEvent.keyDown(input, { key: '?' });

    expect(screen.queryByTestId('shortcuts-modal')).not.toBeInTheDocument();
  });

  it('does NOT open when typing ? inside an active <textarea> field', () => {
    render(
      <div>
        <textarea data-testid="search-textarea" />
        <ShortcutsModal />
      </div>
    );

    const textarea = screen.getByTestId('search-textarea');
    textarea.focus();

    fireEvent.keyDown(textarea, { key: '?' });

    expect(screen.queryByTestId('shortcuts-modal')).not.toBeInTheDocument();
  });

  it('lists global shortcuts with styled <kbd> keycap icons', () => {
    render(<ShortcutsModal isOpen={true} />);

    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Go to Wallets')).toBeInTheDocument();

    // Check for kbd elements
    const kbds = document.querySelectorAll('kbd');
    expect(kbds.length).toBeGreaterThan(0);

    const dashboardKbd = Array.from(kbds).find((k) => k.textContent === 'd');
    expect(dashboardKbd).toBeInTheDocument();
    expect(dashboardKbd?.tagName.toLowerCase()).toBe('kbd');
    expect(dashboardKbd?.className).toContain('font-mono');
  });

  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(<ShortcutsModal isOpen={true} onClose={onClose} />);

    expect(screen.getByTestId('shortcuts-modal')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when clicking the close button', () => {
    const onClose = vi.fn();
    render(<ShortcutsModal isOpen={true} onClose={onClose} />);

    const closeBtn = screen.getByRole('button', { name: 'Close shortcuts modal' });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when clicking the backdrop', () => {
    const onClose = vi.fn();
    render(<ShortcutsModal isOpen={true} onClose={onClose} />);

    const backdrop = screen.getByTestId('shortcuts-modal-backdrop');
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks body scroll when open and restores it when closed', () => {
    const { rerender } = render(<ShortcutsModal isOpen={true} />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<ShortcutsModal isOpen={false} />);
    expect(document.body.style.overflow).toBe('');
  });
});
