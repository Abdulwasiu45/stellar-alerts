import React from 'react';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { VirtualPaymentGrid, sortPayments } from './VirtualPaymentGrid';
import type { PaymentDTO } from '@stellar-alerts/shared';

// jsdom has no real layout engine: every element reports a 0x0
// getBoundingClientRect and 0 clientHeight, so @tanstack/react-virtual's
// "which rows are in the viewport" math always comes out empty and no row
// ever mounts. Stubbing a nonzero viewport height is the standard way to
// test a virtualized list under jsdom (its own test suite does the same).
const STUBBED_VIEWPORT_HEIGHT = 480;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return STUBBED_VIEWPORT_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 800;
    },
  });
});

afterAll(() => {
  delete (HTMLElement.prototype as any).clientHeight;
  delete (HTMLElement.prototype as any).clientWidth;
});

function payment(overrides: Partial<PaymentDTO> = {}): PaymentDTO {
  return {
    id: 'pay-1',
    walletId: 'wallet-1',
    txHash: 'tx-1',
    fromAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    amount: '100',
    asset: 'XLM',
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sortPayments', () => {
  const payments = [
    payment({ id: 'a', amount: '300', asset: 'USDC', fromAddress: 'GCCC', receivedAt: '2026-01-03T00:00:00.000Z' }),
    payment({ id: 'b', amount: '100', asset: 'ABC', fromAddress: 'GAAA', receivedAt: '2026-01-01T00:00:00.000Z' }),
    payment({ id: 'c', amount: '200', asset: 'XLM', fromAddress: 'GBBB', receivedAt: '2026-01-02T00:00:00.000Z' }),
  ];

  it('returns the original order when no column is given', () => {
    expect(sortPayments(payments, null, 'asc').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by receivedAt ascending and descending', () => {
    expect(sortPayments(payments, 'receivedAt', 'asc').map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(sortPayments(payments, 'receivedAt', 'desc').map((p) => p.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by amount numerically, not lexicographically', () => {
    expect(sortPayments(payments, 'amount', 'asc').map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by asset alphabetically', () => {
    // ABC (b) < USDC (a) < XLM (c)
    expect(sortPayments(payments, 'asset', 'asc').map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by fromAddress alphabetically', () => {
    expect(sortPayments(payments, 'fromAddress', 'asc').map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const copy = [...payments];
    sortPayments(payments, 'amount', 'asc');
    expect(payments).toEqual(copy);
  });
});

describe('VirtualPaymentGrid', () => {
  it('renders an empty state when there are no payments', () => {
    render(<VirtualPaymentGrid payments={[]} />);
    expect(screen.getByText('No payments to display.')).toBeInTheDocument();
  });

  it('renders the column headers', () => {
    render(<VirtualPaymentGrid payments={[payment()]} />);
    expect(screen.getByText('Timestamp')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Asset')).toBeInTheDocument();
    expect(screen.getByText('Address')).toBeInTheDocument();
  });

  it('renders at least the first row for a small dataset', () => {
    render(<VirtualPaymentGrid payments={[payment({ asset: 'XLM' })]} />);
    // jsdom has no real layout, so the virtualizer can only guarantee rows
    // within its initial estimate are mounted; a single-row dataset must
    // always be within that estimate regardless of the (zeroed) viewport.
    expect(screen.getByText('XLM')).toBeInTheDocument();
  });

  it('shows the total record count', () => {
    render(<VirtualPaymentGrid payments={[payment({ id: 'a' }), payment({ id: 'b' })]} />);
    expect(screen.getByText('2 records')).toBeInTheDocument();
  });

  it('shows the singular form for exactly one record', () => {
    render(<VirtualPaymentGrid payments={[payment()]} />);
    expect(screen.getByText('1 record')).toBeInTheDocument();
  });

  it('toggles sort direction on repeated header clicks and updates aria-sort', () => {
    render(<VirtualPaymentGrid payments={[payment({ id: 'a', amount: '1' }), payment({ id: 'b', amount: '2' })]} />);
    const amountHeader = screen.getByRole('button', { name: /Amount/ });

    expect(amountHeader).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(amountHeader);
    expect(amountHeader).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(amountHeader);
    expect(amountHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('resets another column to ascending when switching sort columns', () => {
    render(<VirtualPaymentGrid payments={[payment()]} />);
    const amountHeader = screen.getByRole('button', { name: /Amount/ });
    const assetHeader = screen.getByRole('button', { name: /Asset/ });

    fireEvent.click(amountHeader);
    fireEvent.click(amountHeader);
    expect(amountHeader).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(assetHeader);
    expect(assetHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(amountHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('truncates a long sender address and exposes the full address via title', () => {
    const longAddress = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    render(<VirtualPaymentGrid payments={[payment({ fromAddress: longAddress })]} />);

    const grid = screen.getByTestId('virtual-payment-grid');
    const cell = within(grid).getByTitle(longAddress);
    expect(cell.textContent).not.toBe(longAddress);
    expect(cell.textContent?.length).toBeLessThan(longAddress.length);
  });

  it('accepts a custom viewport height', () => {
    render(<VirtualPaymentGrid payments={[payment()]} height={200} />);
    const viewport = screen.getByTestId('virtual-payment-grid-viewport');
    expect(viewport).toHaveStyle({ height: '200px' });
  });

  // Acceptance criteria: "Component benchmark test measuring render time
  // for 10,000 mock payment items." The whole point of virtualizing is
  // that render cost stays roughly constant regardless of dataset size,
  // since only the rows in (plus overscan around) the viewport actually
  // mount as real DOM nodes.
  describe('performance', () => {
    it('renders a 10,000-row dataset quickly', () => {
      const payments: PaymentDTO[] = Array.from({ length: 10_000 }, (_, i) =>
        payment({
          id: `p${i}`,
          fromAddress: `GACCOUNT${i % 500}`,
          amount: String((i % 97) * 13.37),
          asset: i % 2 ? 'XLM' : 'USDC',
          receivedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        }),
      );

      const start = performance.now();
      render(<VirtualPaymentGrid payments={payments} />);
      const elapsed = performance.now() - start;

      expect(screen.getByText('10,000 records')).toBeInTheDocument();
      expect(elapsed).toBeLessThan(500);
    });

    it('mounts a bounded number of row DOM nodes regardless of dataset size', () => {
      const payments: PaymentDTO[] = Array.from({ length: 10_000 }, (_, i) =>
        payment({ id: `p${i}`, fromAddress: `G${i}` }),
      );

      render(<VirtualPaymentGrid payments={payments} rowHeight={44} height={480} />);

      // ~480px viewport / 44px rows ≈ 11 rows visible, plus overscan (10 on
      // each side per the virtualizer config) — nowhere close to 10,000.
      const rows = screen.getAllByRole('row').filter((el) => el.hasAttribute('data-index'));
      expect(rows.length).toBeLessThan(100);
    });
  });
});
