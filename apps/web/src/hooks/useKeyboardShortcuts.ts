'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }
  return Boolean(
    target.isContentEditable === true ||
    target.contentEditable === 'true' ||
    target.getAttribute('contenteditable') === 'true'
  );
}

export interface ShortcutItem {
  keys: string[];
  description: string;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  shortcuts: ShortcutItem[];
}

export const GLOBAL_SHORTCUTS: ShortcutGroup[] = [
  {
    id: 'navigation',
    title: 'Navigation',
    shortcuts: [
      { keys: ['g', 'd'], description: 'Go to Dashboard' },
      { keys: ['g', 'w'], description: 'Go to Wallets' },
      { keys: ['g', 'r'], description: 'Go to Rule Builder' },
      { keys: ['g', 'i'], description: 'Go to Incident Triage' },
      { keys: ['g', 's'], description: 'Go to Settings' },
      { keys: ['g', 'o'], description: 'Go to Onboarding' },
    ],
  },
  {
    id: 'search',
    title: 'Search & Commands',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Open Command Palette' },
      { keys: ['/'], description: 'Quick search' },
    ],
  },
  {
    id: 'general',
    title: 'General',
    shortcuts: [
      { keys: ['?'], description: 'Open Keyboard Shortcuts' },
      { keys: ['Esc'], description: 'Close Modal or Dialog' },
    ],
  },
];

export interface UseKeyboardShortcutsOptions {
  isOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onToggle?: () => void;
  onNavigate?: (path: string) => void;
  onOpenSearch?: () => void;
  disabled?: boolean;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  const {
    isOpen: controlledOpen,
    onOpen,
    onClose,
    onToggle,
    onNavigate,
    onOpenSearch,
    disabled = false,
  } = options;

  const [internalOpen, setInternalOpen] = useState(false);
  const pendingPrefixRef = useRef<string | null>(null);
  const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const open = useCallback(() => {
    if (!isControlled) setInternalOpen(true);
    onOpen?.();
  }, [isControlled, onOpen]);

  const close = useCallback(() => {
    if (!isControlled) setInternalOpen(false);
    onClose?.();
  }, [isControlled, onClose]);

  const toggle = useCallback(() => {
    if (!isControlled) setInternalOpen((prev) => !prev);
    onToggle?.();
  }, [isControlled, onToggle]);

  useEffect(() => {
    if (disabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      // 1. Never trigger shortcuts if typing inside an editable element
      if (isEditableElement(event.target)) {
        return;
      }

      // 2. Escape closes the modal if it's currently open
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        close();
        return;
      }

      // 3. Question mark (?) or Shift+/ toggles the shortcuts modal
      const isQuestionMark =
        event.key === '?' ||
        (event.key === '/' && event.shiftKey) ||
        (event.code === 'Slash' && event.shiftKey);

      if (isQuestionMark && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (isOpen) {
          close();
        } else {
          open();
        }
        return;
      }

      // If modal is open, do not execute other navigation hotkeys
      if (isOpen) return;

      // 4. Quick search hotkey: / (without shift)
      if (event.key === '/' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (onOpenSearch) {
          event.preventDefault();
          onOpenSearch();
          return;
        }
      }

      // 5. Two-key sequence navigation: 'g' then <key>
      const key = event.key.toLowerCase();
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (pendingPrefixRef.current === 'g') {
          pendingPrefixRef.current = null;
          if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);

          if (key === 'd') {
            event.preventDefault();
            onNavigate?.('/dashboard');
          } else if (key === 'w') {
            event.preventDefault();
            onNavigate?.('/dashboard');
          } else if (key === 'r') {
            event.preventDefault();
            onNavigate?.('/dashboard/rules/new');
          } else if (key === 'i') {
            event.preventDefault();
            onNavigate?.('/dashboard/triage/INC-84920');
          } else if (key === 's') {
            event.preventDefault();
            onNavigate?.('/settings');
          } else if (key === 'o') {
            event.preventDefault();
            onNavigate?.('/onboarding');
          }
          return;
        }

        if (key === 'g') {
          pendingPrefixRef.current = 'g';
          if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);
          prefixTimerRef.current = setTimeout(() => {
            pendingPrefixRef.current = null;
          }, 1200);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (prefixTimerRef.current) clearTimeout(prefixTimerRef.current);
    };
  }, [disabled, isOpen, open, close, onNavigate, onOpenSearch]);

  return {
    isOpen,
    open,
    close,
    toggle,
    setIsOpen: setInternalOpen,
  };
}
