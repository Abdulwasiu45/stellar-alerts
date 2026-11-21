'use client';

import React, { useEffect, useRef } from 'react';
import {
  GLOBAL_SHORTCUTS,
  ShortcutGroup,
  useKeyboardShortcuts,
} from '@/hooks/useKeyboardShortcuts';

export interface ShortcutsModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
  shortcuts?: ShortcutGroup[];
}

export const Keycap: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-[11px] font-mono font-semibold text-gray-200 bg-slate-800/90 border border-slate-700/80 rounded shadow-[inset_0_-1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.5)]">
      {children}
    </kbd>
  );
};

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({
  isOpen: controlledOpen,
  onClose,
  onOpen,
  shortcuts = GLOBAL_SHORTCUTS,
}) => {
  const { isOpen, close } = useKeyboardShortcuts({
    isOpen: controlledOpen,
    onClose,
    onOpen,
  });

  const dialogRef = useRef<HTMLDivElement>(null);

  // Lock background scroll when open
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6"
      data-testid="shortcuts-modal-container"
    >
      {/* Accessible Backdrop */}
      <div
        className="fixed inset-0 bg-[#030308]/80 backdrop-blur-md transition-opacity"
        onClick={close}
        aria-hidden="true"
        data-testid="shortcuts-modal-backdrop"
      />

      {/* Accessible Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-modal-title"
        data-testid="shortcuts-modal"
        className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#0c0c16]/95 shadow-[0_0_60px_rgba(6,182,212,0.15)] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                />
              </svg>
            </div>
            <div>
              <h2
                id="shortcuts-modal-title"
                className="text-base font-semibold text-white tracking-tight"
              >
                Keyboard Shortcuts
              </h2>
              <p className="text-xs text-gray-400">
                Quick hotkeys for fast dashboard navigation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close shortcuts modal"
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Shortcuts list grouped by category */}
        <div className="max-h-[60vh] overflow-y-auto p-5 space-y-6">
          {shortcuts.map((group) => (
            <div key={group.id} className="space-y-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-400/90 px-1">
                {group.title}
              </h3>
              <div className="grid gap-2">
                {group.shortcuts.map((sc, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors"
                  >
                    <span className="text-xs text-gray-300 font-medium">{sc.description}</span>
                    <div className="flex items-center gap-1.5">
                      {sc.keys.map((k, kIdx) => (
                        <Keycap key={kIdx}>{k}</Keycap>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 bg-white/[0.02] px-5 py-3 flex items-center justify-between text-xs text-gray-400">
          <span className="flex items-center gap-1">
            Press <Keycap>?</Keycap> anytime to toggle
          </span>
          <span className="flex items-center gap-1">
            Press <Keycap>Esc</Keycap> to close
          </span>
        </div>
      </div>
    </div>
  );
};
