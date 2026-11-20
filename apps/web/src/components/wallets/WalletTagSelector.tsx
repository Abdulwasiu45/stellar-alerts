'use client';

import React, { useEffect, useState } from 'react';
import type { WalletDTO } from '@stellar-alerts/shared';
import { getWalletColor, getWalletTags, normalizeTag } from '@/lib/wallet-tags';

const TAG_COLORS = [
  { label: 'Cyan', value: '#22d3ee' },
  { label: 'Emerald', value: '#34d399' },
  { label: 'Amber', value: '#fbbf24' },
  { label: 'Rose', value: '#fb7185' },
  { label: 'Violet', value: '#a78bfa' },
];

export interface WalletTagSelectorProps {
  wallet: WalletDTO;
  availableTags?: string[];
  onSave: (walletId: string, tags: string[], colorHex: string) => Promise<void> | void;
  className?: string;
}

export function WalletTagSelector({
  wallet,
  availableTags = [],
  onSave,
  className,
}: WalletTagSelectorProps) {
  const [tags, setTags] = useState<string[]>(() => getWalletTags(wallet));
  const [colorHex, setColorHex] = useState<string>(() => getWalletColor(wallet) ?? TAG_COLORS[0].value);
  const [draftTag, setDraftTag] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTags(getWalletTags(wallet));
    setColorHex(getWalletColor(wallet) ?? TAG_COLORS[0].value);
    setDraftTag('');
    setError(null);
  }, [wallet.id, wallet.tags, wallet.colorHex]);

  const suggestions = Array.from(
    new Set([...availableTags.map(normalizeTag), ...tags]).filter((tag) => tag.length > 0),
  )
    .filter((tag) => !tags.includes(tag))
    .slice(0, 6);

  function addTag(value: string) {
    const normalized = normalizeTag(value);
    if (!normalized || tags.includes(normalized)) return;
    setTags((prev) => [...prev, normalized]);
    setDraftTag('');
  }

  async function handleSave() {
    try {
      setIsSaving(true);
      setError(null);
      await onSave(wallet.id, tags, colorHex);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save wallet tags');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className={className}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Tags for ${wallet.label || wallet.publicKey}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
            style={{ borderColor: colorHex, color: colorHex }}
          >
            {tag}
            <button
              type="button"
              onClick={() => setTags((prev) => prev.filter((value) => value !== tag))}
              aria-label={`Remove ${tag} tag`}
              className="text-slate-400 hover:text-slate-100"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={draftTag}
          onChange={(event) => setDraftTag(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addTag(draftTag);
            }
          }}
          placeholder="Add tag"
          aria-label="Add wallet tag"
          className="w-24 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
        />
        <button
          type="button"
          onClick={() => addTag(draftTag)}
          disabled={!normalizeTag(draftTag)}
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-40"
        >
          Add
        </button>
        <select
          value={colorHex}
          onChange={(event) => setColorHex(event.target.value)}
          aria-label="Wallet tag color"
          className="rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
        >
          {TAG_COLORS.map((color) => (
            <option key={color.value} value={color.value}>
              {color.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="rounded-md bg-cyan-600/20 px-2 py-1 text-xs font-semibold text-cyan-200 disabled:opacity-40"
        >
          {isSaving ? 'Saving…' : 'Save tags'}
        </button>
      </div>

      {suggestions.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => addTag(tag)}
              className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
            >
              + {tag}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 text-xs text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default WalletTagSelector;
