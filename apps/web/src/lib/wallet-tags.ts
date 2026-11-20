import type { PaymentDTO, WalletDTO } from '@stellar-alerts/shared';

export interface TaggedWallet {
  id: string;
  tags?: string[];
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

export function getWalletTags(wallet: TaggedWallet): string[] {
  return Array.isArray(wallet.tags)
    ? wallet.tags.map(normalizeTag).filter((tag) => tag.length > 0)
    : [];
}

export function getWalletColor(wallet: WalletDTO): string | undefined {
  const metadata = (wallet as WalletDTO & { metadata?: { colorHex?: string } }).metadata;
  return wallet.colorHex ?? metadata?.colorHex ?? undefined;
}

export function parseTagsParam(value: string | null | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(',')
        .map(normalizeTag)
        .filter((tag) => tag.length > 0),
    ),
  );
}

export function serializeTagsParam(tags: string[]): string {
  return Array.from(new Set(tags.map(normalizeTag).filter(Boolean))).join(',');
}

export function collectTags(wallets: TaggedWallet[]): string[] {
  const tags = new Set<string>();
  for (const wallet of wallets) {
    for (const tag of getWalletTags(wallet)) tags.add(tag);
  }
  return Array.from(tags).sort();
}

export function filterPaymentsByTags(
  payments: PaymentDTO[],
  wallets: TaggedWallet[],
  selectedTags: string[],
): PaymentDTO[] {
  const normalizedSelected = selectedTags.map(normalizeTag).filter(Boolean);
  if (normalizedSelected.length === 0) return payments;

  const tagsByWallet = new Map(wallets.map((wallet) => [wallet.id, getWalletTags(wallet)]));
  return payments.filter((payment) => {
    const tags = tagsByWallet.get(payment.walletId) ?? [];
    return normalizedSelected.some((tag) => tags.includes(tag));
  });
}

export function countPaymentsByTag(
  payments: PaymentDTO[],
  wallets: TaggedWallet[],
): Map<string, number> {
  const tagsByWallet = new Map(wallets.map((wallet) => [wallet.id, getWalletTags(wallet)]));
  const counts = new Map<string, number>();

  for (const payment of payments) {
    for (const tag of tagsByWallet.get(payment.walletId) ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return counts;
}
