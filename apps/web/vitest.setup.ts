import '@testing-library/jest-dom/vitest';

// Newer Node releases can disable jsdom's localStorage without a storage file.
// Keep browser storage available to component tests that exercise persistence.
if (typeof window !== 'undefined' && !window.localStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

// jsdom doesn't implement scrollIntoView; components that call it (e.g.
// CommandPalette's keyboard-nav auto-scroll) would otherwise throw in tests.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom doesn't always expose navigator.clipboard; provide a mockable stub so
// clipboard copy tests using vi.spyOn(navigator.clipboard, 'writeText') work.
if (typeof navigator !== 'undefined' && !navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async () => {},
      readText: async () => '',
    },
  });
}
