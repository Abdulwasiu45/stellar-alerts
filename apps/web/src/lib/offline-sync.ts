/**
 * Offline-First PWA Synchronization Engine
 * Uses IndexedDB to cache the last 500 alerts/payments and queue offline rule edits.
 * Coordinates with Service Worker BackgroundSync for automatic sync on reconnection.
 */

export interface CachedAlert {
  id: string;
  txHash?: string;
  walletId?: string;
  amount: number | string;
  asset: string;
  fromAddress?: string;
  memo?: string | null;
  severity?: 'info' | 'warning' | 'critical';
  title?: string;
  message?: string;
  receivedAt: string | Date;
  syncedAt?: number;
}

export interface QueuedRuleMutation {
  id: string;
  action: 'create' | 'update' | 'delete';
  ruleData: Record<string, any>;
  createdAt: number;
  retries: number;
  synced: boolean;
}

export interface SyncMetadata {
  key: string;
  lastSyncTimestamp: number;
  count: number;
}

const DB_NAME = 'stellar_pwa_offline_store';
const DB_VERSION = 1;
const MAX_CACHED_ALERTS = 500;

export const STORES = {
  ALERTS: 'cached_alerts',
  QUEUED_RULES: 'queued_rules',
  METADATA: 'sync_metadata',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openOfflineDatabase(): Promise<IDBDatabase> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('IndexedDB is only available in browser environments'));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Alerts store (caches up to 500 alerts)
      if (!db.objectStoreNames.contains(STORES.ALERTS)) {
        const alertStore = db.createObjectStore(STORES.ALERTS, { keyPath: 'id' });
        alertStore.createIndex('receivedAt', 'receivedAt', { unique: false });
        alertStore.createIndex('syncedAt', 'syncedAt', { unique: false });
      }

      // Queued rules store (for offline edits/creations)
      if (!db.objectStoreNames.contains(STORES.QUEUED_RULES)) {
        const ruleStore = db.createObjectStore(STORES.QUEUED_RULES, { keyPath: 'id' });
        ruleStore.createIndex('createdAt', 'createdAt', { unique: false });
        ruleStore.createIndex('synced', 'synced', { unique: false });
      }

      // Metadata store
      if (!db.objectStoreNames.contains(STORES.METADATA)) {
        db.createObjectStore(STORES.METADATA, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

export class OfflineSyncManager {
  private static instance: OfflineSyncManager | null = null;
  private isSyncing = false;
  private listeners: Set<() => void> = new Set();

  private constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.synchronizeOfflineQueue();
      });
    }
  }

  public static getInstance(): OfflineSyncManager {
    if (!OfflineSyncManager.instance) {
      OfflineSyncManager.instance = new OfflineSyncManager();
    }
    return OfflineSyncManager.instance;
  }

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((cb) => cb());
  }

  /**
   * Cache received alerts in IndexedDB (keeping max 500 entries)
   */
  public async cacheAlerts(alerts: CachedAlert[]): Promise<void> {
    try {
      const db = await openOfflineDatabase();
      const tx = db.transaction([STORES.ALERTS, STORES.METADATA], 'readwrite');
      const alertStore = tx.objectStore(STORES.ALERTS);
      const metaStore = tx.objectStore(STORES.METADATA);

      const now = Date.now();
      for (const alert of alerts) {
        alertStore.put({
          ...alert,
          syncedAt: now,
        });
      }

      // Record last sync timestamp
      metaStore.put({
        key: 'last_cached_sync',
        lastSyncTimestamp: now,
        count: alerts.length,
      });

      // Enforce the 500 items quota
      const countReq = alertStore.count();
      countReq.onsuccess = () => {
        if (countReq.result > MAX_CACHED_ALERTS) {
          const excess = countReq.result - MAX_CACHED_ALERTS;
          const index = alertStore.index('receivedAt');
          const cursorReq = index.openCursor();
          let deleted = 0;
          cursorReq.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor && deleted < excess) {
              cursor.delete();
              deleted++;
              cursor.continue();
            }
          };
        }
      };

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      this.notifyListeners();
    } catch (err) {
      console.warn('[OfflineSyncManager] Could not cache alerts to IndexedDB:', err);
    }
  }

  /**
   * Retrieve cached alerts from IndexedDB for immediate offline viewing
   */
  public async getCachedAlerts(): Promise<CachedAlert[]> {
    try {
      const db = await openOfflineDatabase();
      const tx = db.transaction(STORES.ALERTS, 'readonly');
      const store = tx.objectStore(STORES.ALERTS);

      return new Promise<CachedAlert[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const results = (req.result || []) as CachedAlert[];
          // Sort descending by receivedAt
          results.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
          resolve(results.slice(0, MAX_CACHED_ALERTS));
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  /**
   * Queue a new rule or rule edit created while offline
   */
  public async queueOfflineRule(
    ruleData: Record<string, any>,
    action: 'create' | 'update' | 'delete' = 'create'
  ): Promise<string> {
    const queueId = `rule-queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mutation: QueuedRuleMutation = {
      id: queueId,
      action,
      ruleData,
      createdAt: Date.now(),
      retries: 0,
      synced: false,
    };

    try {
      const db = await openOfflineDatabase();
      const tx = db.transaction(STORES.QUEUED_RULES, 'readwrite');
      tx.objectStore(STORES.QUEUED_RULES).put(mutation);

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // Attempt to register BackgroundSync if supported
      await this.registerBackgroundSync('sync-rules');
      this.notifyListeners();

      // If already online, trigger sync immediately
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        void this.synchronizeOfflineQueue();
      }

      return queueId;
    } catch (err) {
      console.error('[OfflineSyncManager] Error queueing offline rule:', err);
      return queueId;
    }
  }

  /**
   * Get all queued offline rules
   */
  public async getQueuedRules(): Promise<QueuedRuleMutation[]> {
    try {
      const db = await openOfflineDatabase();
      const tx = db.transaction(STORES.QUEUED_RULES, 'readonly');
      const store = tx.objectStore(STORES.QUEUED_RULES);

      return new Promise<QueuedRuleMutation[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result || []) as QueuedRuleMutation[]);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  /**
   * Synchronize queued rules with the API automatically upon reconnection
   */
  public async synchronizeOfflineQueue(apiBaseUrl = ''): Promise<{ synced: number; failed: number }> {
    if (this.isSyncing) return { synced: 0, failed: 0 };
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { synced: 0, failed: 0 };
    }

    this.isSyncing = true;
    let synced = 0;
    let failed = 0;

    try {
      const queuedRules = await this.getQueuedRules();
      if (queuedRules.length === 0) return { synced: 0, failed: 0 };

      const db = await openOfflineDatabase();

      for (const rule of queuedRules) {
        try {
          const endpoint = rule.action === 'create' ? '/api/rules' : `/api/rules/${rule.ruleData.id || ''}`;
          const method = rule.action === 'create' ? 'POST' : rule.action === 'delete' ? 'DELETE' : 'PUT';

          const res = await fetch(`${apiBaseUrl}${endpoint}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: rule.action === 'delete' ? undefined : JSON.stringify(rule.ruleData),
          });

          if (res.ok) {
            // Remove from queue
            const tx = db.transaction(STORES.QUEUED_RULES, 'readwrite');
            tx.objectStore(STORES.QUEUED_RULES).delete(rule.id);
            await new Promise<void>((resTx) => {
              tx.oncomplete = () => resTx();
            });
            synced++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      this.notifyListeners();
    } finally {
      this.isSyncing = false;
    }

    return { synced, failed };
  }

  /**
   * Get timestamp of last cached sync
   */
  public async getLastSyncTimestamp(): Promise<Date | null> {
    try {
      const db = await openOfflineDatabase();
      const tx = db.transaction(STORES.METADATA, 'readonly');
      const store = tx.objectStore(STORES.METADATA);

      return new Promise<Date | null>((resolve) => {
        const req = store.get('last_cached_sync');
        req.onsuccess = () => {
          if (req.result && req.result.lastSyncTimestamp) {
            resolve(new Date(req.result.lastSyncTimestamp));
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Register Service Worker BackgroundSync
   */
  public async registerBackgroundSync(tag = 'sync-rules'): Promise<void> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    try {
      const registration = await navigator.serviceWorker.ready;
      if ('sync' in registration) {
        await (registration as any).sync.register(tag);
        console.log(`[OfflineSyncManager] Registered background sync tag: ${tag}`);
      }
    } catch (err) {
      console.warn('[OfflineSyncManager] Background sync registration skipped:', err);
    }
  }
}

export const offlineSyncManager = OfflineSyncManager.getInstance();
