'use client';

import React from 'react';

export interface FilterTag {
  id: string;
  label?: string;
  count: number;
  color?: string;
}

export interface FilterChipsProps {
  tags: FilterTag[];
  selectedTags: string[];
  onToggle: (tagId: string) => void;
  onClear?: () => void;
  className?: string;
}

export function FilterChips({
  tags,
  selectedTags,
  onToggle,
  onClear,
  className,
}: FilterChipsProps) {
  return (
    <div className={className} aria-label="Filter alerts by wallet tag">
      <div className="flex flex-wrap items-center gap-2">
        {tags.map((tag) => {
          const isSelected = selectedTags.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              data-testid={`filter-chip-${tag.id}`}
              aria-pressed={isSelected}
              onClick={() => onToggle(tag.id)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                isSelected
                  ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200'
                  : 'bg-slate-900/60 border-slate-700 text-slate-300 hover:border-slate-500'
              }`}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: tag.color ?? '#22d3ee' }}
              />
              {tag.label ?? tag.id}
              <span
                data-testid={`filter-chip-count-${tag.id}`}
                className="rounded-full bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-300"
              >
                {tag.count}
              </span>
            </button>
          );
        })}

        {selectedTags.length > 0 && onClear ? (
          <button
            type="button"
            data-testid="filter-chip-clear"
            onClick={onClear}
            className="text-xs font-medium text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {selectedTags.length} tag filters selected
      </p>
    </div>
  );
}

export default FilterChips;
