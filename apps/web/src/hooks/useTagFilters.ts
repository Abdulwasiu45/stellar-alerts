'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PaymentDTO, WalletDTO } from '@stellar-alerts/shared';
import type { FilterTag } from '@/components/alerts/FilterChips';
import {
  collectTags,
  countPaymentsByTag,
  filterPaymentsByTags,
  getWalletColor,
  getWalletTags,
  normalizeTag,
  parseTagsParam,
} from '@/lib/wallet-tags';

export interface TagFilters {
  selectedTags: string[];
  filterTags: FilterTag[];
  visiblePayments: PaymentDTO[];
  toggleTag: (tagId: string) => void;
  clearTags: () => void;
}

export function useTagFilters(wallets: WalletDTO[], payments: PaymentDTO[]): TagFilters {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    const syncFromUrl = () => {
      setSelectedTags(parseTagsParam(new URLSearchParams(window.location.search).get('tags')));
    };

    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  const applyTagSelection = useCallback((tags: string[]) => {
    const normalized = Array.from(new Set(tags.map(normalizeTag))).filter(Boolean);
    setSelectedTags(normalized);

    const url = new URL(window.location.href);
    if (normalized.length > 0) {
      url.searchParams.set('tags', normalized.join(','));
    } else {
      url.searchParams.delete('tags');
    }
    window.history.pushState(null, '', url);
  }, []);

  const toggleTag = useCallback(
    (tagId: string) => {
      applyTagSelection(
        selectedTags.includes(tagId)
          ? selectedTags.filter((tag) => tag !== tagId)
          : [...selectedTags, tagId],
      );
    },
    [applyTagSelection, selectedTags],
  );

  const clearTags = useCallback(() => applyTagSelection([]), [applyTagSelection]);

  const tagCounts = useMemo(() => countPaymentsByTag(payments, wallets), [payments, wallets]);

  const filterTags = useMemo<FilterTag[]>(
    () =>
      collectTags(wallets).map((tag) => {
        const taggedWallet = wallets.find((wallet) => getWalletTags(wallet).includes(tag));
        return {
          id: tag,
          count: tagCounts.get(tag) ?? 0,
          color: taggedWallet ? getWalletColor(taggedWallet) : undefined,
        };
      }),
    [wallets, tagCounts],
  );

  const visiblePayments = useMemo(
    () => filterPaymentsByTags(payments, wallets, selectedTags),
    [payments, wallets, selectedTags],
  );

  return { selectedTags, filterTags, visiblePayments, toggleTag, clearTags };
}
