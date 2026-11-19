'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  offlineSyncManager,
  CachedAlert,
  QueuedRuleMutation,
} from '@/lib/offline-sync';

export interface UseAlertsQueryOptions {
  apiUrl?: string;
  autoRefreshIntervalMs?: number;
}

export interface UseAlertsQueryResult {
  alerts: CachedAlert[];
  isLoading: boolean;
  isOffline: boolean;
  lastSyncTime: Date | null;
  pendingRulesCount: number;
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  refetch: () => Promise<void>;
  createRuleOffline: (ruleData: Record<string, any>) => Promise<string>;
  triggerSync: () => Promise<void>;
  OfflineIndicatorPill: React.FC<{ className?: string }>;
}

export function useAlertsQuery(options: UseAlertsQueryOptions = {}): UseAlertsQueryResult {
  const { apiUrl = '/api/payments', autoRefreshIntervalMs = 15000 } = options;

  const [alerts, setAlerts] = useState<CachedAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(() => {
    if (typeof navigator !== 'undefined') return !navigator.onLine;
    return false;
  });
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [pendingRulesCount, setPendingRulesCount] = useState(0);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');

  // Load queued rules count
  const refreshPendingCount = useCallback(async () => {
    try {
      const queued = await offlineSyncManager.getQueuedRules();
      setPendingRulesCount(queued.length);
    } catch {
      setPendingRulesCount(0);
    }
  }, []);

  // Fetch or load from cache
  const fetchAlerts = useCallback(async () => {
    setIsLoading(true);
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    setIsOffline(!online);

    if (!online) {
      // Offline: read from IndexedDB
      try {
        const cached = await offlineSyncManager.getCachedAlerts();
        setAlerts(cached);
        const lastSync = await offlineSyncManager.getLastSyncTimestamp();
        setLastSyncTime(lastSync);
      } catch (err) {
        console.warn('[useAlertsQuery] Failed to read cached alerts:', err);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Online: attempt network query
    try {
      setSyncStatus('syncing');
      const res = await fetch(apiUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const incomingAlerts: CachedAlert[] = (Array.isArray(data) ? data : data.items || data.payments || []).map(
          (item: any, idx: number) => ({
            id: item.id || `alert-${idx}`,
            txHash: item.txHash,
            walletId: item.walletId,
            amount: item.amount || 0,
            asset: item.asset || 'XLM',
            fromAddress: item.fromAddress || item.sender,
            memo: item.memo,
            severity: item.severity || 'info',
            title: item.title || 'Payment Received',
            receivedAt: item.receivedAt || new Date().toISOString(),
          })
        );

        setAlerts(incomingAlerts);
        await offlineSyncManager.cacheAlerts(incomingAlerts);
        const now = new Date();
        setLastSyncTime(now);
        setSyncStatus('synced');
      } else {
        throw new Error(`Server returned ${res.status}`);
      }
    } catch (err) {
      // Fallback seamlessly to IndexedDB cache
      console.warn('[useAlertsQuery] Network query failed, falling back to IndexedDB cache:', err);
      try {
        const cached = await offlineSyncManager.getCachedAlerts();
        setAlerts(cached);
        const lastSync = await offlineSyncManager.getLastSyncTimestamp();
        setLastSyncTime(lastSync);
        setSyncStatus('idle');
      } catch {
        setSyncStatus('error');
      }
    } finally {
      setIsLoading(false);
      await refreshPendingCount();
    }
  }, [apiUrl, refreshPendingCount]);

  // Synchronize queued items
  const triggerSync = useCallback(async () => {
    setSyncStatus('syncing');
    try {
      await offlineSyncManager.synchronizeOfflineQueue();
      await fetchAlerts();
      await refreshPendingCount();
      setSyncStatus('synced');
    } catch {
      setSyncStatus('error');
    }
  }, [fetchAlerts, refreshPendingCount]);

  // Queue rule offline
  const createRuleOffline = useCallback(
    async (ruleData: Record<string, any>): Promise<string> => {
      const id = await offlineSyncManager.queueOfflineRule(ruleData, 'create');
      await refreshPendingCount();
      return id;
    },
    [refreshPendingCount]
  );

  useEffect(() => {
    void fetchAlerts();

    const handleOnline = () => {
      setIsOffline(false);
      void triggerSync();
    };

    const handleOffline = () => {
      setIsOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsubscribe = offlineSyncManager.subscribe(() => {
      void refreshPendingCount();
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubscribe();
    };
  }, [fetchAlerts, triggerSync, refreshPendingCount]);

  // Offline indicator pill component
  const OfflineIndicatorPill = useMemo(() => {
    return function Pill({ className = '' }: { className?: string }) {
      const formattedTime = lastSyncTime
        ? lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'Never';

      return (
        <div
          data-testid="offline-sync-pill"
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium backdrop-blur-md border transition-all ${
            isOffline
              ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
              : 'bg-emerald-950/30 border-emerald-500/30 text-emerald-300'
          } ${className}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isOffline ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
            }`}
          />
          <span>
            {isOffline ? 'Offline' : 'Online'} • Cached {formattedTime}
          </span>
          {pendingRulesCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-md bg-white/10 text-[10px] font-mono text-white">
              {pendingRulesCount} queued
            </span>
          )}
        </div>
      );
    };
  }, [isOffline, lastSyncTime, pendingRulesCount]);

  return {
    alerts,
    isLoading,
    isOffline,
    lastSyncTime,
    pendingRulesCount,
    syncStatus,
    refetch: fetchAlerts,
    createRuleOffline,
    triggerSync,
    OfflineIndicatorPill,
  };
}
