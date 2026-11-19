"use client";

/**
 * React hook for subscribing to the SSE payment push stream (Issue #64).
 * Uses the native EventSource API with automatic exponential-backoff reconnect.
 */
import { useEffect, useCallback, useRef, useState } from "react";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ??
  "http://localhost:3001";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Window event dispatched (e.g. by OfflineBanner) to force an SSE reconnect. */
export const SSE_RECONNECT_EVENT = "sse:reconnect";

export interface PaymentEvent {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  assetIssuer: string | null;
  fromAddress: string;
  receivedAt: string;
}

export interface SorobanDecodedTopic {
  symbol: string;
  type: string;
  value: unknown;
  xdrBase64?: string;
}

export interface SorobanEvent {
  id: string;
  contractId: string;
  ledgerSeq: number;
  createdAt: string;
  eventType: "contract" | "system" | "diagnostic";
  topics: SorobanDecodedTopic[];
  dataXdr: string;
  decodedData: Record<string, unknown>;
  txHash: string;
}

function useEventSourceStream<T>(
  url: string,
  eventName: string,
  onEvent: (data: T) => void,
  parseErrorLabel: string,
) {
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const unmountedRef = useRef(false);

  // Keep the callback ref current so we don't need to re-subscribe when it changes
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const connectRef = useRef<() => void>(() => {});

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (unmountedRef.current || typeof EventSource === "undefined") return;
    clearReconnectTimer();

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", () => {
      setConnected(true);
      // Reset backoff on successful connection
      reconnectDelayRef.current = RECONNECT_BASE_MS;
    });

    es.addEventListener(eventName, (event: MessageEvent) => {
      try {
        const data: T = JSON.parse(event.data);
        onEventRef.current(data);
      } catch (err) {
        console.warn(`[SSE] Failed to parse ${parseErrorLabel}:`, err);
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnected(false);

      if (unmountedRef.current) return;

      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);

      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRef.current();
      }, delay);
    };
  }, [clearReconnectTimer, eventName, parseErrorLabel, url]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Reconnect immediately when the offline banner requests it
  useEffect(() => {
    const handler = () => {
      if (unmountedRef.current || esRef.current) return;
      reconnectDelayRef.current = RECONNECT_BASE_MS;
      connectRef.current();
    };
    window.addEventListener(SSE_RECONNECT_EVENT, handler);
    return () => window.removeEventListener(SSE_RECONNECT_EVENT, handler);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      clearReconnectTimer();
      esRef.current?.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [clearReconnectTimer, connect]);

  return { connected };
}

/**
 * Subscribes to real-time payment events from the Fastify SSE endpoint.
 *
 * @param onPayment  Callback invoked with each incoming payment event payload.
 *
 * Usage:
 *   const { connected } = usePaymentStream((payment) => {
 *     console.log('New payment:', payment);
 *   });
 */
export function usePaymentStream(onPayment: (data: PaymentEvent) => void) {
  return useEventSourceStream<PaymentEvent>(
    `${API_URL}/events`,
    "payment",
    onPayment,
    "payment event",
  );
}

/**
 * Subscribes to real-time Soroban contract events from the SSE endpoint.
 *
 * @param onSorobanEvent  Callback invoked with each incoming Soroban event payload.
 * @param contractFilter  Optional contract ID filter to subscribe only to specific contracts.
 *
 * Usage:
 *   const { connected } = useSorobanEventStream((event) => {
 *     console.log('New Soroban event:', event);
 *   }, 'CCONTRACT...');
 */
export function useSorobanEventStream(
  onSorobanEvent: (data: SorobanEvent) => void,
  contractFilter?: string,
) {
  const url = contractFilter
    ? `${API_URL}/events?contract=${encodeURIComponent(contractFilter)}`
    : `${API_URL}/events`;

  return useEventSourceStream<SorobanEvent>(
    url,
    "soroban",
    onSorobanEvent,
    "Soroban event",
  );
}
