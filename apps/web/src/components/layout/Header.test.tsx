import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Header } from './Header';

vi.mock('next/link', () => ({
  default: ({
    children,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
  }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

describe('Header', () => {
  it('renders branding and navigation links', () => {
    render(<Header />);

    expect(screen.getByText('Stellar')).toBeInTheDocument();
    expect(screen.getByText('Alerts')).toBeInTheDocument();
    expect(screen.getByTestId('nav-dashboard')).toBeInTheDocument();
  });

  it('triggers onOpenCommandPalette when clicking search button', () => {
    const onOpenCommandPalette = vi.fn();
    render(<Header onOpenCommandPalette={onOpenCommandPalette} />);

    fireEvent.click(screen.getByRole('button', { name: 'Search commands' }));
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('opens ShortcutsModal when clicking the shortcuts trigger button', () => {
    render(<Header />);

    expect(screen.queryByTestId('shortcuts-modal')).not.toBeInTheDocument();

    const shortcutsTrigger = screen.getByTestId('shortcuts-modal-trigger');
    fireEvent.click(shortcutsTrigger);

    expect(screen.getByTestId('shortcuts-modal')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeInTheDocument();
  });

  it('triggers onOpenMobileNav when clicking mobile nav button', () => {
    const onOpenMobileNav = vi.fn();
    render(<Header onOpenMobileNav={onOpenMobileNav} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    expect(onOpenMobileNav).toHaveBeenCalledTimes(1);
  });
});
