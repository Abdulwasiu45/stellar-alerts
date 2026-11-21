import { describe, expect, it, vi } from 'vitest';
import { connectDashboardSocket } from './dashboard-socket.js';

type Listener = (event: any) => void;

/** Minimal fake matching the subset of the WebSocket interface this module uses. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  listeners: Record<string, Listener[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event: any = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

function resetFake() {
  FakeWebSocket.instances = [];
}

describe('connectDashboardSocket (#944)', () => {
  it('builds a ws:// URL from an http base URL with the token as a query param', () => {
    resetFake();
    connectDashboardSocket('http://localhost:3001', 'secret', {
      onPayment: vi.fn(),
      onStatusChange: vi.fn(),
    }, { WebSocketImpl: FakeWebSocket as any });

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:3001/ws?token=secret');
  });

  it('builds a wss:// URL from an https base URL', () => {
    resetFake();
    connectDashboardSocket('https://api.example.com', undefined, {
      onPayment: vi.fn(),
      onStatusChange: vi.fn(),
    }, { WebSocketImpl: FakeWebSocket as any });

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('wss://api.example.com/ws');
  });

  it('reports connecting then connected, and forwards payment messages', () => {
    resetFake();
    const onPayment = vi.fn();
    const onStatusChange = vi.fn();

    connectDashboardSocket('http://localhost:3001', 'secret', { onPayment, onStatusChange }, {
      WebSocketImpl: FakeWebSocket as any,
    });

    expect(onStatusChange).toHaveBeenCalledWith('connecting');

    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    expect(onStatusChange).toHaveBeenCalledWith('connected');

    socket.emit('message', {
      data: JSON.stringify({
        type: 'payment',
        payload: { id: 'p1', fromAddress: 'GABC', amount: '10', asset: 'XLM', walletId: 'w1', txHash: 'tx1', receivedAt: new Date().toISOString() },
        timestamp: new Date().toISOString(),
      }),
    });

    expect(onPayment).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('ignores non-payment message types', () => {
    resetFake();
    const onPayment = vi.fn();
    connectDashboardSocket('http://localhost:3001', undefined, { onPayment, onStatusChange: vi.fn() }, {
      WebSocketImpl: FakeWebSocket as any,
    });

    const socket = FakeWebSocket.instances[0];
    socket.emit('message', {
      data: JSON.stringify({ type: 'connection', payload: { status: 'connected' }, timestamp: new Date().toISOString() }),
    });

    expect(onPayment).not.toHaveBeenCalled();
  });

  it('calls onError instead of throwing on a malformed message', () => {
    resetFake();
    const onError = vi.fn();
    connectDashboardSocket('http://localhost:3001', undefined, {
      onPayment: vi.fn(),
      onStatusChange: vi.fn(),
      onError,
    }, { WebSocketImpl: FakeWebSocket as any });

    const socket = FakeWebSocket.instances[0];
    socket.emit('message', { data: 'not json' });

    expect(onError).toHaveBeenCalled();
  });

  it('reconnects after close with a fresh socket', () => {
    resetFake();
    vi.useFakeTimers();
    const onStatusChange = vi.fn();

    connectDashboardSocket('http://localhost:3001', undefined, { onPayment: vi.fn(), onStatusChange }, {
      WebSocketImpl: FakeWebSocket as any,
      reconnectDelayMs: 1000,
    });

    const first = FakeWebSocket.instances[0];
    first.emit('close');
    expect(onStatusChange).toHaveBeenCalledWith('disconnected');

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    vi.useRealTimers();
  });

  it('does not reconnect after close() is called explicitly', () => {
    resetFake();
    vi.useFakeTimers();

    const connection = connectDashboardSocket('http://localhost:3001', undefined, {
      onPayment: vi.fn(),
      onStatusChange: vi.fn(),
    }, { WebSocketImpl: FakeWebSocket as any, reconnectDelayMs: 1000 });

    connection.close();
    const first = FakeWebSocket.instances[0];
    expect(first.closed).toBe(true);

    first.emit('close');
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.useRealTimers();
  });
});
