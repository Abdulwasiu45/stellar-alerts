import { PaymentDTO } from './types.js';

export interface DashboardSocketMessage {
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface DashboardSocketHandlers {
  onPayment: (payment: PaymentDTO) => void;
  onStatusChange: (status: 'connected' | 'disconnected' | 'connecting') => void;
  onError?: (error: Error) => void;
}

/** Converts the ws/wss scheme to match the API's http/https base URL. */
function toWebSocketUrl(baseUrl: string, apiKey: string | undefined): string {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (apiKey) url.searchParams.set('token', apiKey);
  return url.toString();
}

function isPaymentDTO(value: unknown): value is PaymentDTO {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PaymentDTO).id === 'string' &&
    typeof (value as PaymentDTO).fromAddress === 'string'
  );
}

/**
 * Opens the authenticated realtime WebSocket (apps/api/src/plugins/websocket.ts,
 * registry.register per userId) and forwards `payment`-typed messages. Used
 * by `stellar-alerts top` for its live feed and TPS sparkline; reconnects
 * with a fixed delay on close/error rather than resilient-stream.ts's
 * exponential backoff, since a dashboard that briefly shows "disconnected"
 * and retries every few seconds is an acceptable degraded mode, unlike the
 * payment-ingestion stream resilient-stream.ts backs, where backoff matters
 * for not hammering the server.
 */
export function connectDashboardSocket(
  baseUrl: string,
  apiKey: string | undefined,
  handlers: DashboardSocketHandlers,
  options: { reconnectDelayMs?: number; WebSocketImpl?: typeof WebSocket } = {},
): { close: () => void } {
  const reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  const WS = options.WebSocketImpl ?? WebSocket;
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (closed) return;
    handlers.onStatusChange('connecting');

    socket = new WS(toWebSocketUrl(baseUrl, apiKey));

    socket.addEventListener('open', () => {
      handlers.onStatusChange('connected');
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        const message = JSON.parse(data) as DashboardSocketMessage;
        if (message.type === 'payment' && isPaymentDTO(message.payload)) {
          handlers.onPayment(message.payload);
        }
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.addEventListener('close', () => {
      handlers.onStatusChange('disconnected');
      if (!closed) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs);
      }
    });

    socket.addEventListener('error', () => {
      handlers.onError?.(new Error('WebSocket connection error'));
    });
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
