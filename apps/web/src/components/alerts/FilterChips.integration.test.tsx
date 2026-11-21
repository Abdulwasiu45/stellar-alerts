import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PaymentDTO, WalletDTO } from '@stellar-alerts/shared';
import { FilterChips } from './FilterChips';
import { useTagFilters } from '@/hooks/useTagFilters';

const wallets: WalletDTO[] = [
  {
    id: 'wallet-treasury',
    userId: 'user-1',
    publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOP',
    label: 'Treasury',
    tags: ['treasury'],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'wallet-lp',
    userId: 'user-1',
    publicKey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQ',
    label: 'LP',
    tags: ['lp'],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

const payments: PaymentDTO[] = [
  {
    id: 'payment-treasury',
    walletId: 'wallet-treasury',
    txHash: 'hash-1',
    fromAddress: 'GSENDER000000000000000000000000000000000000000000000',
    amount: 100,
    asset: 'XLM',
    receivedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'payment-lp',
    walletId: 'wallet-lp',
    txHash: 'hash-2',
    fromAddress: 'GSENDER000000000000000000000000000000000000000000000',
    amount: 200,
    asset: 'XLM',
    receivedAt: '2026-01-03T00:00:00.000Z',
  },
];

function AlertFeedHarness() {
  const { selectedTags, filterTags, visiblePayments, toggleTag, clearTags } = useTagFilters(
    wallets,
    payments,
  );

  return (
    <div>
      <FilterChips
        tags={filterTags}
        selectedTags={selectedTags}
        onToggle={toggleTag}
        onClear={clearTags}
      />
      <ul>
        {visiblePayments.map((payment) => (
          <li key={payment.id}>{payment.id}</li>
        ))}
      </ul>
    </div>
  );
}

describe('wallet tag filter chips integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/dashboard');
  });

  it('toggles URL query parameters and filters the rendered alert list', () => {
    render(<AlertFeedHarness />);

    expect(screen.getByTestId('filter-chip-count-treasury')).toHaveTextContent('1');
    expect(screen.getByTestId('filter-chip-count-lp')).toHaveTextContent('1');
    expect(screen.getByText('payment-treasury')).toBeInTheDocument();
    expect(screen.getByText('payment-lp')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('filter-chip-treasury'));

    expect(window.location.search).toBe('?tags=treasury');
    expect(screen.getByTestId('filter-chip-treasury')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('payment-treasury')).toBeInTheDocument();
    expect(screen.queryByText('payment-lp')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('filter-chip-lp'));

    expect(window.location.search).toBe('?tags=treasury,lp');
    expect(screen.getByText('payment-treasury')).toBeInTheDocument();
    expect(screen.getByText('payment-lp')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('filter-chip-treasury'));

    expect(window.location.search).toBe('?tags=lp');
    expect(screen.queryByText('payment-treasury')).not.toBeInTheDocument();
    expect(screen.getByText('payment-lp')).toBeInTheDocument();
  });

  it('clears all selected tags from the URL', () => {
    render(<AlertFeedHarness />);

    fireEvent.click(screen.getByTestId('filter-chip-treasury'));
    fireEvent.click(screen.getByTestId('filter-chip-clear'));

    expect(window.location.search).toBe('');
    expect(screen.getByText('payment-treasury')).toBeInTheDocument();
    expect(screen.getByText('payment-lp')).toBeInTheDocument();
  });
});
